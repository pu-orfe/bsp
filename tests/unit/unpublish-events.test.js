const {
  parseArgs,
  isPublished,
  matchesType,
  selectPublishedEvents,
  collectAllContent,
  unpublishNode,
  unpublishAll,
  DEFAULT_TYPES,
  PUBLISHED_FIELD
} = require('../../examples/unpublish-events');

const API = 'http://localhost:3000';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

describe('unpublish-events - parseArgs', () => {
  test('defaults to a dry run over the default event types', () => {
    const options = parseArgs([]);
    expect(options.execute).toBe(false);
    expect(options.types).toEqual(DEFAULT_TYPES);
    expect(options.nodes).toBeNull();
  });

  test('--execute enables applying changes', () => {
    expect(parseArgs(['--execute']).execute).toBe(true);
  });

  test('--dry-run wins when it comes after --execute', () => {
    expect(parseArgs(['--execute', '--dry-run']).execute).toBe(false);
  });

  test('--type narrows to a single lowercased type', () => {
    expect(parseArgs(['--type', 'Events']).types).toEqual(['events']);
  });

  test('--nodes parses a comma-separated list of IDs', () => {
    expect(parseArgs(['--nodes', '12, 34,56']).nodes).toEqual([12, 34, 56]);
  });

  test('--nodes rejects a list with no numeric IDs', () => {
    expect(() => parseArgs(['--nodes', 'abc'])).toThrow(/at least one numeric node ID/);
  });

  test('--exclude parses a comma-separated list of IDs', () => {
    expect(parseArgs(['--exclude', '31, 42']).exclude).toEqual([31, 42]);
  });

  test('--exclude defaults to an empty list', () => {
    expect(parseArgs([]).exclude).toEqual([]);
  });

  test('--exclude rejects a list with no numeric IDs', () => {
    expect(() => parseArgs(['--exclude', 'none'])).toThrow(/at least one numeric node ID/);
  });

  test('--page-size is bounded to 1-100', () => {
    expect(parseArgs(['--page-size', '100']).pageSize).toBe(100);
    expect(() => parseArgs(['--page-size', '101'])).toThrow(/between 1 and 100/);
    expect(() => parseArgs(['--page-size', '0'])).toThrow(/between 1 and 100/);
  });

  test('--max rejects non-positive values', () => {
    expect(() => parseArgs(['--max', '0'])).toThrow(/positive integer/);
  });

  test('--delay accepts zero but rejects negatives', () => {
    expect(parseArgs(['--delay', '0']).delayMs).toBe(0);
    expect(() => parseArgs(['--delay', '-1'])).toThrow(/must be >= 0/);
  });

  test('--api strips a trailing slash', () => {
    expect(parseArgs(['--api', 'http://localhost:3001/']).apiBase).toBe('http://localhost:3001');
  });

  test('unknown arguments are rejected', () => {
    expect(() => parseArgs(['--unpublish-everything'])).toThrow(/Unknown argument/);
  });

  test('a flag missing its value is rejected', () => {
    expect(() => parseArgs(['--type'])).toThrow(/Missing value/);
  });
});

