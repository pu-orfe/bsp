const {
  parseArgs,
  buildMapping,
  findMissingColumns,
  createNode
} = require('../../examples/import-csv');

const {
  parseArgs: parseScheduleArgs,
  applySchedule,
  summarizeByRoom
} = require('../../examples/schedule-events');

describe('import-csv - parseArgs', () => {
  test('defaults to a dry run that leaves status to the mapping', () => {
    const options = parseArgs([]);
    expect(options.execute).toBe(false);
    expect(options.published).toBeNull();
  });

  test('--unpublished and --published set the status', () => {
    expect(parseArgs(['--unpublished']).published).toBe(false);
    expect(parseArgs(['--published']).published).toBe(true);
    expect(parseArgs(['--unpublished', '--published']).published).toBe(true);
  });

  test('--set collects field overrides', () => {
    const options = parseArgs(['--set', 'subtitle={Talk Title|TBD}', '--set', 'field_room={Room}']);
    expect(options.overrides).toEqual({
      subtitle: '{Talk Title|TBD}',
      field_room: '{Room}'
    });
  });

  test('--set keeps equals signs that appear inside the template', () => {
    expect(parseArgs(['--set', 'body=<p>a=b</p>']).overrides.body).toBe('<p>a=b</p>');
  });

  test('--set rejects a malformed pair', () => {
    expect(() => parseArgs(['--set', 'noequals'])).toThrow(/expects field=template/);
  });

  test('--limit and --skip are validated', () => {
    expect(parseArgs(['--limit', '5']).limit).toBe(5);
    expect(parseArgs(['--skip', '3']).skip).toBe(3);
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--skip', '-1'])).toThrow(/>= 0/);
  });

  test('a bare path is taken as the CSV', () => {
    expect(parseArgs(['/tmp/roster.csv']).csv).toBe('/tmp/roster.csv');
  });

  test('unknown flags are rejected', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});

describe('import-csv - buildMapping', () => {
  const mapPath = require('path').join(__dirname, '..', '..', 'examples', 'mappings', 'ps-events-symposium.json');

  test('loads a mapping file', () => {
    const mapping = buildMapping({ map: mapPath, overrides: {}, published: null, contentType: null });
    expect(mapping.contentType).toBe('ps_events');
    expect(mapping.fields.title).toBeDefined();
  });

  test('--set overrides a mapped field', () => {
    const mapping = buildMapping({
      map: mapPath, overrides: { subtitle: '{Custom}' }, published: null, contentType: null
    });
    expect(mapping.fields.subtitle).toBe('{Custom}');
  });

  test('--set can add a field the mapping never had', () => {
    const mapping = buildMapping({
      map: mapPath, overrides: { field_new: '{X}' }, published: null, contentType: null
    });
    expect(mapping.fields.field_new).toBe('{X}');
  });

  test('the published flag becomes a literal status field', () => {
    const mapping = buildMapping({ map: mapPath, overrides: {}, published: false, contentType: null });
    expect(mapping.fields.status).toEqual({ value: false });
  });

  test('--type overrides the mapping content type', () => {
    const mapping = buildMapping({ map: mapPath, overrides: {}, published: null, contentType: 'article' });
    expect(mapping.contentType).toBe('article');
  });

  test('a mapping built purely from --set works without a file', () => {
    const mapping = buildMapping({
      map: null, overrides: { title: '{Name}' }, published: null, contentType: 'article'
    });
    expect(mapping.fields.title).toBe('{Name}');
  });

  test('rejects a mapping with no content type', () => {
    expect(() => buildMapping({ map: null, overrides: { title: '{N}' }, published: null, contentType: null }))
      .toThrow(/No content type given/);
  });

  test('does not mutate the mapping file on disk', () => {
    buildMapping({ map: mapPath, overrides: { subtitle: '{X}' }, published: false, contentType: null });
    const reloaded = JSON.parse(require('fs').readFileSync(mapPath, 'utf-8'));
    expect(reloaded.fields.subtitle).toBe('{Talk Title|TBD}');
    expect(reloaded.fields.status).toBeUndefined();
  });
});

describe('import-csv - findMissingColumns', () => {
  const mapping = { fields: { title: '{First} {Last}', sub: '{Talk Title|TBD}' } };

  test('reports columns the CSV lacks', () => {
    expect(findMissingColumns(mapping, ['First'])).toEqual(['Last', 'Talk Title']);
  });

  test('returns nothing when the CSV has every column', () => {
    expect(findMissingColumns(mapping, ['First', 'Last', 'Talk Title'])).toEqual([]);
  });

  test('extra CSV columns are fine', () => {
    expect(findMissingColumns(mapping, ['First', 'Last', 'Talk Title', 'Spare'])).toEqual([]);
  });
});

describe('import-csv - createNode', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => { delete global.fetch; });

  const respond = body => Promise.resolve({
    ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body))
  });

  test('POSTs the content type and fields', async () => {
    fetchMock.mockReturnValueOnce(respond({ success: true, nodeId: 900 }));

    const result = await createNode('http://api', 'ps_events', { title: 'X' });

    expect(result).toEqual({ success: true, nodeId: 900 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://api/content');
    expect(JSON.parse(init.body)).toEqual({ contentType: 'ps_events', fields: { title: 'X' } });
  });

  test('treats skipped fields as a failure', async () => {
    fetchMock.mockReturnValueOnce(respond({
      success: true, nodeId: 901,
      skippedFields: [{ field: 'event_audience', reason: 'Field not found' }]
    }));

    const result = await createNode('http://api', 'ps_events', { title: 'X' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/event_audience/);
  });

  test('propagates an endpoint error', async () => {
    fetchMock.mockReturnValueOnce(respond({ success: false, error: 'boom' }));
    await expect(createNode('http://api', 'ps_events', {})).resolves.toEqual({
      success: false, error: 'boom'
    });
  });
});

describe('schedule-events CLI helpers', () => {
  test('parseArgs requires nothing but accepts the scheduling options', () => {
    const options = parseScheduleArgs([
      '--csv', 'a.csv', '--date', '2027-04-30', '--seed', '7',
      '--rooms', 'R1,R2', '--start', '9:00 AM', '--slot', '15',
      '--break', '10:15 AM', '--break-minutes', '30'
    ]);
    expect(options).toMatchObject({
      csv: 'a.csv', date: '2027-04-30', seed: 7,
      rooms: ['R1', 'R2'], slotMinutes: 15,
      breakStart: '10:15 AM', breakMinutes: 30
    });
  });

  test('parseArgs rejects a non-integer seed', () => {
    expect(() => parseScheduleArgs(['--seed', 'random'])).toThrow(/must be an integer/);
  });

  test('applySchedule fills only the schedule columns', () => {
    const rows = [{ First: 'A', Last: 'B', 'Talk Title': 'Keep me', 'Event Audience': '', Date: '', 'Start Time': '', 'End Time': '' }];
    const assignments = [{ item: rows[0], room: 'R1', start: '09:00 AM', end: '09:15 AM' }];

    const result = applySchedule(rows, assignments, { date: '2027-04-30' });

    expect(result[0]).toEqual({
      First: 'A', Last: 'B', 'Talk Title': 'Keep me',
      'Event Audience': 'R1', Date: '2027-04-30',
      'Start Time': '09:00 AM', 'End Time': '09:15 AM'
    });
  });

  test('applySchedule preserves original row order', () => {
    const rows = [{ n: '1' }, { n: '2' }, { n: '3' }];
    const assignments = [
      { item: rows[2], room: 'R1', start: '09:00 AM', end: '09:15 AM' },
      { item: rows[0], room: 'R2', start: '09:00 AM', end: '09:15 AM' },
      { item: rows[1], room: 'R1', start: '09:15 AM', end: '09:30 AM' }
    ];

    expect(applySchedule(rows, assignments, { date: 'd' }).map(r => r.n)).toEqual(['1', '2', '3']);
  });

  test('applySchedule leaves unassigned rows alone', () => {
    const rows = [{ First: 'A', 'Event Audience': 'existing' }];
    const result = applySchedule(rows, [], { date: '2027-04-30' });
    expect(result[0]['Event Audience']).toBe('existing');
  });

  test('summarizeByRoom counts rows per room', () => {
    const counts = summarizeByRoom([
      { 'Event Audience': 'R1' }, { 'Event Audience': 'R1' }, { 'Event Audience': 'R2' }, { 'Event Audience': '' }
    ]);
    expect(counts.get('R1')).toBe(2);
    expect(counts.get('R2')).toBe(1);
    expect(counts.size).toBe(2);
  });
});
