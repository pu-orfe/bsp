#!/usr/bin/env node

/**
 * Export site content to CSV.
 *
 * Pages through the admin content listing and writes a CSV. Listing columns are
 * free; node field values can be pulled in too, at the cost of one page load per
 * node, by naming the Drupal form fields you want.
 *
 * Usage:
 *   # Everything the listing knows about
 *   node examples/export-csv.js --out content.csv
 *
 *   # Only published events
 *   node examples/export-csv.js --out events.csv --type Event --status Published
 *
 *   # Pull node fields in as named columns (slower: one request per node)
 *   node examples/export-csv.js --out roster.csv --type Event \
 *     --field 'title[0][value]=Name' \
 *     --field 'field_ps_events_subtitle[0][value]=Talk Title' \
 *     --field 'field_ps_events_date[0][value][date]=Date'
 *
 * Options:
 *   --out <path>       Where to write the CSV (default: stdout)
 *   --type <name>      Only rows whose content type matches (case-insensitive)
 *   --status <name>    Only rows whose status matches, e.g. Published
 *   --columns <list>   Listing columns to include
 *                      (default: id,title,type,status,author,updated,created)
 *   --field <f=Col>    Also export a node form field as column "Col" (repeatable)
 *   --limit <n>        Stop after n matching rows
 *   --page-size <n>    Rows per listing request (default: 50, max 100)
 *   --api <url>        API base URL (default: $API_BASE or http://localhost:$BSP_API_PORT)
 */

const fs = require('fs');

const { formatCSV } = require('../src/csv');
const { DEFAULT_API_BASE, getJSON, ensureAuthenticated } = require('../src/apiClient');

const DEFAULT_COLUMNS = ['id', 'title', 'type', 'status', 'author', 'updated', 'created'];
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 200;

function parseArgs(argv) {
  const options = {
    out: null,
    type: null,
    status: null,
    columns: [...DEFAULT_COLUMNS],
    fields: [],
    limit: null,
    pageSize: DEFAULT_PAGE_SIZE,
    apiBase: DEFAULT_API_BASE,
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
      case '--out': options.out = next(); break;
      case '--type': options.type = next(); break;
      case '--status': options.status = next(); break;
      case '--columns':
        options.columns = next().split(',').map(column => column.trim()).filter(Boolean);
        if (options.columns.length === 0) throw new Error('--columns requires at least one column');
        break;
      case '--field': {
        const pair = next();
        const eq = pair.indexOf('=');
        if (eq < 1) throw new Error(`--field expects formField=ColumnName, got "${pair}"`);
        options.fields.push({ field: pair.slice(0, eq).trim(), column: pair.slice(eq + 1).trim() });
        break;
      }
      case '--limit':
        options.limit = parseInt(next(), 10);
        if (!Number.isInteger(options.limit) || options.limit < 1) {
          throw new Error('--limit must be a positive integer');
        }
        break;
      case '--page-size':
        options.pageSize = parseInt(next(), 10);
        if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
          throw new Error('--page-size must be between 1 and 100');
        }
        break;
      case '--api': options.apiBase = next().replace(/\/$/, ''); break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Keep only rows matching the type/status filters.
 * Status matches on the leading word so "Published Restricted" counts as published.
 */
function filterRows(items, { type = null, status = null } = {}) {
  return items.filter(item => {
    if (type && String(item.type || '').trim().toLowerCase() !== type.toLowerCase()) return false;

    if (status) {
      const itemStatus = String(item.status || '').trim().toLowerCase();
      const wanted = status.trim().toLowerCase();
      if (!itemStatus.startsWith(wanted)) return false;
      // "Unpublished" must not satisfy a request for "published"
      if (wanted === 'published' && itemStatus.startsWith('unpublished')) return false;
    }

    return true;
  });
}

/**
 * Turn listing rows (plus any fetched detail) into CSV row objects.
 */
function buildRows(items, columns, fieldSpecs = [], detailByNode = new Map()) {
  return items.map(item => {
    const row = {};

    columns.forEach(column => {
      row[column] = item[column] === null || item[column] === undefined ? '' : String(item[column]);
    });

    const detail = detailByNode.get(item.id);
    fieldSpecs.forEach(({ field, column }) => {
      const value = detail ? detail[field] : undefined;
      row[column] = value === null || value === undefined ? '' : String(value);
    });

    return row;
  });
}

async function collectContent(apiBase, { pageSize, type, status, limit }) {
  const collected = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { body } = await getJSON(apiBase, `/content?limit=${pageSize}&page=${page}`);
    if (!body.success) {
      throw new Error(`Content listing failed on page ${page}: ${body.error || 'unknown error'}`);
    }

    const items = body.content || [];
    collected.push(...filterRows(items, { type, status }));
    console.error(`  page ${page}: ${items.length} listed (${collected.length} matching)`);

    if (limit !== null && collected.length >= limit) return collected.slice(0, limit);
    if (items.length === 0) break;
    if (!body.pagination || !body.pagination.hasNextPage) break;
  }

  return limit === null ? collected : collected.slice(0, limit);
}

const USAGE = `Export site content to CSV.

Usage:
  node examples/export-csv.js [--out <path>] [--type <name>] [--status <name>]

Options:
  --out <path>      Where to write the CSV (default: stdout)
  --type <name>     Only rows of this content type
  --status <name>   Only rows with this status, e.g. Published
  --columns <list>  Listing columns (default: ${DEFAULT_COLUMNS.join(',')})
  --field <f=Col>   Also export a node form field as column "Col" (repeatable;
                    costs one request per node)
  --limit <n>       Stop after n matching rows
  --page-size <n>   Rows per listing request (default: ${DEFAULT_PAGE_SIZE}, max 100)
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

  await ensureAuthenticated(options.apiBase);

  // Progress goes to stderr so --out can be omitted and the CSV piped
  console.error('Listing content...');
  const items = await collectContent(options.apiBase, options);
  console.error(`${items.length} row(s) matched.`);

  const detailByNode = new Map();
  if (options.fields.length > 0) {
    console.error(`Fetching node fields for ${items.length} node(s)...`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const { body } = await getJSON(options.apiBase, `/content/detail/${item.id}`);
      if (body.success) {
        detailByNode.set(item.id, body.content.data || {});
      } else {
        console.error(`  node ${item.id}: ${body.error || 'detail unavailable'}`);
      }
      if ((i + 1) % 10 === 0) console.error(`  ${i + 1}/${items.length}`);
    }
  }

  const headers = [...options.columns, ...options.fields.map(spec => spec.column)];
  const rows = buildRows(items, options.columns, options.fields, detailByNode);
  const csv = formatCSV(headers, rows);

  if (options.out) {
    fs.writeFileSync(options.out, csv);
    console.error(`Wrote ${rows.length} row(s) to ${options.out}`);
  } else {
    process.stdout.write(csv);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, filterRows, buildRows, collectContent, DEFAULT_COLUMNS };
