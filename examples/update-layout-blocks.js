#!/usr/bin/env node

/**
 * Bulk-update Layout Builder blocks
 *
 * Sets one or more configuration fields across every block in a node's layout
 * that matches a filter (block plugin ID and/or admin label).
 *
 * Layout Builder stages edits in a per-user tempstore, so this script stages
 * every matching block first and saves the layout once at the end. If any block
 * fails to stage, nothing is saved and the staged changes are discarded, which
 * leaves the live layout untouched.
 *
 * Runs as a DRY RUN by default. Pass --execute to apply.
 *
 * Usage:
 *   # See which blocks match, and what they currently hold
 *   node examples/update-layout-blocks.js --node 1 --plugin ps_events_list_conference \
 *     --field 'settings[ps_core_description][value]'
 *
 *   # Set the field across every matching block
 *   node examples/update-layout-blocks.js --node 1 --plugin ps_events_list_conference \
 *     --field 'settings[ps_core_description][value]' --value '<ul><li>TBD</li></ul>' --execute
 *
 * Options:
 *   --node <id>        Node whose layout to edit (required)
 *   --plugin <id>      Only blocks with this block plugin ID (e.g. ps_events_list_conference)
 *   --label <text>     Only blocks whose admin label contains this text (case-insensitive)
 *   --uuids <list>     Comma-separated block UUIDs; restricts the run to these blocks
 *   --field <name>     Form field name to set (repeatable, pairs with --value)
 *   --value <text>     Value for the preceding --field (repeatable)
 *   --value-file <p>   Read the value for the preceding --field from a file
 *   --execute          Apply the changes (default is a dry run)
 *   --keep-staged      On failure, leave staged changes instead of discarding them
 *   --report <path>    Write a JSON report of the run
 *   --api <url>        API base URL (default: $API_BASE or http://localhost:3000)
 *
 * Prerequisites:
 *   1. Container running:      docker-compose up -d
 *   2. Authenticated session:  POST /login/interactive, log in via VNC, POST /login/save
 */

const fs = require('fs');

const { DEFAULT_API_BASE, apiRequest, postJSON, putJSON, ensureAuthenticated } = require('../src/apiClient');

// --- argument parsing ---

function parseArgs(argv) {
  const options = {
    apiBase: DEFAULT_API_BASE,
    nodeId: null,
    plugin: null,
    label: null,
    uuids: null,
    updates: {},
    execute: false,
    keepStaged: false,
    report: null,
    help: false
  };

  // --field names the key, the following --value/--value-file supplies its value
  let pendingField = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case '--node':
        options.nodeId = next();
        if (!/^\d+$/.test(options.nodeId)) throw new Error('--node must be a numeric node ID');
        break;
      case '--plugin':
        options.plugin = next();
        break;
      case '--label':
        options.label = next();
        break;
      case '--uuids':
        options.uuids = next().split(',').map(id => id.trim()).filter(Boolean);
        if (options.uuids.length === 0) throw new Error('--uuids requires at least one UUID');
        break;
      case '--field':
        pendingField = next();
        break;
      case '--value':
        if (!pendingField) throw new Error('--value must follow a --field');
        options.updates[pendingField] = next();
        pendingField = null;
        break;
      case '--value-file':
        if (!pendingField) throw new Error('--value-file must follow a --field');
        options.updates[pendingField] = fs.readFileSync(next(), 'utf-8');
        pendingField = null;
        break;
      case '--execute':
        options.execute = true;
        break;
      case '--keep-staged':
        options.keepStaged = true;
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

  if (pendingField) {
    // A bare --field with no value is how you inspect a field without changing it
    options.inspectField = pendingField;
  }

  return options;
}

// --- selection ---

/**
 * Test a block label against the --label filter.
 *
 * Matching is a case-insensitive substring test rather than a regular
 * expression: building a RegExp from a command-line argument invites
 * catastrophic backtracking, and labels are short names where substring
 * matching is what people actually want. Use --plugin or --uuids when an
 * exact selection is needed.
 *
 * @param {string|null} blockLabel - The block's admin label
 * @param {string|null} filter - Text from --label
 * @returns {boolean} True when no filter is set or the label contains it
 */
