#!/usr/bin/env node

/**
 * Unpublish Published Events
 *
 * Finds every published event node on the Drupal site and unpublishes it by
 * setting the node form's "Published" checkbox (status[value]) to 0.
 *
 * Runs as a DRY RUN by default: it lists what it would unpublish and changes
 * nothing. Pass --execute to actually apply the change.
 *
 * Usage:
 *   node examples/unpublish-events.js                       # dry run, all events
 *   node examples/unpublish-events.js --execute             # unpublish everything found
 *   node examples/unpublish-events.js --execute --nodes 12,34   # only these node IDs
 *   node examples/unpublish-events.js --type Events --execute
 *
 * Options:
 *   --execute        Apply the changes (without it, nothing is modified)
 *   --type <name>    Content type label or machine name to target
 *                    (default: events, ps_events, event)
 *   --nodes <ids>    Comma-separated node IDs; restricts the run to these nodes
 *   --exclude <ids>  Comma-separated node IDs to leave published
 *   --max <n>        Safety cap on how many nodes may be unpublished (default: 500)
 *   --delay <ms>     Delay between node updates (default: 1500)
 *   --page-size <n>  Items per admin/content page request (default: 50, max 100)
 *   --report <path>  Write a JSON report of the run to this path
 *   --api <url>      API base URL (default: $API_BASE or http://localhost:3000)
 *
 * Prerequisites:
 *   1. Container running:      docker-compose up -d
 *   2. Authenticated session:  POST /login/interactive, log in via VNC,
 *                              then POST /login/save
 */

const fs = require('fs');

const { DEFAULT_API_BASE, apiRequest, putJSON, ensureAuthenticated, sleep } = require('../src/apiClient');
const DEFAULT_TYPES = ['events', 'ps_events', 'event'];
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX = 500;
const MAX_PAGES = 200; // hard stop so a broken pager cannot loop forever
const PUBLISHED_FIELD = 'status[value]';

// --- argument parsing ---

