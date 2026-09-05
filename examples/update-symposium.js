#!/usr/bin/env node

/**
 * Update Existing Symposium Events from CSV
 *
 * Matches CSV rows to existing ps_events nodes by title (student name),
 * compares Start Time, End Time, and Event Audience, and updates only
 * fields that differ.
 *
 * See examples/symposium-import.csv for the expected template format.
 *
 * CSV columns:
 *   First          - Student first name (combined with Last for event title)
 *   Last           - Student last name
 *   Event Audience - Room label, must match an existing Drupal audience option
 *   Date           - Event date in M/D/YY format (e.g., 5/1/26)
 *   Start Time     - Start time in h:MM AM/PM format
 *   End Time       - End time in h:MM AM/PM format
 *
 * Usage:
 *   node examples/update-symposium.js [path-to-csv]
 *   node examples/update-symposium.js --dry-run [path-to-csv]
 *
 *   --dry-run   Show what would change without saving
 *
 *   Defaults to ~/Downloads/symposium-import.csv when no path is given.
 *
 * Prerequisites:
 *   1. Docker container running: docker-compose up -d
 *   2. Authenticated session saved via /login/interactive + /login/save
 *   3. Events already created via import-symposium.js
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const CONTENT_TYPE = 'ps_events';
const DELAY_MS = 2000;

// Drupal form field names for the three updatable fields
const FORM_KEYS = {
  event_start_time: 'field_ps_events_date[0][value][time]',
  event_end_time:   'field_ps_events_date[0][end_value][time]',
  event_audience:   'field_ps_events_audience[]'
};

// --- CSV utilities (shared with import-symposium.js) ---

function parseCSV(filePath) {
  let raw = fs.readFileSync(filePath, 'utf-8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

  const lines = raw.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = line.split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function normalizeTime(timeStr) {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return timeStr;
  return `${match[1].padStart(2, '0')}:${match[2]} ${match[3].toUpperCase()}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- API helpers ---

async function apiGet(path) {
  const res = await fetch(`${API_BASE}${path}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// --- Core logic ---

/**
 * Build a map of event title -> nodeId by paginating the content list.
 */
async function buildEventIndex() {
  const index = new Map();
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const result = await apiGet(`/content?limit=100&page=${page}`);
    if (!result.success) throw new Error(`Content list failed: ${result.error}`);

    for (const item of result.content) {
      if (item.type && item.type.toLowerCase() === 'event' && item.id) {
        // contentTitle has format "Title/path/alias" — extract the title portion
        const rawTitle = item.contentTitle || item.title || '';
        const title = rawTitle.split('/')[0].trim();
        if (title) {
          index.set(title, item.id);
        }
      }
    }

    hasMore = result.pagination && result.pagination.hasNextPage;
    page++;
  }

  return index;
}

/**
 * Fetch the audience select options from the add form (value -> label mapping).
 * Returns { byValue: { '6': '001 - Sherrerd Hall', ... }, byLabel: { '001 - Sherrerd Hall': '6', ... } }
 */
async function fetchAudienceMapping() {
  const result = await apiGet(`/content/form-options/${CONTENT_TYPE}`);
  if (!result.success) throw new Error(`Form options failed: ${result.error}`);

  const selectName = 'field_ps_events_audience[]';
  const options = result.options[selectName] || [];

  const byValue = {};
  const byLabel = {};
  for (const opt of options) {
    byValue[opt.value] = opt.label;
    byLabel[opt.label] = opt.value;
  }

  return { byValue, byLabel };
}

/**
 * Fetch current field values for a node from its edit form.
 * Returns { event_start_time, event_end_time, event_audience } using schema field names.
 */
async function fetchCurrentValues(nodeId, audienceMap) {
  const result = await apiGet(`/content/detail/${nodeId}`);
  if (!result.success) throw new Error(`Detail failed for node/${nodeId}: ${result.error}`);

  const data = result.content.data;

  // Resolve audience ID to label for comparison
  const rawAudience = data[FORM_KEYS.event_audience] || '';
  const audienceLabel = audienceMap.byValue[rawAudience] || rawAudience;

  return {
    event_start_time: data[FORM_KEYS.event_start_time] || '',
    event_end_time:   data[FORM_KEYS.event_end_time]   || '',
    event_audience:   audienceLabel
  };
}

/**
 * Compare CSV values against current values and return a diff.
 */