describe('unpublish-events - selection', () => {
  const listing = [
    { id: 1, title: 'Published Event', type: 'Events', status: 'Published' },
    { id: 2, title: 'Unpublished Event', type: 'Events', status: 'Unpublished' },
    { id: 3, title: 'Published Article', type: 'Article', status: 'Published' },
    { id: 4, title: 'Published Page', type: 'Basic page', status: 'Published' },
    { id: 5, title: 'Machine Name Event', type: 'ps_events', status: 'published' },
    { id: 6, title: 'Whitespace Type', type: '  Events  ', status: '  Published ' },
    { id: 7, title: 'Restricted Event', type: 'Event', status: 'Published Restricted', restricted: true },
    { id: 8, title: 'Restricted Unpublished Event', type: 'Event', status: 'Unpublished Restricted' }
  ];

  test('isPublished matches case-insensitively and ignores whitespace', () => {
    expect(isPublished({ status: 'Published' })).toBe(true);
    expect(isPublished({ status: ' published ' })).toBe(true);
    expect(isPublished({ status: 'Unpublished' })).toBe(false);
    expect(isPublished({})).toBe(false);
  });

  test('isPublished tolerates trailing status markers', () => {
    expect(isPublished({ status: 'Published Restricted' })).toBe(true);
    expect(isPublished({ status: 'PublishedRestricted' })).toBe(true);
  });

  test('isPublished never treats an unpublished marker as published', () => {
    expect(isPublished({ status: 'Unpublished Restricted' })).toBe(false);
    expect(isPublished({ status: 'UnpublishedRestricted' })).toBe(false);
  });

  test('matchesType compares against the configured type list', () => {
    expect(matchesType({ type: 'Events' }, DEFAULT_TYPES)).toBe(true);
    expect(matchesType({ type: 'Article' }, DEFAULT_TYPES)).toBe(false);
  });

  test('selects only published nodes of a matching type', () => {
    const selected = selectPublishedEvents(listing);
    expect(selected.map(item => item.id)).toEqual([1, 5, 6, 7]);
  });

  test('never selects an unpublished node', () => {
    const selected = selectPublishedEvents(listing);
    expect(selected.every(item => isPublished(item))).toBe(true);
  });

  test('never selects a non-event node', () => {
    const selected = selectPublishedEvents(listing);
    expect(selected.map(item => item.title)).not.toContain('Published Article');
    expect(selected.map(item => item.title)).not.toContain('Published Page');
  });

  test('honours a restricted node ID list', () => {
    const selected = selectPublishedEvents(listing, { nodes: [5, 3] });
    expect(selected.map(item => item.id)).toEqual([5]);
  });

  test('leaves excluded node IDs alone', () => {
    const selected = selectPublishedEvents(listing, { exclude: [1, 7] });
    expect(selected.map(item => item.id)).toEqual([5, 6]);
  });

  test('exclude wins over an explicit node list', () => {
    const selected = selectPublishedEvents(listing, { nodes: [1, 5], exclude: [1] });
    expect(selected.map(item => item.id)).toEqual([5]);
  });

  test('an empty exclude list changes nothing', () => {
    expect(selectPublishedEvents(listing, { exclude: [] }).map(item => item.id))
      .toEqual(selectPublishedEvents(listing).map(item => item.id));
  });

  test('honours a narrowed type list', () => {
    const selected = selectPublishedEvents(listing, { types: ['ps_events'] });
    expect(selected.map(item => item.id)).toEqual([5]);
  });

  test('skips rows without a usable node ID', () => {
    const selected = selectPublishedEvents([
      { id: null, title: 'No ID', type: 'Events', status: 'Published' },
      { title: 'Missing ID', type: 'Events', status: 'Published' }
    ]);
    expect(selected).toEqual([]);
  });

  test('de-duplicates repeated node IDs', () => {
    const selected = selectPublishedEvents([listing[0], listing[0]]);
    expect(selected).toHaveLength(1);
  });

  test('returns an empty list for an empty listing', () => {
    expect(selectPublishedEvents([])).toEqual([]);
  });
});

