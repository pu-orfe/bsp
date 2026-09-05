const {
  TRANSFORMS,
  renderTemplate,
  templateColumns,
  normalizeDefinition,
  validateMapping,
  requiredColumns,
  applyMapping
} = require('../../src/fieldMapping');

describe('fieldMapping - renderTemplate', () => {
  const row = { First: 'Ada', Last: 'Lovelace', Empty: '', Padded: '  spaced  ' };

  test('substitutes a single placeholder', () => {
    expect(renderTemplate('{First}', row)).toBe('Ada');
  });

  test('combines placeholders and literal text', () => {
    expect(renderTemplate('{First} {Last}', row)).toBe('Ada Lovelace');
    expect(renderTemplate('<p>Name: {First}</p>', row)).toBe('<p>Name: Ada</p>');
  });

  test('uses the fallback for a blank column', () => {
    expect(renderTemplate('{Empty|TBD}', row)).toBe('TBD');
  });

  test('uses the fallback for a missing column', () => {
    expect(renderTemplate('{Nope|TBD}', row)).toBe('TBD');
  });

  test('prefers a present value over the fallback', () => {
    expect(renderTemplate('{First|TBD}', row)).toBe('Ada');
  });

  test('an empty fallback yields an empty string', () => {
    expect(renderTemplate('{Empty|}', row)).toBe('');
  });

  test('a fallback may contain spaces and punctuation', () => {
    expect(renderTemplate('{Empty|To be announced!}', row)).toBe('To be announced!');
  });

  test('trims surrounding whitespace in values', () => {
    expect(renderTemplate('{Padded}', row)).toBe('spaced');
  });

  test('a missing column with no fallback renders empty', () => {
    expect(renderTemplate('x{Nope}y', row)).toBe('xy');
  });

  test('doubled braces are literal', () => {
    expect(renderTemplate('{{First}}', row)).toBe('{First}');
  });

  test('a template with no placeholders passes through', () => {
    expect(renderTemplate('plain text', row)).toBe('plain text');
  });

  test('rejects an unclosed placeholder', () => {
    expect(() => renderTemplate('{First', row)).toThrow(/Unclosed placeholder/);
  });

  test('rejects an empty placeholder', () => {
    expect(() => renderTemplate('{}', row)).toThrow(/Empty placeholder/);
  });

  test('handles column names containing spaces', () => {
    expect(renderTemplate('{Talk Title}', { 'Talk Title': 'On Queues' })).toBe('On Queues');
  });
});

describe('fieldMapping - templateColumns', () => {
  test('lists referenced columns', () => {
    expect(templateColumns('{First} {Last}')).toEqual(['First', 'Last']);
  });

  test('ignores the fallback text', () => {
    expect(templateColumns('{Talk Title|TBD}')).toEqual(['Talk Title']);
  });

  test('de-duplicates repeats', () => {
    expect(templateColumns('{Date} to {Date}')).toEqual(['Date']);
  });

  test('ignores escaped braces', () => {
    expect(templateColumns('{{NotAColumn}}')).toEqual([]);
  });

  test('returns nothing for a literal template', () => {
    expect(templateColumns('literal')).toEqual([]);
  });
});

describe('fieldMapping - transforms', () => {
  test.each([
    ['2027-04-30', '2027-04-30'],
    ['5/1/26', '2026-05-01'],
    ['12/25/2027', '2027-12-25']
  ])('date(%s) is %s', (input, expected) => {
    expect(TRANSFORMS.date(input)).toBe(expected);
  });

  test('date passes an empty value through', () => {
    expect(TRANSFORMS.date('')).toBe('');
  });

  test('date rejects nonsense', () => {
    expect(() => TRANSFORMS.date('next Friday')).toThrow(/Could not parse date/);
  });

  test.each([
    ['9:00 AM', '09:00 AM'],
    ['09:00 am', '09:00 AM'],
    ['12:15 pm', '12:15 PM']
  ])('time(%s) is %s', (input, expected) => {
    expect(TRANSFORMS.time(input)).toBe(expected);
  });

  test('time leaves unrecognised input alone', () => {
    expect(TRANSFORMS.time('noon')).toBe('noon');
  });

  test('number parses and rejects', () => {
    expect(TRANSFORMS.number('42')).toBe(42);
    expect(() => TRANSFORMS.number('x')).toThrow(/Could not parse number/);
  });

  test('boolean recognises common truthy spellings', () => {
    ['1', 'true', 'TRUE', 'yes', 'Y'].forEach(v => expect(TRANSFORMS.boolean(v)).toBe(true));
    ['0', 'false', 'no', ''].forEach(v => expect(TRANSFORMS.boolean(v)).toBe(false));
  });

  test('case transforms', () => {
    expect(TRANSFORMS.upper('ab')).toBe('AB');
    expect(TRANSFORMS.lower('AB')).toBe('ab');
    expect(TRANSFORMS.trim('  x  ')).toBe('x');
  });
});