function parseArgs(argv) {
  const options = {
    execute: false,
    types: [...DEFAULT_TYPES],
    nodes: null,
    exclude: [],
    max: DEFAULT_MAX,
    delayMs: DEFAULT_DELAY_MS,
    pageSize: DEFAULT_PAGE_SIZE,
    report: null,
    apiBase: DEFAULT_API_BASE
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case '--execute':
        options.execute = true;
        break;
      case '--dry-run':
        options.execute = false;
        break;
      case '--type':
        options.types = [next().toLowerCase()];
        break;
      case '--nodes':
        options.nodes = next()
          .split(',')
          .map(id => parseInt(id.trim(), 10))
          .filter(id => Number.isInteger(id));
        if (options.nodes.length === 0) throw new Error('--nodes requires at least one numeric node ID');
        break;
      case '--exclude':
        options.exclude = next()
          .split(',')
          .map(id => parseInt(id.trim(), 10))
          .filter(id => Number.isInteger(id));
        if (options.exclude.length === 0) throw new Error('--exclude requires at least one numeric node ID');
        break;
      case '--max':
        options.max = parseInt(next(), 10);
        if (!Number.isInteger(options.max) || options.max < 1) throw new Error('--max must be a positive integer');
        break;
      case '--delay':
        options.delayMs = parseInt(next(), 10);
        if (!Number.isInteger(options.delayMs) || options.delayMs < 0) throw new Error('--delay must be >= 0');
        break;
      case '--page-size':
        options.pageSize = parseInt(next(), 10);
        if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100) {
          throw new Error('--page-size must be between 1 and 100');
        }
        break;
      case '--report':
        options.report = next();
        break;
      case '--api':
        options.apiBase = next().replace(/\/$/, '');
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

// --- selection logic ---

function isPublished(item) {
  // Status cells can carry extra markers (e.g. "Published Restricted"), so match
  // on the leading word - and reject "Unpublished" before it can match.
  const status = String(item.status || '').trim().toLowerCase();
  if (status.startsWith('unpublished')) return false;
  return status.startsWith('published');
}

function matchesType(item, types) {
  const type = String(item.type || '').trim().toLowerCase();
  return types.includes(type);
}

/**
 * Pick the nodes to unpublish out of a full content listing.
 * Only published items of a matching type with a usable node ID qualify.
 * Node IDs in `exclude` are always left alone, even if `nodes` names them.
 */
function selectPublishedEvents(items, { types = DEFAULT_TYPES, nodes = null, exclude = [] } = {}) {
  const wanted = nodes ? new Set(nodes) : null;
  const skipped = new Set(exclude);
  const seen = new Set();
  const selected = [];

  for (const item of items) {
    // Number(null) is 0, so reject anything that is not a positive integer
    const nodeId = item.id === null || item.id === undefined ? NaN : Number(item.id);
    if (!Number.isInteger(nodeId) || nodeId <= 0) continue;
    if (skipped.has(nodeId)) continue;
    if (wanted && !wanted.has(nodeId)) continue;
    if (!matchesType(item, types)) continue;
    if (!isPublished(item)) continue;
    if (seen.has(nodeId)) continue;

    seen.add(nodeId);
    selected.push({ id: nodeId, title: item.title, type: item.type, status: item.status });
  }

  return selected;
}

// --- API client ---

/**
 * Page through /content until the pager runs out, returning every row.
 */
async function collectAllContent(apiBase, { pageSize = DEFAULT_PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
  const items = [];

  for (let page = 1; page <= maxPages; page++) {
    const { body } = await apiRequest(apiBase, `/content?limit=${pageSize}&page=${page}`);

    if (!body.success) {
      throw new Error(`Content listing failed on page ${page}: ${body.error || 'unknown error'}`);
    }

    const pageItems = body.content || [];
    items.push(...pageItems);
    console.log(`  page ${page}: ${pageItems.length} items (${items.length} total)`);

    if (pageItems.length === 0) break;
    if (!body.pagination || !body.pagination.hasNextPage) break;

    if (page === maxPages) {
      console.warn(`Stopped at the ${maxPages}-page safety cap; some content may not have been listed.`);
    }
  }

  return items;
}

async function unpublishNode(apiBase, nodeId) {
  const { body } = await putJSON(apiBase, `/content/${nodeId}`, { [PUBLISHED_FIELD]: '0' });

  // The update endpoint reports success even when a field could not be found,
  // so confirm the published field is in updatedFields before calling it done.
  const updatedFields = body.updatedFields || [];
  const applied = updatedFields.some(field => field.field === PUBLISHED_FIELD);

  if (!body.success) {
    return { success: false, error: body.error || `HTTP failure updating node ${nodeId}` };
  }

  if (!applied) {
    const skipped = (body.skippedFields || []).map(field => `${field.field}: ${field.reason}`).join('; ');
    return { success: false, error: `Published field was not applied${skipped ? ` (${skipped})` : ''}` };
  }

  return { success: true, redirectUrl: body.redirectUrl };
}

async function unpublishAll(apiBase, targets, { delayMs = DEFAULT_DELAY_MS } = {}) {
  const succeeded = [];
  const failed = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    process.stdout.write(`[${i + 1}/${targets.length}] node ${target.id} - ${target.title} ... `);

    try {
      const result = await unpublishNode(apiBase, target.id);
      if (result.success) {
        console.log('unpublished');
        succeeded.push(target);
      } else {
        console.log(`FAILED (${result.error})`);
        failed.push({ ...target, error: result.error });
      }
    } catch (error) {
      console.log(`FAILED (${error.message})`);
      failed.push({ ...target, error: error.message });
    }

    if (delayMs > 0 && i < targets.length - 1) {
      await sleep(delayMs);
    }
  }

  return { succeeded, failed };
}

// --- main ---

const USAGE = `Unpublish every published event node on the Drupal site.

Usage:
  node examples/unpublish-events.js [options]

Options:
  --execute        Apply the changes (default is a dry run that changes nothing)
  --dry-run        Force dry-run mode (default)
  --type <name>    Content type label or machine name to target
                   (default: ${DEFAULT_TYPES.join(', ')})
  --nodes <ids>    Comma-separated node IDs; restricts the run to these nodes
  --exclude <ids>  Comma-separated node IDs to leave published
  --max <n>        Safety cap on how many nodes may be unpublished (default: ${DEFAULT_MAX})
  --delay <ms>     Delay between node updates (default: ${DEFAULT_DELAY_MS})
  --page-size <n>  Items per admin/content page request (default: ${DEFAULT_PAGE_SIZE}, max 100)
  --report <path>  Write a JSON report of the run to this path
  --api <url>      API base URL (default: ${DEFAULT_API_BASE})
  -h, --help       Show this help`;

function printHelp() {
  console.log(USAGE);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    return;
  }

  console.log('Unpublish Events');
  console.log('================');
  console.log(`API:        ${options.apiBase}`);
  console.log(`Mode:       ${options.execute ? 'EXECUTE (changes will be saved)' : 'DRY RUN (no changes)'}`);
  console.log(`Types:      ${options.types.join(', ')}`);
  if (options.nodes) console.log(`Node IDs:   ${options.nodes.join(', ')}`);
  if (options.exclude.length) console.log(`Excluded:   ${options.exclude.join(', ')}`);
  console.log('');

  await ensureAuthenticated(options.apiBase);
  console.log('Session authenticated.\n');

  console.log('Listing content...');
  const allContent = await collectAllContent(options.apiBase, { pageSize: options.pageSize });
  console.log(`Found ${allContent.length} content items total.\n`);

  const targets = selectPublishedEvents(allContent, {
    types: options.types,
    nodes: options.nodes,
    exclude: options.exclude
  });

  console.log(`Published events to unpublish: ${targets.length}`);
  targets.forEach(target => console.log(`  ${target.id}\t${target.title}`));
  console.log('');

  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (targets.length > options.max) {
    console.error(`Refusing to continue: ${targets.length} nodes exceeds the --max safety cap of ${options.max}.`);
    process.exit(1);
  }

  let results = { succeeded: [], failed: [] };

  if (!options.execute) {
    console.log('Dry run complete - no changes made. Re-run with --execute to unpublish these nodes.');
  } else {
    results = await unpublishAll(options.apiBase, targets, { delayMs: options.delayMs });
    console.log('');
    console.log(`Unpublished: ${results.succeeded.length}`);
    console.log(`Failed:      ${results.failed.length}`);
    results.failed.forEach(failure => console.log(`  ${failure.id}\t${failure.title}\t${failure.error}`));
  }

  if (options.report) {
    const report = {
      generatedAt: new Date().toISOString(),
      apiBase: options.apiBase,
      mode: options.execute ? 'execute' : 'dry-run',
      types: options.types,
      excluded: options.exclude,
      totalContentListed: allContent.length,
      targets,
      succeeded: results.succeeded,
      failed: results.failed
    };
    fs.writeFileSync(options.report, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${options.report}`);
  }

  if (results.failed.length > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  isPublished,
  matchesType,
  selectPublishedEvents,
  collectAllContent,
  unpublishNode,
  unpublishAll,
  DEFAULT_TYPES,
  PUBLISHED_FIELD
};