function matchesLabel(blockLabel, filter) {
  if (!filter) return true;
  return String(blockLabel || '').toLowerCase().includes(String(filter).toLowerCase());
}

/**
 * Pick the layout blocks a run should touch.
 * With no filters every block matches, so at least one filter is expected.
 */
function selectBlocks(blocks, { plugin = null, label = null, uuids = null } = {}) {
  const wanted = uuids ? new Set(uuids) : null;

  return blocks.filter(block => {
    if (wanted && !wanted.has(block.uuid)) return false;
    if (plugin && block.pluginId !== plugin) return false;
    if (!matchesLabel(block.label, label)) return false;
    return true;
  });
}

// --- API client ---

async function listBlocks(apiBase, nodeId) {
  const { body } = await apiRequest(apiBase, `/layout/${nodeId}/blocks`);
  if (!body.success) {
    throw new Error(`Could not list layout blocks: ${body.error || 'unknown error'}`);
  }
  return body.blocks || [];
}

async function readBlock(apiBase, nodeId, block) {
  const { body } = await apiRequest(
    apiBase,
    `/layout/${nodeId}/block/${block.delta}/${block.region}/${block.uuid}`
  );
  if (!body.success) {
    throw new Error(`Could not read block ${block.uuid}: ${body.error || 'unknown error'}`);
  }
  return body.block;
}

async function stageBlockUpdate(apiBase, nodeId, block, updates) {
  const { body } = await putJSON(
    apiBase,
    `/layout/${nodeId}/block/${block.delta}/${block.region}/${block.uuid}`,
    updates
  );

  if (!body.success) {
    return { success: false, error: body.error || 'unknown error' };
  }

  // Confirm every requested field actually resolved to a widget
  const applied = new Set((body.updatedFields || []).map(field => field.field));
  const missing = Object.keys(updates).filter(name => !applied.has(name));

  if (missing.length > 0) {
    const skipped = (body.skippedFields || []).map(field => `${field.field}: ${field.reason}`).join('; ');
    return { success: false, error: `Fields not applied: ${missing.join(', ')}${skipped ? ` (${skipped})` : ''}` };
  }

  return { success: true, updatedFields: body.updatedFields };
}

async function saveLayout(apiBase, nodeId) {
  const { body } = await postJSON(apiBase, `/layout/${nodeId}/save`);
  return body;
}

async function discardLayout(apiBase, nodeId) {
  const { body } = await postJSON(apiBase, `/layout/${nodeId}/discard`);
  return body;
}

// --- main ---

