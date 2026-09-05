const {
  parseArgs,
  matchesLabel,
  selectBlocks,
  listBlocks,
  readBlock,
  stageBlockUpdate,
  saveLayout,
  discardLayout
} = require('../../examples/update-layout-blocks');

const API = 'http://localhost:3000';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) });
}

const BLOCKS = [
  { uuid: 'uuid-node-view', delta: 0, region: 'content', pluginId: 'ps_node_view', label: 'Content fields' },
  { uuid: 'uuid-001', delta: 2, region: 'content', pluginId: 'ps_events_list_conference', label: '001 - Sherrerd Hall' },
  { uuid: 'uuid-003', delta: 2, region: 'content', pluginId: 'ps_events_list_conference', label: '003 - Sherrerd Hall' },
  { uuid: 'uuid-other', delta: 2, region: 'content', pluginId: 'ps_events_list_teaser', label: 'Upcoming' }
];

describe('update-layout-blocks - parseArgs', () => {
  test('requires a numeric node ID', () => {
    expect(parseArgs(['--node', '1']).nodeId).toBe('1');
    expect(() => parseArgs(['--node', 'front'])).toThrow(/numeric node ID/);
  });

  test('defaults to a dry run', () => {
    expect(parseArgs(['--node', '1']).execute).toBe(false);
  });

  test('pairs --field with the --value that follows it', () => {
    const options = parseArgs(['--node', '1', '--field', 'settings[label]', '--value', 'New']);
    expect(options.updates).toEqual({ 'settings[label]': 'New' });
  });

  test('collects several field/value pairs', () => {
    const options = parseArgs([
      '--node', '1',
      '--field', 'settings[label]', '--value', 'New',
      '--field', 'settings[ps_core_description][value]', '--value', '<p>x</p>'
    ]);
    expect(options.updates).toEqual({
      'settings[label]': 'New',
      'settings[ps_core_description][value]': '<p>x</p>'
    });
  });

  test('a trailing --field with no value becomes an inspect request', () => {
    const options = parseArgs(['--node', '1', '--field', 'settings[label]']);
    expect(options.updates).toEqual({});
    expect(options.inspectField).toBe('settings[label]');
  });

  test('--value without a preceding --field is rejected', () => {
    expect(() => parseArgs(['--node', '1', '--value', 'orphan'])).toThrow(/must follow a --field/);
  });

  test('parses the block filters', () => {
    const options = parseArgs([
      '--node', '1',
      '--plugin', 'ps_events_list_conference',
      '--label', 'Sherrerd Hall',
      '--uuids', 'a, b'
    ]);
    expect(options.plugin).toBe('ps_events_list_conference');
    expect(options.label).toBe('Sherrerd Hall');
    expect(options.uuids).toEqual(['a', 'b']);
  });

  test('--keep-staged is off unless asked for', () => {
    expect(parseArgs(['--node', '1']).keepStaged).toBe(false);
    expect(parseArgs(['--node', '1', '--keep-staged']).keepStaged).toBe(true);
  });

  test('unknown arguments are rejected', () => {
    expect(() => parseArgs(['--node', '1', '--wipe'])).toThrow(/Unknown argument/);
  });
});