describe('unpublish-events - API interaction', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  describe('collectAllContent', () => {
    test('follows the pager until hasNextPage is false', async () => {
      fetchMock
        .mockReturnValueOnce(jsonResponse({
          success: true,
          content: [{ id: 1 }, { id: 2 }],
          pagination: { hasNextPage: true }
        }))
        .mockReturnValueOnce(jsonResponse({
          success: true,
          content: [{ id: 3 }],
          pagination: { hasNextPage: false }
        }));

      const items = await collectAllContent(API, { pageSize: 2 });
      expect(items.map(item => item.id)).toEqual([1, 2, 3]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/content?limit=2&page=1`);
      expect(fetchMock.mock.calls[1][0]).toBe(`${API}/content?limit=2&page=2`);
    });

    test('stops on an empty page even when the pager claims more', async () => {
      fetchMock.mockReturnValue(jsonResponse({
        success: true,
        content: [],
        pagination: { hasNextPage: true }
      }));

      const items = await collectAllContent(API);
      expect(items).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('respects the maxPages safety cap', async () => {
      fetchMock.mockReturnValue(jsonResponse({
        success: true,
        content: [{ id: 1 }],
        pagination: { hasNextPage: true }
      }));

      await collectAllContent(API, { maxPages: 3 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    test('throws when the listing endpoint reports failure', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: false, error: 'Not logged in' }));
      await expect(collectAllContent(API)).rejects.toThrow(/Not logged in/);
    });

    test('throws a helpful error on a non-JSON response', async () => {
      fetchMock.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 502,
        text: () => Promise.resolve('<html>Bad Gateway</html>')
      }));
      await expect(collectAllContent(API)).rejects.toThrow(/Non-JSON response/);
    });
  });

  describe('unpublishNode', () => {
    test('sends the published checkbox as 0', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({
        success: true,
        updatedFields: [{ field: PUBLISHED_FIELD, value: '0' }],
        skippedFields: [],
        redirectUrl: 'https://example.com/node/1'
      }));

      const result = await unpublishNode(API, 1);

      expect(result.success).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API}/content/1`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ [PUBLISHED_FIELD]: '0' });
    });

    test('fails when the endpoint reports an error', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: false, error: 'Edit page not reachable' }));
      const result = await unpublishNode(API, 1);
      expect(result).toEqual({ success: false, error: 'Edit page not reachable' });
    });

    test('fails when the published field was skipped rather than applied', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({
        success: true,
        updatedFields: [],
        skippedFields: [{ field: PUBLISHED_FIELD, reason: 'Field not found' }]
      }));

      const result = await unpublishNode(API, 1);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/was not applied/);
      expect(result.error).toMatch(/Field not found/);
    });

    test('fails when a different field was updated instead', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({
        success: true,
        updatedFields: [{ field: 'title', value: 'x' }],
        skippedFields: []
      }));

      const result = await unpublishNode(API, 1);
      expect(result.success).toBe(false);
    });
  });

  describe('unpublishAll', () => {
    const targets = [
      { id: 1, title: 'One' },
      { id: 2, title: 'Two' },
      { id: 3, title: 'Three' }
    ];

    test('processes every target and separates successes from failures', async () => {
      fetchMock
        .mockReturnValueOnce(jsonResponse({ success: true, updatedFields: [{ field: PUBLISHED_FIELD }] }))
        .mockReturnValueOnce(jsonResponse({ success: false, error: 'boom' }))
        .mockReturnValueOnce(jsonResponse({ success: true, updatedFields: [{ field: PUBLISHED_FIELD }] }));

      const results = await unpublishAll(API, targets, { delayMs: 0 });

      expect(results.succeeded.map(item => item.id)).toEqual([1, 3]);
      expect(results.failed).toEqual([{ id: 2, title: 'Two', error: 'boom' }]);
    });

    test('a thrown request error does not abort the remaining nodes', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockReturnValueOnce(jsonResponse({ success: true, updatedFields: [{ field: PUBLISHED_FIELD }] }))
        .mockReturnValueOnce(jsonResponse({ success: true, updatedFields: [{ field: PUBLISHED_FIELD }] }));

      const results = await unpublishAll(API, targets, { delayMs: 0 });

      expect(results.failed).toEqual([{ id: 1, title: 'One', error: 'socket hang up' }]);
      expect(results.succeeded.map(item => item.id)).toEqual([2, 3]);
    });

    test('handles an empty target list', async () => {
      const results = await unpublishAll(API, [], { delayMs: 0 });
      expect(results).toEqual({ succeeded: [], failed: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
