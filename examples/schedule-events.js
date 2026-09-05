#!/usr/bin/env node

/**
 * Fill a CSV's schedule columns with a reproducible room/time assignment.
 *
 * Reads a partially complete CSV (names filled in, schedule columns blank),
 * assigns each row a room and a time slot, and writes the CSV back out. The
 * assignment is driven by a fixed seed, so re-running with the same inputs
 * produces exactly the same schedule.
 *
 * Rows fill the grid room-by-room across each time slot, so rooms end up as
 * evenly loaded as the numbers allow and no room has a gap mid-day.
 *
 * Usage:
 *   node examples/schedule-events.js --csv ~/Downloads/symposium-import.csv \
 *     --date 2027-04-30 --rooms-file rooms.txt --seed 20270430
 *
 * Options:
 *   --csv <path>       CSV to read (required)
 *   --out <path>       Where to write (default: overwrite --csv)
 *   --date <date>      Value for the Date column, e.g. 2027-04-30 (required)
 *   --rooms <list>     Comma-separated room names
 *   --rooms-file <p>   File with one room name per line (use when names contain commas)
 *   --seed <n>         PRNG seed (required, so runs are reproducible)
 *   --start <time>     First slot start (default: 9:00 AM)
 *   --slot <minutes>   Slot length in minutes (default: 15)
 *   --break <time>     Start of a break window no talk may occupy
 *   --break-minutes    Length of the break window (default: 30)
 *   --room-column <n>  Column to write the room into (default: Event Audience)
 *   --dry-run          Print the schedule without writing the file
 */

const fs = require('fs');
const path = require('path');

const { parseCSV, formatCSV } = require('../src/csv');
const { assignSchedule } = require('../src/schedule');

const DEFAULTS = {
  start: '9:00 AM',
  slotMinutes: 15,
  breakMinutes: 30,
  roomColumn: 'Event Audience',
  dateColumn: 'Date',
  startColumn: 'Start Time',
  endColumn: 'End Time'
};

