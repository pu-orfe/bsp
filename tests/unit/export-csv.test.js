const { parseArgs, filterRows, buildRows, collectContent, DEFAULT_COLUMNS } = require('../../examples/export-csv');

const API = 'http://localhost:3000';

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
}

const ITEMS = [
  { id: 1, title: 'Talk A', type: 'Event', status: 'Published', author: 'bino' },
  { id: 2, title: 'Talk B', type: 'Event', status: 'Unpublished', author: 'bino' },
  { id: 3, title: 'A Page', type: 'Page', status: 'Published', author: 'cdreyer' },
  { id: 4, title: 'Talk C', type: 'Event', status: 'Published Restricted', author: 'bino' }
];

describe('export-csv - parseArgs', () => {
  test('defaults to the standard listing columns and stdout', () => {
    const options = parseArgs([]);
    expect(options.columns).toEqual(DEFAULT_COLUMNS);
    expect(options.out).toBeNull();
    expect(options.fields).toEqual([]);
  });

  test('parses filters', () => {
    const options = parseArgs(['--type', 'Event', '--status', 'Published']);
    expect(options).toMatchObject({ type: 'Event', status: 'Published' });
  });

  test('--columns replaces the default list', () => {
    expect(parseArgs(['--columns', 'id, title']).columns).toEqual(['id', 'title']);
  });

  test('--columns rejects an empty list', () => {
    expect(() => parseArgs(['--columns', ' , '])).toThrow(/at least one column/);
  });

  test('--field maps a form field to a column name', () => {
    const options = parseArgs(['--field', 'field_x[0][value]=Talk Title']);
    expect(options.fields).toEqual([{ field: 'field_x[0][value]', column: 'Talk Title' }]);
  });

  test('--field is repeatable', () => {
    const options = parseArgs(['--field', 'a=A', '--field', 'b=B']);
    expect(options.fields).toHaveLength(2);
  });

  test('--field rejects a malformed pair', () => {
    expect(() => parseArgs(['--field', 'nope'])).toThrow(/expects formField=ColumnName/);
  });

  test('--page-size is bounded', () => {
    expect(parseArgs(['--page-size', '100']).pageSize).toBe(100);
    expect(() => parseArgs(['--page-size', '101'])).toThrow(/between 1 and 100/);
  });

  test('unknown flags are rejected', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown argument/);
  });
});

describe('export-csv - filterRows', () => {
  test('no filters keeps everything', () => {
    expect(filterRows(ITEMS, {})).toHaveLength(4);
  });

  test('filters by type, case-insensitively', () => {
    expect(filterRows(ITEMS, { type: 'event' }).map(i => i.id)).toEqual([1, 2, 4]);
  });

  test('filters by status', () => {
    expect(filterRows(ITEMS, { status: 'Published' }).map(i => i.id)).toEqual([1, 3, 4]);
  });

  test('a published filter does not match Unpublished', () => {
    const result = filterRows(ITEMS, { status: 'published' });
    expect(result.map(i => i.id)).not.toContain(2);
  });

  test('a published filter matches trailing status markers', () => {
    expect(filterRows(ITEMS, { status: 'published' }).map(i => i.id)).toContain(4);
  });

  test('filters by unpublished', () => {
    expect(filterRows(ITEMS, { status: 'unpublished' }).map(i => i.id)).toEqual([2]);
  });

  test('combines type and status', () => {
    expect(filterRows(ITEMS, { type: 'Event', status: 'Published' }).map(i => i.id)).toEqual([1, 4]);
  });
});

describe('export-csv - buildRows', () => {
  test('projects the requested listing columns', () => {
    const rows = buildRows([ITEMS[0]], ['id', 'title']);
    expect(rows).toEqual([{ id: '1', title: 'Talk A' }]);
  });

  test('renders missing values as empty strings', () => {
    const rows = buildRows([{ id: 1 }], ['id', 'title']);
    expect(rows[0].title).toBe('');
  });

  test('adds detail fields under their column names', () => {
    const detail = new Map([[1, { 'field_x[0][value]': 'On Queues' }]]);
    const rows = buildRows([ITEMS[0]], ['id'], [{ field: 'field_x[0][value]', column: 'Talk Title' }], detail);
    expect(rows[0]).toEqual({ id: '1', 'Talk Title': 'On Queues' });
  });

  test('leaves a detail column blank when the node had no detail', () => {
    const rows = buildRows([ITEMS[0]], ['id'], [{ field: 'f', column: 'F' }], new Map());
    expect(rows[0].F).toBe('');
  });
});

describe('export-csv - collectContent', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  test('pages until the pager runs out and applies filters', async () => {
    fetchMock
      .mockReturnValueOnce(jsonResponse({ success: true, content: ITEMS.slice(0, 2), pagination: { hasNextPage: true } }))
      .mockReturnValueOnce(jsonResponse({ success: true, content: ITEMS.slice(2), pagination: { hasNextPage: false } }));

    const result = await collectContent(API, { pageSize: 2, type: 'Event', status: null, limit: null });
    expect(result.map(i => i.id)).toEqual([1, 2, 4]);
  });

  test('stops once the limit is reached', async () => {
    fetchMock.mockReturnValue(jsonResponse({ success: true, content: ITEMS, pagination: { hasNextPage: true } }));

    const result = await collectContent(API, { pageSize: 50, type: null, status: null, limit: 2 });
    expect(result).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('throws when the listing fails', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ success: false, error: 'not logged in' }));
    await expect(collectContent(API, { pageSize: 50, type: null, status: null, limit: null }))
      .rejects.toThrow(/not logged in/);
  });

  test('stops on an empty page', async () => {
    fetchMock.mockReturnValue(jsonResponse({ success: true, content: [], pagination: { hasNextPage: true } }));
    const result = await collectContent(API, { pageSize: 50, type: null, status: null, limit: null });
    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
