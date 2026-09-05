#!/usr/bin/env node

/**
 * Import content from a CSV using a declarative field mapping.
 *
 * The mapping file decides how CSV columns become Drupal fields, so the same
 * script serves any CSV shape and any content type. See examples/mappings/ for
 * worked examples.
 *
 * Runs as a DRY RUN by default: it prints the fields it would submit and
 * creates nothing. Pass --execute to create the nodes.
 *
 * Usage:
 *   node examples/import-csv.js --csv roster.csv --map examples/mappings/ps-events-symposium.json
 *   node examples/import-csv.js --csv roster.csv --map <spec> --unpublished --limit 1 --execute
 *   node examples/import-csv.js --csv roster.csv --map <spec> --unpublished --skip 1 --execute
 *
 * Mapping overrides can be supplied inline, which is handy for one-off runs:
 *   --set 'subtitle={Talk Title|TBD}'
 *   --set 'field_room={Room}'
 *
 * Options:
 *   --csv <path>       CSV to import (required)
 *   --map <path>       Mapping JSON (required unless every field comes from --set)
 *   --type <name>      Content type, overriding the mapping's contentType
 *   --set <f=tmpl>     Add or override one mapped field (repeatable)
 *   --execute          Create the nodes (default is a dry run)
 *   --unpublished      Create nodes unpublished
 *   --published        Create nodes published
 *   --limit <n>        Only process the first n rows (useful for a canary)
 *   --skip <n>         Skip the first n rows (resume after a partial run)
 *   --delay <ms>       Delay between creations (default: 2000)
 *   --report <path>    Write a JSON report of the run
 *   --api <url>        API base URL (default: $API_BASE or http://localhost:$BSP_API_PORT)
 *
 * Prerequisites:
 *   1. Docker container running: docker-compose up -d
 *   2. Authenticated session saved via /login/interactive + /login/save
 */

const fs = require('fs');
const path = require('path');

const { parseCSV } = require('../src/csv');
const { validateMapping, requiredColumns, applyMapping } = require('../src/fieldMapping');
const { DEFAULT_API_BASE, postJSON, ensureAuthenticated, sleep } = require('../src/apiClient');

const DEFAULT_DELAY_MS = 2000;
const PUBLISHED_FIELD = 'status';

// --- argument parsing ---