describe('update-layout-blocks - matchesLabel', () => {
  test('no filter matches everything', () => {
    expect(matchesLabel('001 - Sherrerd Hall', null)).toBe(true);
    expect(matchesLabel('001 - Sherrerd Hall', '')).toBe(true);
  });

  test('matches a substring', () => {
    expect(matchesLabel('001 - Sherrerd Hall', 'Sherrerd')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(matchesLabel('001 - Sherrerd Hall', 'sherrerd hall')).toBe(true);
  });

  test('does not match unrelated text', () => {
    expect(matchesLabel('001 - Sherrerd Hall', 'Fisher')).toBe(false);
  });

  test('tolerates a missing label', () => {
    expect(matchesLabel(null, 'x')).toBe(false);
    expect(matchesLabel(undefined, 'x')).toBe(false);
  });

  test('regex metacharacters are treated literally, not compiled', () => {
    // Would match everything if the filter were used as a pattern
    expect(matchesLabel('001 - Sherrerd Hall', '.*')).toBe(false);
    expect(matchesLabel('001 - Sherrerd Hall', '^001')).toBe(false);
    expect(matchesLabel('a.*b', '.*')).toBe(true);
  });

  test('a pathological pattern cannot cause backtracking', () => {
    const evil = '(a+)+$';
    expect(matchesLabel('a'.repeat(50), evil)).toBe(false);
  });
});

describe('update-layout-blocks - selectBlocks', () => {
  test('with no filters every block matches', () => {
    expect(selectBlocks(BLOCKS, {})).toHaveLength(4);
  });

  test('filters by block plugin ID', () => {
    const selected = selectBlocks(BLOCKS, { plugin: 'ps_events_list_conference' });
    expect(selected.map(block => block.uuid)).toEqual(['uuid-001', 'uuid-003']);
  });

  test('a plugin filter excludes near-miss plugin IDs', () => {
    const selected = selectBlocks(BLOCKS, { plugin: 'ps_events_list_conference' });
    expect(selected.map(block => block.pluginId)).not.toContain('ps_events_list_teaser');
  });

  test('filters by label text', () => {
    const selected = selectBlocks(BLOCKS, { label: 'Sherrerd Hall' });
    expect(selected.map(block => block.uuid)).toEqual(['uuid-001', 'uuid-003']);
  });

  test('combines plugin and label filters', () => {
    const selected = selectBlocks(BLOCKS, { plugin: 'ps_events_list_conference', label: '001' });
    expect(selected.map(block => block.uuid)).toEqual(['uuid-001']);
  });

  test('filters by explicit UUID list', () => {
    const selected = selectBlocks(BLOCKS, { uuids: ['uuid-003'] });
    expect(selected.map(block => block.uuid)).toEqual(['uuid-003']);
  });

  test('tolerates blocks with no label', () => {
    const selected = selectBlocks([{ uuid: 'x', pluginId: 'p', label: null }], { label: 'anything' });
    expect(selected).toEqual([]);
  });

  test('returns an empty list when nothing matches', () => {
    expect(selectBlocks(BLOCKS, { plugin: 'does_not_exist' })).toEqual([]);
  });

  test('a label filter of regex syntax matches nothing rather than throwing', () => {
    expect(selectBlocks(BLOCKS, { label: '[unclosed' })).toEqual([]);
  });
});

describe('update-layout-blocks - API interaction', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
  });

  describe('listBlocks', () => {
    test('returns the block list', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: true, blocks: BLOCKS }));
      await expect(listBlocks(API, 1)).resolves.toHaveLength(4);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/layout/1/blocks`);
    });

    test('throws when the endpoint reports failure', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: false, error: 'no layout' }));
      await expect(listBlocks(API, 1)).rejects.toThrow(/no layout/);
    });
  });

  describe('readBlock', () => {
    test('addresses the block by delta, region and uuid', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: true, block: { data: {} } }));
      await readBlock(API, 1, BLOCKS[1]);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/layout/1/block/2/content/uuid-001`);
    });
  });

  describe('stageBlockUpdate', () => {
    test('PUTs the field map to the block endpoint', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({
        success: true,
        updatedFields: [{ field: 'settings[label]', value: 'New' }]
      }));

      const result = await stageBlockUpdate(API, 1, BLOCKS[1], { 'settings[label]': 'New' });

      expect(result.success).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${API}/layout/1/block/2/content/uuid-001`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ 'settings[label]': 'New' });
    });

    test('fails when a requested field was not applied', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({
        success: true,
        updatedFields: [],
        skippedFields: [{ field: 'settings[label]', reason: 'Field not found' }]
      }));

      const result = await stageBlockUpdate(API, 1, BLOCKS[1], { 'settings[label]': 'New' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Fields not applied: settings\[label\]/);
    });

    test('fails when only some of several fields applied', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({
        success: true,
        updatedFields: [{ field: 'settings[label]', value: 'New' }],
        skippedFields: [{ field: 'settings[other]', reason: 'Field not found' }]
      }));

      const result = await stageBlockUpdate(API, 1, BLOCKS[1], {
        'settings[label]': 'New',
        'settings[other]': 'x'
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/settings\[other\]/);
    });

    test('propagates an endpoint-level error', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: false, error: 'block gone' }));
      const result = await stageBlockUpdate(API, 1, BLOCKS[1], { 'settings[label]': 'New' });
      expect(result).toEqual({ success: false, error: 'block gone' });
    });
  });

  describe('saveLayout / discardLayout', () => {
    test('saveLayout POSTs to the save endpoint', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: true }));
      await saveLayout(API, 1);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/layout/1/save`);
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    });

    test('discardLayout POSTs to the discard endpoint', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: true }));
      await discardLayout(API, 1);
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/layout/1/discard`);
    });
  });
});