function parseArgs(argv) {
  const options = {
    csv: null,
    out: null,
    date: null,
    rooms: null,
    seed: null,
    start: DEFAULTS.start,
    slotMinutes: DEFAULTS.slotMinutes,
    breakStart: null,
    breakMinutes: DEFAULTS.breakMinutes,
    roomColumn: DEFAULTS.roomColumn,
    dryRun: false,
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
      case '--out': options.out = next(); break;
      case '--date': options.date = next(); break;
      case '--rooms':
        options.rooms = next().split(',').map(room => room.trim()).filter(Boolean);
        break;
      case '--rooms-file':
        options.rooms = fs.readFileSync(next(), 'utf-8')
          .split('\n').map(room => room.trim()).filter(Boolean);
        break;
      case '--seed':
        options.seed = parseInt(next(), 10);
        if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');
        break;
      case '--start': options.start = next(); break;
      case '--slot':
        options.slotMinutes = parseInt(next(), 10);
        if (!Number.isInteger(options.slotMinutes) || options.slotMinutes < 1) {
          throw new Error('--slot must be a positive integer');
        }
        break;
      case '--break': options.breakStart = next(); break;
      case '--break-minutes':
        options.breakMinutes = parseInt(next(), 10);
        if (!Number.isInteger(options.breakMinutes) || options.breakMinutes < 0) {
          throw new Error('--break-minutes must be >= 0');
        }
        break;
      case '--room-column': options.roomColumn = next(); break;
      case '--dry-run': options.dryRun = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/**
 * Apply a schedule to CSV rows, returning new row objects.
 * Rows are returned in their original CSV order; only the schedule columns change.
 */
function applySchedule(rows, assignments, { date, roomColumn = DEFAULTS.roomColumn } = {}) {
  const byRow = new Map();
  assignments.forEach(assignment => byRow.set(assignment.item, assignment));

  return rows.map(row => {
    const assignment = byRow.get(row);
    if (!assignment) return { ...row };

    return {
      ...row,
      [roomColumn]: assignment.room,
      [DEFAULTS.dateColumn]: date,
      [DEFAULTS.startColumn]: assignment.start,
      [DEFAULTS.endColumn]: assignment.end
    };
  });
}

/**
 * Count how many rows landed in each room, for the run summary.
 */
function summarizeByRoom(rows, roomColumn = DEFAULTS.roomColumn) {
  const counts = new Map();

  rows.forEach(row => {
    const room = row[roomColumn];
    if (!room) return;
    counts.set(room, (counts.get(room) || 0) + 1);
  });

  return counts;
}

const USAGE = `Fill a CSV's schedule columns with a reproducible room/time assignment.

Usage:
  node examples/schedule-events.js --csv <path> --date <YYYY-MM-DD> --seed <n> [--rooms <list>]

Options:
  --csv <path>        CSV to read (required)
  --out <path>        Where to write (default: overwrite --csv)
  --date <date>       Value for the Date column (required)
  --rooms <list>      Comma-separated room names
  --rooms-file <p>    File with one room name per line
  --seed <n>          PRNG seed (required, so runs are reproducible)
  --start <time>      First slot start (default: ${DEFAULTS.start})
  --slot <minutes>    Slot length (default: ${DEFAULTS.slotMinutes})
  --break <time>      Start of a break window no talk may occupy
  --break-minutes <n> Break length (default: ${DEFAULTS.breakMinutes})
  --room-column <n>   Column to write the room into (default: ${DEFAULTS.roomColumn})
  --dry-run           Print the schedule without writing the file
  -h, --help          Show this help`;

function main() {
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

  if (!options.csv) throw new Error('--csv is required');
  if (!options.date) throw new Error('--date is required');
  if (options.seed === null) throw new Error('--seed is required so the assignment is reproducible');

  const csvPath = path.resolve(options.csv);
  const { headers, rows } = parseCSV(fs.readFileSync(csvPath, 'utf-8'));

  if (rows.length === 0) {
    console.log('CSV has no data rows - nothing to schedule.');
    return;
  }

  // Fall back to rooms already present in the CSV when none were supplied
  let rooms = options.rooms;
  if (!rooms || rooms.length === 0) {
    rooms = [...new Set(rows.map(row => row[options.roomColumn]).filter(Boolean))];
    if (rooms.length === 0) {
      throw new Error(`No rooms given and the "${options.roomColumn}" column is empty - pass --rooms or --rooms-file`);
    }
    console.log(`Using ${rooms.length} room(s) found in the CSV.`);
  }

  const { assignments, slotsPerRoom, slots } = assignSchedule(rows, {
    rooms,
    seed: options.seed,
    start: options.start,
    slotMinutes: options.slotMinutes,
    breakStart: options.breakStart,
    breakMinutes: options.breakMinutes
  });

  const scheduled = applySchedule(rows, assignments, {
    date: options.date,
    roomColumn: options.roomColumn
  });

  console.log('Schedule Events');
  console.log('===============');
  console.log(`CSV:        ${csvPath}`);
  console.log(`Rows:       ${rows.length}`);
  console.log(`Rooms:      ${rooms.length}`);
  console.log(`Seed:       ${options.seed}`);
  console.log(`Date:       ${options.date}`);
  console.log(`Slots/room: ${slotsPerRoom}  (${slots[0].start} - ${slots[slots.length - 1].end})`);
  if (options.breakStart) {
    console.log(`Break:      ${options.breakStart} for ${options.breakMinutes} min (kept clear)`);
  }
  console.log('');

  console.log('Talks per room:');
  const counts = summarizeByRoom(scheduled, options.roomColumn);
  [...counts.entries()].sort().forEach(([room, count]) => console.log(`  ${room}: ${count}`));
  console.log('');

  const output = formatCSV(headers, scheduled);

  if (options.dryRun) {
    console.log('Dry run - file not written. First few rows:\n');
    console.log(output.split('\n').slice(0, 6).join('\n'));
    return;
  }

  const outPath = path.resolve(options.out || csvPath);
  fs.writeFileSync(outPath, output);
  console.log(`Wrote ${rows.length} scheduled rows to ${outPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`\nError: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, applySchedule, summarizeByRoom, DEFAULTS };