const USAGE = `Bulk-update Layout Builder blocks on a node.

Usage:
  node examples/update-layout-blocks.js --node <id> [filters] [--field <name> --value <text>] [--execute]

Filters:
  --plugin <id>      Only blocks with this block plugin ID
  --label <text>     Only blocks whose admin label contains this text (case-insensitive)
  --uuids <list>     Comma-separated block UUIDs

Updates:
  --field <name>     Form field name to set (repeatable, pairs with --value)
  --value <text>     Value for the preceding --field
  --value-file <p>   Read the value for the preceding --field from a file
  A --field with no --value inspects that field instead of changing it.

Other:
  --execute          Apply the changes (default is a dry run)
  --keep-staged      On failure, leave staged changes instead of discarding them
  --report <path>    Write a JSON report of the run
  --api <url>        API base URL (default: ${DEFAULT_API_BASE})
  -h, --help         Show this help`;

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
    console.log(USAGE);
    return;
  }

  if (!options.nodeId) {
    console.error('Error: --node is required.');
    process.exit(1);
  }

  const fieldNames = Object.keys(options.updates);
  const inspectOnly = fieldNames.length === 0;

  console.log('Update Layout Blocks');
  console.log('====================');
  console.log(`API:     ${options.apiBase}`);
  console.log(`Node:    ${options.nodeId}`);
  console.log(`Mode:    ${options.execute && !inspectOnly ? 'EXECUTE (changes will be saved)' : 'DRY RUN (no changes)'}`);
  if (options.plugin) console.log(`Plugin:  ${options.plugin}`);
  if (options.label) console.log(`Label:   contains "${options.label}"`);
  if (options.uuids) console.log(`UUIDs:   ${options.uuids.join(', ')}`);
  console.log('');

  await ensureAuthenticated(options.apiBase);

  console.log('Listing layout blocks...');
  const allBlocks = await listBlocks(options.apiBase, options.nodeId);
  console.log(`Found ${allBlocks.length} block(s) in the layout.\n`);

  const targets = selectBlocks(allBlocks, {
    plugin: options.plugin,
    label: options.label,
    uuids: options.uuids
  });

  console.log(`Matching blocks: ${targets.length}`);
  targets.forEach(block => console.log(`  ${block.uuid}  [${block.pluginId}]  ${block.label}`));
  console.log('');

  if (targets.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Show the current value of every field the run would touch
  const inspectFields = inspectOnly
    ? (options.inspectField ? [options.inspectField] : [])
    : fieldNames;

  const before = [];
  if (inspectFields.length > 0) {
    console.log('Current values:');
    for (const block of targets) {
      const detail = await readBlock(options.apiBase, options.nodeId, block);
      const values = {};
      inspectFields.forEach(name => { values[name] = detail.data[name]; });
      before.push({ uuid: block.uuid, label: block.label, values });

      console.log(`  ${block.label}`);
      inspectFields.forEach(name => console.log(`    ${name} = ${JSON.stringify(values[name])}`));
    }
    console.log('');
  }

  if (inspectOnly) {
    console.log('No --field/--value pairs given - nothing to change.');
    if (options.report) {
      fs.writeFileSync(options.report, JSON.stringify({ nodeId: options.nodeId, blocks: targets, before }, null, 2));
      console.log(`Report written to ${options.report}`);
    }
    return;
  }

  console.log('New values:');
  fieldNames.forEach(name => console.log(`  ${name} = ${JSON.stringify(options.updates[name])}`));
  console.log('');

  const results = { staged: [], failed: [] };

  if (!options.execute) {
    console.log(`Dry run complete - no changes made. Re-run with --execute to update ${targets.length} block(s).`);
  } else {
    for (let i = 0; i < targets.length; i++) {
      const block = targets[i];
      process.stdout.write(`[${i + 1}/${targets.length}] ${block.label} ... `);

      try {
        const result = await stageBlockUpdate(options.apiBase, options.nodeId, block, options.updates);
        if (result.success) {
          console.log('staged');
          results.staged.push(block);
        } else {
          console.log(`FAILED (${result.error})`);
          results.failed.push({ ...block, error: result.error });
        }
      } catch (error) {
        console.log(`FAILED (${error.message})`);
        results.failed.push({ ...block, error: error.message });
      }
    }

    console.log('');

    if (results.failed.length > 0) {
      console.log(`${results.failed.length} block(s) failed to stage - not saving the layout.`);

      if (options.keepStaged) {
        console.log('Staged changes left in place (--keep-staged).');
      } else {
        process.stdout.write('Discarding staged changes... ');
        const discard = await discardLayout(options.apiBase, options.nodeId);
        console.log(discard.success ? 'done' : `FAILED (${discard.error})`);
      }
    } else {
      process.stdout.write(`Saving layout with ${results.staged.length} updated block(s)... `);
      const saved = await saveLayout(options.apiBase, options.nodeId);
      console.log(saved.success ? 'saved' : `FAILED (${saved.error})`);
      results.saved = saved.success;

      if (!saved.success) {
        results.failed.push({ uuid: null, label: 'layout save', error: saved.error });
      }
    }
  }

  if (options.report) {
    fs.writeFileSync(options.report, JSON.stringify({
      generatedAt: new Date().toISOString(),
      apiBase: options.apiBase,
      nodeId: options.nodeId,
      mode: options.execute ? 'execute' : 'dry-run',
      filters: { plugin: options.plugin, label: options.label, uuids: options.uuids },
      updates: options.updates,
      matched: targets,
      before,
      staged: results.staged,
      failed: results.failed,
      saved: results.saved === true
    }, null, 2));
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
  matchesLabel,
  selectBlocks,
  listBlocks,
  readBlock,
  stageBlockUpdate,
  saveLayout,
  discardLayout
};
