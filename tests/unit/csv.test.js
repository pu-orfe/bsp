const { parseCSV, formatCSV, escapeField } = require('../../src/csv');

describe('csv - parseCSV', () => {
  test('parses a simple table into row objects', () => {
    const { headers, rows } = parseCSV('A,B\n1,2\n3,4\n');
    expect(headers).toEqual(['A', 'B']);
    expect(rows).toEqual([{ A: '1', B: '2' }, { A: '3', B: '4' }]);
  });

  test('keeps commas inside quoted fields', () => {
    const { rows } = parseCSV('A,B\n1,"x,y"\n');
    expect(rows[0].B).toBe('x,y');
  });

  test('unescapes doubled quotes', () => {
    const { rows } = parseCSV('A\n"he said ""hi"""\n');
    expect(rows[0].A).toBe('he said "hi"');
  });

  test('keeps newlines inside quoted fields', () => {
    const { rows } = parseCSV('A,B\n1,"line1\nline2"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].B).toBe('line1\nline2');
  });

  test('strips a UTF-8 BOM', () => {
    const { headers } = parseCSV('﻿A,B\n1,2\n');
    expect(headers).toEqual(['A', 'B']);
  });

  test('handles CRLF line endings', () => {
    const { rows } = parseCSV('A,B\r\n1,2\r\n');
    expect(rows).toEqual([{ A: '1', B: '2' }]);
  });

  test('handles a final row with no trailing newline', () => {
    const { rows } = parseCSV('A,B\n1,2');
    expect(rows).toEqual([{ A: '1', B: '2' }]);
  });

  test('trims surrounding whitespace in headers and values', () => {
    const { headers, rows } = parseCSV(' A , B \n 1 , 2 \n');
    expect(headers).toEqual(['A', 'B']);
    expect(rows[0]).toEqual({ A: '1', B: '2' });
  });

  test('fills missing trailing columns with empty strings', () => {
    const { rows } = parseCSV('A,B,C\n1,2\n');
    expect(rows[0]).toEqual({ A: '1', B: '2', C: '' });
  });

  test('keeps empty fields empty', () => {
    const { rows } = parseCSV('A,B,C\n1,,3\n');
    expect(rows[0]).toEqual({ A: '1', B: '', C: '3' });
  });

  test('drops trailing blank lines', () => {
    const { rows } = parseCSV('A,B\n1,2\n\n\n');
    expect(rows).toHaveLength(1);
  });

  test('returns empty structures for empty input', () => {
    expect(parseCSV('')).toEqual({ headers: [], rows: [] });
  });

  test('a header-only file has no rows', () => {
    expect(parseCSV('A,B\n').rows).toEqual([]);
  });
});

describe('csv - formatCSV', () => {
  test('writes headers and rows', () => {
    expect(formatCSV(['A', 'B'], [{ A: '1', B: '2' }])).toBe('A,B\n1,2\n');
  });

  test('quotes fields containing a comma', () => {
    expect(formatCSV(['A'], [{ A: 'x,y' }])).toBe('A\n"x,y"\n');
  });

  test('escapes embedded quotes', () => {
    expect(formatCSV(['A'], [{ A: 'he said "hi"' }])).toBe('A\n"he said ""hi"""\n');
  });

  test('renders missing keys as empty fields', () => {
    expect(formatCSV(['A', 'B'], [{ A: '1' }])).toBe('A,B\n1,\n');
  });

  test('round-trips awkward content', () => {
    const headers = ['Name', 'Note'];
    const rows = [{ Name: 'Bou Alia, Leen', Note: 'said "yes"\nthen left' }];
    const reparsed = parseCSV(formatCSV(headers, rows));
    expect(reparsed.rows[0]).toEqual(rows[0]);
  });
});

describe('csv - escapeField', () => {
  test('leaves plain values untouched', () => {
    expect(escapeField('plain')).toBe('plain');
  });

  test('renders null and undefined as empty', () => {
    expect(escapeField(null)).toBe('');
    expect(escapeField(undefined)).toBe('');
  });

  test('quotes values with newlines', () => {
    expect(escapeField('a\nb')).toBe('"a\nb"');
  });
});