describe('fieldMapping - normalizeDefinition', () => {
  test('a string becomes a template', () => {
    expect(normalizeDefinition('{X}')).toEqual({ template: '{X}' });
  });

  test('an object passes through', () => {
    expect(normalizeDefinition({ value: 1 })).toEqual({ value: 1 });
  });

  test('a scalar becomes a literal value', () => {
    expect(normalizeDefinition(false)).toEqual({ value: false });
    expect(normalizeDefinition(7)).toEqual({ value: 7 });
  });
});

describe('fieldMapping - validateMapping', () => {
  test('accepts a well-formed mapping', () => {
    expect(validateMapping({ fields: { title: '{X}' } })).toBe(true);
  });

  test('rejects a missing fields object', () => {
    expect(() => validateMapping({})).toThrow(/must have a "fields" object/);
    expect(() => validateMapping(null)).toThrow(/must be an object/);
  });

  test('rejects an empty fields object', () => {
    expect(() => validateMapping({ fields: {} })).toThrow(/is empty/);
  });

  test('rejects a field with both template and value', () => {
    expect(() => validateMapping({ fields: { a: { template: '{X}', value: 1 } } }))
      .toThrow(/both "template" and "value"/);
  });

  test('rejects a field with neither', () => {
    expect(() => validateMapping({ fields: { a: {} } })).toThrow(/needs either/);
  });

  test('rejects an unknown transform and names the valid ones', () => {
    expect(() => validateMapping({ fields: { a: { template: '{X}', transform: 'nope' } } }))
      .toThrow(/unknown transform "nope".*Available:/s);
  });
});

describe('fieldMapping - requiredColumns', () => {
  test('collects columns across all fields', () => {
    const mapping = {
      fields: {
        title: '{First} {Last}',
        sub: { template: '{Talk Title|TBD}' },
        lit: { value: false }
      }
    };
    expect(requiredColumns(mapping)).toEqual(['First', 'Last', 'Talk Title']);
  });

  test('a literal-only mapping needs no columns', () => {
    expect(requiredColumns({ fields: { a: { value: 1 } } })).toEqual([]);
  });
});

describe('fieldMapping - applyMapping', () => {
  const mapping = {
    contentType: 'ps_events',
    fields: {
      title: { template: '{First} {Last}', required: true },
      subtitle: '{Talk Title|TBD}',
      body: '<p>Adviser: {Adviser|TBD}</p>',
      event_start_date: { template: '{Date}', transform: 'date' },
      event_start_time: { template: '{Start Time}', transform: 'time' },
      all_day: { value: false },
      status: { value: false }
    }
  };

  const row = {
    First: 'Ada', Last: 'Lovelace', 'Talk Title': '', Adviser: '',
    Date: '5/1/26', 'Start Time': '9:00 AM'
  };

  test('builds the full field map', () => {
    expect(applyMapping(row, mapping)).toEqual({
      title: 'Ada Lovelace',
      subtitle: 'TBD',
      body: '<p>Adviser: TBD</p>',
      event_start_date: '2026-05-01',
      event_start_time: '09:00 AM',
      all_day: false,
      status: false
    });
  });

  test('literal values keep their type', () => {
    const fields = applyMapping(row, mapping);
    expect(fields.all_day).toBe(false);
    expect(typeof fields.status).toBe('boolean');
  });

  test('uses real values when the CSV supplies them', () => {
    const fields = applyMapping({ ...row, 'Talk Title': 'On Queues', Adviser: 'Prof. X' }, mapping);
    expect(fields.subtitle).toBe('On Queues');
    expect(fields.body).toBe('<p>Adviser: Prof. X</p>');
  });

  test('throws when a required field resolves empty', () => {
    expect(() => applyMapping({ ...row, First: '', Last: '' }, mapping))
      .toThrow(/"title" is required/);
  });

  test('omits an empty optional field rather than sending a blank', () => {
    const spec = { fields: { note: '{Missing}' } };
    expect(applyMapping({}, spec)).toEqual({});
  });

  test('allowEmpty keeps a blank field in the payload', () => {
    const spec = { fields: { note: { template: '{Missing}', allowEmpty: true } } };
    expect(applyMapping({}, spec)).toEqual({ note: '' });
  });

  test('a transform error names the offending field', () => {
    const spec = { fields: { d: { template: '{Date}', transform: 'date' } } };
    expect(() => applyMapping({ Date: 'someday' }, spec)).toThrow(/Field "d": Could not parse date/);
  });

  test('the same mapping serves a completely different CSV shape', () => {
    const articleMapping = {
      contentType: 'article',
      fields: { title: { template: '{Headline}', required: true }, body: '{Story|}' }
    };
    expect(applyMapping({ Headline: 'Big News', Story: 'Details' }, articleMapping))
      .toEqual({ title: 'Big News', body: 'Details' });
  });
});
