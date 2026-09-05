/**
 * @jest-environment jsdom
 *
 * Content type detection drives schema loading, so a machine name with an
 * underscore (ps_events, blog_post) must survive detection intact.
 */

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));

const PlaywrightManager = require('../../src/playwrightManager');

describe('PlaywrightManager - detectContentType', () => {
  let manager;

  beforeEach(() => {
    manager = new PlaywrightManager();
    manager.page = {
      evaluate: jest.fn().mockImplementation(fn => Promise.resolve(fn()))
    };
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = '';
  });

  describe('from the hidden form_id input', () => {
    test('reads a single-word machine name from an edit form', async () => {
      document.body.innerHTML = '<form><input name="form_id" value="node_article_edit_form"></form>';
      await expect(manager.detectContentType()).resolves.toBe('article');
    });

    test('keeps underscores in a multi-word machine name', async () => {
      document.body.innerHTML = '<form><input name="form_id" value="node_ps_events_edit_form"></form>';
      await expect(manager.detectContentType()).resolves.toBe('ps_events');
    });

    test('handles a creation form without the _edit segment', async () => {
      document.body.innerHTML = '<form><input name="form_id" value="node_ps_news_form"></form>';
      await expect(manager.detectContentType()).resolves.toBe('ps_news');
    });

    test('handles a three-word machine name', async () => {
      document.body.innerHTML = '<form><input name="form_id" value="node_ps_events_series_edit_form"></form>';
      await expect(manager.detectContentType()).resolves.toBe('ps_events_series');
    });
  });

  describe('from data-drupal-selector', () => {
    test('converts dashes back to underscores', async () => {
      document.body.innerHTML =
        '<form data-drupal-selector="node-ps-events-edit-form"></form>';
      await expect(manager.detectContentType()).resolves.toBe('ps_events');
    });

    test('reads a single-word machine name', async () => {
      document.body.innerHTML = '<form data-drupal-selector="node-article-edit-form"></form>';
      await expect(manager.detectContentType()).resolves.toBe('article');
    });

    test('form_id wins when both are present', async () => {
      document.body.innerHTML =
        '<form data-drupal-selector="node-ps-events-edit-form">' +
        '<input name="form_id" value="node_ps_events_edit_form"></form>';
      await expect(manager.detectContentType()).resolves.toBe('ps_events');
    });
  });

  describe('from the form action', () => {
    test('reads the type out of a node/add path', async () => {
      document.body.innerHTML = '<form action="https://example.com/node/add/ps_events"></form>';
      await expect(manager.detectContentType()).resolves.toBe('ps_events');
    });
  });

  test('returns unknown when nothing identifies the type', async () => {
    document.body.innerHTML = '<div>no form here</div>';
    await expect(manager.detectContentType()).resolves.toBe('unknown');
  });

  test('a detected multi-word type resolves to its schema file', async () => {
    document.body.innerHTML = '<form><input name="form_id" value="node_ps_events_edit_form"></form>';

    const contentType = await manager.detectContentType();
    const schema = await manager.loadSchemaForContentType(contentType);

    expect(schema).not.toBeNull();
    expect(schema.contentType).toBe('ps_events');
  });
});

describe('PlaywrightManager - findSchemaFieldBySelector', () => {
  let manager;

  beforeEach(() => {
    manager = new PlaywrightManager();
  });

  const schema = {
    fields: {
      event_start_date: {
        selector: '[name="field_ps_events_date[0][value][date]"]',
        type: 'date'
      },
      event_audience: {
        selector: 'select[name="field_ps_events_audience[]"]',
        type: 'hidden_select'
      },
      status: { selector: '[name="status[value]"]', type: 'checkbox' }
    }
  };

  test('matches a raw Drupal form name to its schema entry', () => {
    const found = manager.findSchemaFieldBySelector(schema, 'field_ps_events_date[0][value][date]');
    expect(found).toEqual({ selector: '[name="field_ps_events_date[0][value][date]"]', type: 'date' });
  });

  test('matches a selector that is prefixed with an element name', () => {
    const found = manager.findSchemaFieldBySelector(schema, 'field_ps_events_audience[]');
    expect(found.type).toBe('hidden_select');
  });

  test('returns null for an unknown field name', () => {
    expect(manager.findSchemaFieldBySelector(schema, 'field_nope[0][value]')).toBeNull();
  });

  test('returns null when there is no schema', () => {
    expect(manager.findSchemaFieldBySelector(null, 'status[value]')).toBeNull();
    expect(manager.findSchemaFieldBySelector({}, 'status[value]')).toBeNull();
  });

  test('does not match a partial field name', () => {
    expect(manager.findSchemaFieldBySelector(schema, 'status')).toBeNull();
  });
});
