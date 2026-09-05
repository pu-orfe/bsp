/**
 * Deterministic slot scheduling for room-based event grids.
 *
 * Builds a grid of (room x time slot) positions, optionally skipping a break
 * window, then assigns items to positions using a seeded shuffle. The same seed
 * and the same inputs always produce the same schedule, so a re-run does not
 * reshuffle everyone.
 */

/**
 * mulberry32 - a small, fast, seedable PRNG.
 * Math.random() cannot be seeded, and reproducibility is the whole point here.
 *
 * @param {number} seed - 32-bit integer seed
 * @returns {function(): number} Generator producing floats in [0, 1)
 */
function createRandom(seed) {
  let state = seed >>> 0;

  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffle driven by a supplied generator. Returns a new array.
 */
function shuffle(items, random) {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

/**
 * Parse "9:00 AM" / "09:00 am" into minutes since midnight.
 */
function parseTime(text) {
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
  if (!match) {
    throw new Error(`Could not parse time: "${text}" (expected a format like "9:00 AM")`);
  }

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const isPM = match[3].toLowerCase() === 'p';

  if (hours < 1 || hours > 12 || minutes > 59) {
    throw new Error(`Time out of range: "${text}"`);
  }

  if (hours === 12) hours = 0;
  if (isPM) hours += 12;

  return hours * 60 + minutes;
}

/**
 * Format minutes since midnight as "HH:MM AM/PM", the shape Drupal expects.
 */
function formatTime(totalMinutes) {
  const minutesInDay = ((totalMinutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(minutesInDay / 60);
  const minutes = minutesInDay % 60;

  const period = hours24 < 12 ? 'AM' : 'PM';
  let hours12 = hours24 % 12;
  if (hours12 === 0) hours12 = 12;

  return `${String(hours12).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${period}`;
}

/**
 * Build a list of consecutive time slots, skipping a break window.
 *
 * @param {Object} options
 * @param {string} options.start - First slot start, e.g. "9:00 AM"
 * @param {number} options.slotMinutes - Slot length
 * @param {number} options.count - How many slots to produce
 * @param {string} [options.breakStart] - Start of a window no slot may occupy
 * @param {number} [options.breakMinutes] - Length of that window
 * @returns {Array<{start: string, end: string}>}
 */
function buildSlots({ start, slotMinutes, count, breakStart = null, breakMinutes = 0 }) {
  if (!Number.isInteger(slotMinutes) || slotMinutes < 1) {
    throw new Error('slotMinutes must be a positive integer');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('count must be a non-negative integer');
  }

  const breakFrom = breakStart ? parseTime(breakStart) : null;
  const breakTo = breakFrom === null ? null : breakFrom + breakMinutes;

  const slots = [];
  let cursor = parseTime(start);

  while (slots.length < count) {
    // A slot may not start inside, or run across, the break window
    if (breakFrom !== null && cursor < breakTo && cursor + slotMinutes > breakFrom) {
      cursor = breakTo;
      continue;
    }

    slots.push({ start: formatTime(cursor), end: formatTime(cursor + slotMinutes) });
    cursor += slotMinutes;
  }

  return slots;
}

/**
 * Build grid positions ordered so rooms fill evenly.
 *
 * Positions advance across all rooms before moving to the next time slot, so
 * taking the first N positions spreads N items as evenly as the grid allows and
 * never leaves a hole in the middle of a room's day.
 *
 * @returns {Array<{room: *, slotIndex: number, start: string, end: string}>}
 */
function buildPositions(rooms, slots) {
  const positions = [];

  slots.forEach((slot, slotIndex) => {
    rooms.forEach(room => {
      positions.push({ room, slotIndex, start: slot.start, end: slot.end });
    });
  });

  return positions;
}

/**
 * Assign items to a room/slot grid with a seeded shuffle.
 *
 * @param {Array} items - Things to schedule (e.g. CSV rows)
 * @param {Object} options
 * @param {Array} options.rooms - Room identifiers
 * @param {number} options.seed - Fixed seed for reproducibility
 * @param {string} options.start - First slot start time
 * @param {number} options.slotMinutes - Slot length
 * @param {string} [options.breakStart] - Break window start
 * @param {number} [options.breakMinutes] - Break window length
 * @returns {{assignments: Array, slotsPerRoom: number, slots: Array}}
 */
function assignSchedule(items, { rooms, seed, start, slotMinutes, breakStart = null, breakMinutes = 0 }) {
  if (!Array.isArray(rooms) || rooms.length === 0) {
    throw new Error('At least one room is required');
  }

  if (items.length === 0) {
    return { assignments: [], slotsPerRoom: 0, slots: [] };
  }

  const random = createRandom(seed);

  // Shuffle the rooms too, so the rooms that pick up an extra slot are not
  // always the first ones in the list.
  const shuffledRooms = shuffle(rooms, random);
  const shuffledItems = shuffle(items, random);

  const slotsPerRoom = Math.ceil(items.length / rooms.length);
  const slots = buildSlots({ start, slotMinutes, count: slotsPerRoom, breakStart, breakMinutes });
  const positions = buildPositions(shuffledRooms, slots);

  const assignments = shuffledItems.map((item, index) => {
    const position = positions[index];
    return {
      item,
      room: position.room,
      start: position.start,
      end: position.end
    };
  });

  return { assignments, slotsPerRoom, slots };
}

module.exports = {
  createRandom,
  shuffle,
  parseTime,
  formatTime,
  buildSlots,
  buildPositions,
  assignSchedule
};