function diffFields(csvFields, currentValues) {
  const changes = {};

  if (normalizeTime(csvFields.event_start_time) !== normalizeTime(currentValues.event_start_time)) {
    changes.event_start_time = {
      from: currentValues.event_start_time,
      to: csvFields.event_start_time
    };
  }

  if (normalizeTime(csvFields.event_end_time) !== normalizeTime(currentValues.event_end_time)) {
    changes.event_end_time = {
      from: currentValues.event_end_time,
      to: csvFields.event_end_time
    };
  }

  if (csvFields.event_audience !== currentValues.event_audience) {
    changes.event_audience = {
      from: currentValues.event_audience,
      to: csvFields.event_audience
    };
  }

  return changes;
}

// --- Main ---

async function main() {
  // Parse args
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const csvPath = args.find(a => !a.startsWith('--')) ||
    path.join(require('os').homedir(), 'Downloads', 'symposium-import.csv');

  console.log(`=== Symposium Event Update${dryRun ? ' (DRY RUN)' : ''} ===\n`);

  // Parse CSV
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }
  const rows = parseCSV(csvPath);
  console.log(`Parsed ${rows.length} rows from ${csvPath}\n`);

  // Check API health
  try {
    const h = await apiGet('/health');
    if (h.status !== 'healthy') throw new Error('unhealthy');
  } catch {
    console.error(`API not reachable at ${API_BASE}. Is the container running?`);
    process.exit(1);
  }

  // Load session
  console.log('Loading authenticated session...');
  const loadResult = await apiPost('/login/load');
  if (!loadResult.success) {
    console.error(`Failed to load session: ${loadResult.error}`);
    process.exit(1);
  }
  console.log('Session loaded.\n');
  await sleep(DELAY_MS);

  // Build event index
  console.log('Building event index...');
  const index = await buildEventIndex();
  console.log(`Found ${index.size} existing events.\n`);

  // Fetch audience mapping
  console.log('Fetching audience options...');
  const audienceMap = await fetchAudienceMapping();
  const audienceCount = Object.keys(audienceMap.byValue).length;
  console.log(`Found ${audienceCount} audience options.\n`);

  // Process rows
  const results = { updated: 0, unchanged: 0, notFound: 0, failed: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const firstName = row['First'].trim();
    const lastName = row['Last'].trim();
    const title = `${firstName} ${lastName}`;
    const label = `[${i + 1}/${rows.length}] ${title}`;

    const csvFields = {
      event_start_time: normalizeTime(row['Start Time']),
      event_end_time:   normalizeTime(row['End Time']),
      event_audience:   row['Event Audience']
    };

    // Look up existing node
    const nodeId = index.get(title);
    if (!nodeId) {
      console.log(`MISS ${label} — no matching event`);
      results.notFound++;
      continue;
    }

    try {
      // Fetch current values and compare
      const current = await fetchCurrentValues(nodeId, audienceMap);
      const changes = diffFields(csvFields, current);

      if (Object.keys(changes).length === 0) {
        console.log(`OK   ${label} — no changes (node/${nodeId})`);
        results.unchanged++;
      } else {
        // Build the update payload with only changed fields
        const updates = {};
        for (const field of Object.keys(changes)) {
          updates[field] = changes[field].to;
        }

        const changeDesc = Object.entries(changes)
          .map(([f, c]) => `${f}: "${c.from}" -> "${c.to}"`)
          .join(', ');

        if (dryRun) {
          console.log(`DIFF ${label} — node/${nodeId}: ${changeDesc}`);
          results.updated++;
        } else {
          const updateResult = await apiPut(`/content/${nodeId}`, updates);
          if (updateResult.success) {
            console.log(`UPD  ${label} — node/${nodeId}: ${changeDesc}`);
            results.updated++;
          } else {
            console.log(`FAIL ${label} — node/${nodeId}: ${updateResult.error}`);
            results.failed++;
            results.errors.push({ row: i + 1, title, error: updateResult.error });
          }
        }
      }
    } catch (err) {
      console.log(`ERR  ${label} — node/${nodeId}: ${err.message}`);
      results.failed++;
      results.errors.push({ row: i + 1, title, error: err.message });
    }

    if (i < rows.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  // Summary
  console.log(`\n=== Update Complete${dryRun ? ' (DRY RUN)' : ''} ===`);
  console.log(`Total:     ${rows.length}`);
  console.log(`Updated:   ${results.updated}`);
  console.log(`Unchanged: ${results.unchanged}`);
  console.log(`Not found: ${results.notFound}`);
  console.log(`Failed:    ${results.failed}`);

  if (results.errors.length > 0) {
    console.log('\nFailed rows:');
    results.errors.forEach(e => {
      console.log(`  Row ${e.row} (${e.title}): ${e.error}`);
    });
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

main();
