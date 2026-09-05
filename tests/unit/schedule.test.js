const {
  createRandom,
  shuffle,
  parseTime,
  formatTime,
  buildSlots,
  buildPositions,
  assignSchedule
} = require('../../src/schedule');

describe('schedule - createRandom', () => {
  test('the same seed always produces the same sequence', () => {
    const a = createRandom(20270430);
    const b = createRandom(20270430);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  test('different seeds produce different sequences', () => {
    const a = Array.from({ length: 5 }, createRandom(1));
    const b = Array.from({ length: 5 }, createRandom(2));
    expect(a).not.toEqual(b);
  });

  test('values stay within [0, 1)', () => {
    const random = createRandom(7);
    for (let i = 0; i < 500; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('schedule - shuffle', () => {
  test('is reproducible for a given seed', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffle(items, createRandom(42))).toEqual(shuffle(items, createRandom(42)));
  });

  test('preserves every element exactly once', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const result = shuffle(items, createRandom(3));
    expect(result.sort((a, b) => a - b)).toEqual(items);
  });

  test('does not mutate the input array', () => {
    const items = [1, 2, 3];
    shuffle(items, createRandom(1));
    expect(items).toEqual([1, 2, 3]);
  });

  test('handles empty and single-element arrays', () => {
    expect(shuffle([], createRandom(1))).toEqual([]);
    expect(shuffle(['x'], createRandom(1))).toEqual(['x']);
  });
});

describe('schedule - time helpers', () => {
  test.each([
    ['9:00 AM', 540],
    ['09:00 AM', 540],
    ['12:00 PM', 720],
    ['12:30 PM', 750],
    ['12:00 AM', 0],
    ['11:45 am', 705],
    ['1:05 p.m.', 785]
  ])('parseTime(%s) is %i minutes', (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });

  test('rejects unparseable times', () => {
    expect(() => parseTime('noon')).toThrow(/Could not parse time/);
    expect(() => parseTime('25:00 AM')).toThrow();
    expect(() => parseTime('9:70 AM')).toThrow();
  });

  test.each([
    [540, '09:00 AM'],
    [720, '12:00 PM'],
    [750, '12:30 PM'],
    [0, '12:00 AM'],
    [780, '01:00 PM']
  ])('formatTime(%i) is %s', (input, expected) => {
    expect(formatTime(input)).toBe(expected);
  });

  test('parseTime and formatTime round-trip', () => {
    ['09:00 AM', '12:15 PM', '11:45 AM'].forEach(time => {
      expect(formatTime(parseTime(time))).toBe(time);
    });
  });
});

describe('schedule - buildSlots', () => {
  test('produces consecutive slots', () => {
    const slots = buildSlots({ start: '9:00 AM', slotMinutes: 15, count: 3 });
    expect(slots).toEqual([
      { start: '09:00 AM', end: '09:15 AM' },
      { start: '09:15 AM', end: '09:30 AM' },
      { start: '09:30 AM', end: '09:45 AM' }
    ]);
  });

  test('keeps the break window clear', () => {
    const slots = buildSlots({
      start: '9:00 AM', slotMinutes: 15, count: 7,
      breakStart: '10:15 AM', breakMinutes: 30
    });
    const starts = slots.map(slot => slot.start);
    expect(starts).toContain('10:00 AM');
    expect(starts).toContain('10:45 AM');
    expect(starts).not.toContain('10:15 AM');
    expect(starts).not.toContain('10:30 AM');
  });

  test('no slot overlaps the break window', () => {
    const slots = buildSlots({
      start: '9:00 AM', slotMinutes: 20, count: 8,
      breakStart: '10:00 AM', breakMinutes: 30
    });
    slots.forEach(slot => {
      const start = parseTime(slot.start);
      const end = parseTime(slot.end);
      expect(start >= 630 || end <= 600).toBe(true);
    });
  });

  test('reproduces the symposium grid: 12 slots ending 12:30 PM', () => {
    const slots = buildSlots({
      start: '9:00 AM', slotMinutes: 15, count: 12,
      breakStart: '10:15 AM', breakMinutes: 30
    });
    expect(slots).toHaveLength(12);
    expect(slots[0].start).toBe('09:00 AM');
    expect(slots[4].end).toBe('10:15 AM');
    expect(slots[5].start).toBe('10:45 AM');
    expect(slots[11].end).toBe('12:30 PM');
  });

  test('crosses noon correctly', () => {
    const slots = buildSlots({ start: '11:45 AM', slotMinutes: 15, count: 2 });
    expect(slots[1]).toEqual({ start: '12:00 PM', end: '12:15 PM' });
  });

  test('rejects invalid slot lengths', () => {
    expect(() => buildSlots({ start: '9:00 AM', slotMinutes: 0, count: 1 })).toThrow();
  });

  test('a count of zero yields no slots', () => {
    expect(buildSlots({ start: '9:00 AM', slotMinutes: 15, count: 0 })).toEqual([]);
  });
});

describe('schedule - buildPositions', () => {
  test('advances across rooms before moving to the next slot', () => {
    const positions = buildPositions(['R1', 'R2'], [
      { start: '9:00 AM', end: '9:15 AM' },
      { start: '9:15 AM', end: '9:30 AM' }
    ]);
    expect(positions.map(p => `${p.room}@${p.start}`)).toEqual([
      'R1@9:00 AM', 'R2@9:00 AM', 'R1@9:15 AM', 'R2@9:15 AM'
    ]);
  });
});

describe('schedule - assignSchedule', () => {
  const rooms = ['001', '003', '008', '101', '107', '110', '123', '125'];
  const items = Array.from({ length: 90 }, (_, i) => ({ name: `Student ${i + 1}` }));
  const config = {
    rooms, seed: 20270430, start: '9:00 AM', slotMinutes: 15,
    breakStart: '10:15 AM', breakMinutes: 30
  };

  test('assigns every item exactly once', () => {
    const { assignments } = assignSchedule(items, config);
    expect(assignments).toHaveLength(90);
    expect(new Set(assignments.map(a => a.item))).toEqual(new Set(items));
  });

  test('never double-books a room and time', () => {
    const { assignments } = assignSchedule(items, config);
    const keys = assignments.map(a => `${a.room}@${a.start}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('computes the slots each room needs', () => {
    const { slotsPerRoom } = assignSchedule(items, config);
    expect(slotsPerRoom).toBe(12); // ceil(90 / 8)
  });

  test('spreads rooms as evenly as the numbers allow', () => {
    const { assignments } = assignSchedule(items, config);
    const counts = new Map();
    assignments.forEach(a => counts.set(a.room, (counts.get(a.room) || 0) + 1));

    const values = [...counts.values()];
    expect(values).toHaveLength(8);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    expect(values.reduce((sum, n) => sum + n, 0)).toBe(90);
  });

  test('leaves no gap in the middle of a room day', () => {
    const { assignments, slots } = assignSchedule(items, config);
    const order = new Map(slots.map((slot, index) => [slot.start, index]));

    const byRoom = new Map();
    assignments.forEach(a => {
      if (!byRoom.has(a.room)) byRoom.set(a.room, []);
      byRoom.get(a.room).push(order.get(a.start));
    });

    byRoom.forEach(indices => {
      const sorted = [...indices].sort((a, b) => a - b);
      // A contiguous run starting at the first slot
      expect(sorted).toEqual(sorted.map((_, i) => i));
    });
  });

  test('keeps every assignment out of the break window', () => {
    const { assignments } = assignSchedule(items, config);
    assignments.forEach(a => {
      expect(a.start).not.toBe('10:15 AM');
      expect(a.start).not.toBe('10:30 AM');
    });
  });

  test('is reproducible for the same seed', () => {
    const first = assignSchedule(items, config).assignments.map(a => `${a.item.name}|${a.room}|${a.start}`);
    const second = assignSchedule(items, config).assignments.map(a => `${a.item.name}|${a.room}|${a.start}`);
    expect(first).toEqual(second);
  });

  test('a different seed produces a different assignment', () => {
    const first = assignSchedule(items, config).assignments.map(a => `${a.item.name}|${a.room}`);
    const second = assignSchedule(items, { ...config, seed: 1 }).assignments.map(a => `${a.item.name}|${a.room}`);
    expect(first).not.toEqual(second);
  });

  test('handles an exact fit with no remainder', () => {
    const exact = Array.from({ length: 16 }, (_, i) => ({ i }));
    const { assignments, slotsPerRoom } = assignSchedule(exact, { ...config, rooms: ['A', 'B'] });
    expect(slotsPerRoom).toBe(8);
    expect(assignments).toHaveLength(16);
  });

  test('handles fewer items than rooms', () => {
    const { assignments, slotsPerRoom } = assignSchedule([{ i: 1 }, { i: 2 }], config);
    expect(slotsPerRoom).toBe(1);
    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map(a => a.room)).size).toBe(2);
  });

  test('returns nothing for an empty item list', () => {
    expect(assignSchedule([], config)).toEqual({ assignments: [], slotsPerRoom: 0, slots: [] });
  });

  test('requires at least one room', () => {
    expect(() => assignSchedule(items, { ...config, rooms: [] })).toThrow(/at least one room/i);
  });
});