function parseArgs(argv) {
  const options = {
    csv: null,
    map: null,
    contentType: null,
    overrides: {},
    apiBase: DEFAULT_API_BASE,
    execute: false,
    published: null, // null = leave to the mapping / Drupal default
    limit: null,
    skip: 0,
    delayMs: DEFAULT_DELAY_MS,
    report: null,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case '--csv': options.csv = next(); break;
      case '--map': options.map = next(); break;
      case '--type': options.contentType = next(); break;
      case '--set': {
        const pair = next();
        const eq = pair.indexOf('=');
        if (eq < 1) throw new Error(`--set expects field=template, got "${pair}"`);
        options.overrides[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
        break;
      }
      case '--api': options.apiBase = next().replace(/\/$/, ''); break;
      case '--execute': options.execute = true; break;
      case '--dry-run': options.execute = false; break;
      case '--unpublished': options.published = false; break;
      case '--published': options.published = true; break;
      case '--limit':
        options.limit = parseInt(next(), 10);
        if (!Number.isInteger(options.limit) || options.limit < 1) {
          throw new Error('--limit must be a positive integer');
        }
        break;
      case '--skip':
        options.skip = parseInt(next(), 10);
        if (!Number.isInteger(options.skip) || options.skip < 0) {
          throw new Error('--skip must be >= 0');
        }
        break;
      case '--delay':
        options.delayMs = parseInt(next(), 10);
        if (!Number.isInteger(options.delayMs) || options.delayMs < 0) {
          throw new Error('--delay must be >= 0');
        }
        break;
      case '--report': options.report = next(); break;
      case '--help':
      case '-h': options.help = true; break;
      default:
        if (!arg.startsWith('--')) { options.csv = arg; break; }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Merge a mapping file with CLI overrides and the published flag.
 */
function buildMapping(options) {
  let mapping = { fields: {} };

  if (options.map) {
    mapping = JSON.parse(fs.readFileSync(path.resolve(options.map), 'utf-8'));
    mapping.fields = { ...mapping.fields };
  }

  Object.entries(options.overrides).forEach(([field, template]) => {
    mapping.fields[field] = template;
  });

  if (options.published !== null) {
    mapping.fields[PUBLISHED_FIELD] = { value: options.published };
  }

  if (options.contentType) {
    mapping.contentType = options.contentType;
  }

  validateMapping(mapping);

  if (!mapping.contentType) {
    throw new Error('No content type given - set "contentType" in the mapping or pass --type');
  }

  return mapping;
}

/**
 * Report CSV columns the mapping expects but the file does not provide.
 */
function findMissingColumns(mapping, headers) {
  const present = new Set(headers);
  return requiredColumns(mapping).filter(column => !present.has(column));
}

async function createNode(apiBase, contentType, fields) {
  const { body } = await postJSON(apiBase, '/content', { contentType, fields });

  if (!body.success) {
    return { success: false, error: body.error || 'unknown error' };
  }

  // A create that silently skipped fields is not a success worth recording
  const skipped = body.skippedFields || [];
  if (skipped.length > 0) {
    return {
      success: false,
      nodeId: body.nodeId,
      error: `Fields skipped: ${skipped.map(f => `${f.field}: ${f.reason}`).join('; ')}`
    };
  }

  return { success: true, nodeId: body.nodeId };
}

// --- main ---

const USAGE = `Import content from a CSV using a declarative field mapping.

Usage:
  node examples/import-csv.js --csv <path> --map <mapping.json> [--unpublished] [--execute]

Options:
  --csv <path>      CSV to import (required)
  --map <path>      Mapping JSON (see examples/mappings/)
  --type <name>     Content type, overriding the mapping's contentType
  --set <f=tmpl>    Add or override one mapped field (repeatable)
  --execute         Create the nodes (default is a dry run)
  --unpublished     Create nodes unpublished
  --published       Create nodes published
  --limit <n>       Only process the first n rows (canary)
  --skip <n>        Skip the first n rows (resume a partial run)
  --delay <ms>      Delay between creations (default: ${DEFAULT_DELAY_MS})
  --report <path>   Write a JSON report of the run
  --api <url>       API base URL (default: ${DEFAULT_API_BASE})
  -h, --help        Show this help`;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  if (options.help) { console.log(USAGE); return; }

  if (!options.csv) throw new Error('--csv is required');

  const csvPath = path.resolve(options.csv);
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const mapping = buildMapping(options);
  const { headers, rows } = parseCSV(fs.readFileSync(csvPath, 'utf-8'));

  const missing = findMissingColumns(mapping, headers);
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing column(s) the mapping needs: ${missing.join(', ')}. ` +
      `Present: ${headers.join(', ')}`
    );
  }

  let selected = rows.slice(options.skip);
  if (options.limit !== null) selected = selected.slice(0, options.limit);

  console.log('Import CSV');
  console.log('==========');
  console.log(`API:     ${options.apiBase}`);
  console.log(`CSV:     ${csvPath}`);
  console.log(`Mapping: ${options.map || '(from --set only)'}`);
  console.log(`Type:    ${mapping.contentType}`);
  console.log(`Mode:    ${options.execute ? 'EXECUTE (nodes will be created)' : 'DRY RUN (nothing created)'}`);
  if (options.published !== null) {
    console.log(`Status:  ${options.published ? 'Published' : 'Unpublished'}`);
  }
  console.log(`Rows:    ${selected.length} of ${rows.length}${options.skip ? ` (skipping ${options.skip})` : ''}`);
  console.log('');

  if (selected.length === 0) { console.log('Nothing to do.'); return; }

  // Build every field map up front so a bad row fails before anything is created
  const prepared = [];
  for (let i = 0; i < selected.length; i++) {
    try {
      prepared.push({ row: selected[i], fields: applyMapping(selected[i], mapping) });
    } catch (error) {
      throw new Error(`Row ${options.skip + i + 1} is invalid: ${error.message}`);
    }
  }

  console.log('Example of what will be submitted:');
  console.log(JSON.stringify(prepared[0].fields, null, 2));
  console.log('');

  const results = { created: [], failed: [] };

  if (!options.execute) {
    console.log('Rows to create:');
    prepared.forEach((entry, i) => {
      const summary = Object.entries(entry.fields)
        .filter(([, value]) => typeof value === 'string' && value)
        .slice(0, 3)
        .map(([, value]) => value)
        .join('  ');
      console.log(`  ${String(i + 1).padStart(3)}. ${summary}`);
    });
    console.log('');
    console.log(`Dry run complete - nothing created. Re-run with --execute to create ${prepared.length} node(s).`);
  } else {
    await ensureAuthenticated(options.apiBase);
    console.log('Session authenticated.\n');

    for (let i = 0; i < prepared.length; i++) {
      const { fields } = prepared[i];
      const label = fields.title || `row ${i + 1}`;
      process.stdout.write(`[${i + 1}/${prepared.length}] ${label} ... `);

      try {
        const result = await createNode(options.apiBase, mapping.contentType, fields);
        if (result.success) {
          console.log(`created node/${result.nodeId}`);
          results.created.push({ nodeId: result.nodeId, fields });
        } else {
          console.log(`FAILED (${result.error})`);
          results.failed.push({ label, error: result.error });
        }
      } catch (error) {
        console.log(`FAILED (${error.message})`);
        results.failed.push({ label, error: error.message });
      }

      if (options.delayMs > 0 && i < prepared.length - 1) {
        await sleep(options.delayMs);
      }
    }

    console.log('');
    console.log(`Created: ${results.created.length}`);
    console.log(`Failed:  ${results.failed.length}`);
    results.failed.forEach(failure => console.log(`  ${failure.label}: ${failure.error}`));
  }

  if (options.report) {
    fs.writeFileSync(options.report, JSON.stringify({
      generatedAt: new Date().toISOString(),
      apiBase: options.apiBase,
      csv: csvPath,
      mapping: options.map,
      contentType: mapping.contentType,
      mode: options.execute ? 'execute' : 'dry-run',
      published: options.published,
      rowsSelected: selected.length,
      created: results.created,
      failed: results.failed
    }, null, 2));
    console.log(`\nReport written to ${options.report}`);
  }

  if (results.failed.length > 0) process.exit(1);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildMapping, findMissingColumns, createNode };
