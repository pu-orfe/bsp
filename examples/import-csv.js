#!/usr/bin/env node

/**
 * Import Symposium Events from CSV
 *
 * Reads a CSV file and creates a ps_events node for each row.
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
 *   node examples/import-symposium.js [path-to-csv]
 *
 *   Defaults to ~/Downloads/symposium-import.csv when no path is given.
 *
 * Prerequisites:
 *   1. Docker container running: docker-compose up -d
 *   2. Authenticated session saved via /login/interactive + /login/save
 */

const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const CSV_PATH = process.argv[2] || path.join(require('os').homedir(), 'Downloads', 'symposium-import.csv');
const CONTENT_TYPE = 'ps_events';

// Delay between event creations (ms) to avoid overwhelming the browser
const DELAY_BETWEEN_CREATES = 2000;


function parseCSV(filePath) {
  let raw = fs.readFileSync(filePath, 'utf-8');
  // Strip BOM
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }

  const lines = raw.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  return rows;
}

function convertDate(dateStr) {
  // "5/1/26" -> "2026-05-01"
  const parts = dateStr.split('/');
  const month = parts[0].padStart(2, '0');
  const day = parts[1].padStart(2, '0');
  let year = parts[2];
  if (year.length === 2) {
    year = '20' + year;
  }
  return `${year}-${month}-${day}`;
}

function normalizeTime(timeStr) {
  // Normalize to "HH:MM AM/PM" format that Drupal expects
  // "9:00 AM" -> "09:00 AM", "12:00 PM" -> "12:00 PM"
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return timeStr;

  const hours = match[1].padStart(2, '0');
  const minutes = match[2];
  const period = match[3].toUpperCase();

  return `${hours}:${minutes} ${period}`;
}

function buildEventFields(row) {
  const firstName = row['First'].trim();
  const lastName = row['Last'].trim();
  const title = `${firstName} ${lastName}`;
  const date = convertDate(row['Date']);
  const startTime = normalizeTime(row['Start Time']);
  const endTime = normalizeTime(row['End Time']);
  const audience = row['Event Audience'];

  return {
    title,
    subtitle: 'TBD',
    all_day: false,
    event_audience: audience,
    event_start_date: date,
    event_start_time: startTime,
    event_end_date: date,
    event_end_time: endTime,
    status: true
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Symposium Event Import ===\n');

  // Parse CSV
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const rows = parseCSV(CSV_PATH);
  console.log(`Parsed ${rows.length} rows from ${CSV_PATH}\n`);

  // Check API health
  try {
    const health = await fetch(`${API_BASE}/health`);
    const h = await health.json();
    if (h.status !== 'healthy') throw new Error('unhealthy');
  } catch {
    console.error(`API not reachable at ${API_BASE}. Is the container running?`);
    process.exit(1);
  }

  // Load authenticated session
  console.log('Loading authenticated session...');
  const loadRes = await fetch(`${API_BASE}/login/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const loadResult = await loadRes.json();
  if (!loadResult.success) {
    console.error(`Failed to load session: ${loadResult.error}`);
    console.error('Authenticate first: POST /login/interactive, then log in via VNC, then POST /login/save');
    process.exit(1);
  }
  console.log('Session loaded.\n');

  // Wait for session load navigation to settle before first request
  await sleep(DELAY_BETWEEN_CREATES);

  // Import events
  const results = { success: 0, failed: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fields = buildEventFields(row);
    const label = `[${i + 1}/${rows.length}] ${fields.title}`;

    try {
      const res = await fetch(`${API_BASE}/content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: CONTENT_TYPE, fields })
      });

      const result = await res.json();

      if (result.success) {
        console.log(`OK  ${label} -> node/${result.nodeId}`);
        if (result.skippedFields && result.skippedFields.length > 0) {
          result.skippedFields.forEach(sf => {
            console.log(`    SKIP ${sf.field}: ${sf.reason}`);
          });
        }
        results.success++;
      } else {
        console.log(`FAIL ${label}: ${result.error}`);
        results.failed++;
        results.errors.push({ row: i + 1, name: fields.title, error: result.error });
      }
    } catch (err) {
      console.log(`ERR  ${label}: ${err.message}`);
      results.failed++;
      results.errors.push({ row: i + 1, name: fields.title, error: err.message });
    }

    if (i < rows.length - 1) {
      await sleep(DELAY_BETWEEN_CREATES);
    }
  }

  // Summary
  console.log('\n=== Import Complete ===');
  console.log(`Total:   ${rows.length}`);
  console.log(`Success: ${results.success}`);
  console.log(`Failed:  ${results.failed}`);

  if (results.errors.length > 0) {
    console.log('\nFailed rows:');
    results.errors.forEach(e => {
      console.log(`  Row ${e.row} (${e.name}): ${e.error}`);
    });
  }

  process.exit(results.failed > 0 ? 1 : 0);
}

main();
