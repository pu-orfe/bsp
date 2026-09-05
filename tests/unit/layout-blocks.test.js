/**
 * @jest-environment jsdom
 *
 * Layout Builder block discovery and editing. Blocks are addressed by section
 * delta + region + UUID, and edits are staged in a tempstore until the layout
 * is saved - both behaviours are covered here.
 */

jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));

const PlaywrightManager = require('../../src/playwrightManager');

// Markup mirroring Drupal's /node/1/layout page: two sections, each with an
// "Add block" link carrying the delta and region, plus block wrappers.
const LAYOUT_HTML = `
<div class="layout-builder">
  <div class="layout-builder__section">
    <div data-layout-content-preview-placeholder-label='"Content fields" block'
         class="layout-builder-block"
         data-layout-block-uuid="bd613200-3f13-4a10-9561-13166caf6f55"
         data-block-plugin-id="ps_node_view">Content fields preview</div>
    <a href="/layout_builder/choose/block/overrides/node.1/0/content">Add block</a>
  </div>
  <div class="layout-builder__section">
    <div data-layout-content-preview-placeholder-label='"001 - Sherrerd Hall" block'
         class="layout-builder-block"
         data-layout-block-uuid="cd8dc15d-e080-4765-9ffe-8d4a417ca4ff"
         data-block-plugin-id="ps_events_list_conference">ORFE Advisers: Someone</div>
    <div data-layout-content-preview-placeholder-label='"003 - Sherrerd Hall" block'
         class="layout-builder-block"
         data-layout-block-uuid="0aa5df0b-ca28-416d-a9e9-d3239d21432e"
         data-block-plugin-id="ps_events_list_conference">ORFE Advisers: Someone Else</div>
    <a href="/layout_builder/choose/block/overrides/node.1/2/content">Add block</a>
  </div>
</div>
`;

describe('PlaywrightManager - Layout Builder', () => {
  let manager;

  beforeEach(() => {
    process.env.BASE_URL = 'https://example.com';

    manager = new PlaywrightManager();
    manager.page = {
      url: jest.fn().mockReturnValue('https://example.com/node/1/layout'),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn(),
      evaluate: jest.fn().mockImplementation((fn, arg) => Promise.resolve(fn(arg)))
    };

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.BASE_URL;
    document.body.innerHTML = '';
  });

  describe('buildLayoutBlockUrl', () => {
    test('builds the Layout Builder override path', () => {
      const url = manager.buildLayoutBlockUrl('https://example.com', 1, 2, 'content', 'abc-uuid');
      expect(url).toBe(
        'https://example.com/layout_builder/update/block/overrides/node.1/2/content/abc-uuid'
      );
    });

    test('does not double up slashes on a base URL with a trailing slash', () => {
      const url = manager.buildLayoutBlockUrl('https://example.com/', 1, 0, 'content', 'abc');
      expect(url).toBe(
        'https://example.com/layout_builder/update/block/overrides/node.1/0/content/abc'
      );
    });
  });

  describe('queryLayoutBlocks', () => {
    beforeEach(() => {
      document.body.innerHTML = LAYOUT_HTML;
    });

    test('finds every block in the layout', async () => {
      const result = await manager.queryLayoutBlocks(1);
      expect(result.success).toBe(true);
      expect(result.count).toBe(3);
    });

    test('resolves each block to its section delta and region', async () => {
      const result = await manager.queryLayoutBlocks(1);
      expect(result.blocks[0]).toMatchObject({ delta: 0, region: 'content' });
      expect(result.blocks[1]).toMatchObject({ delta: 2, region: 'content' });
      expect(result.blocks[2]).toMatchObject({ delta: 2, region: 'content' });
    });

    test('reads the block plugin ID', async () => {
      const result = await manager.queryLayoutBlocks(1);
      expect(result.blocks.map(block => block.pluginId)).toEqual([
        'ps_node_view',
        'ps_events_list_conference',
        'ps_events_list_conference'
      ]);
    });

    test('unwraps the admin label from the preview placeholder attribute', async () => {
      const result = await manager.queryLayoutBlocks(1);
      expect(result.blocks.map(block => block.label)).toEqual([
        'Content fields',
        '001 - Sherrerd Hall',
        '003 - Sherrerd Hall'
      ]);
    });

    test('navigates to the layout page for the requested node', async () => {
      await manager.queryLayoutBlocks(7);
      expect(manager.page.goto).toHaveBeenCalledWith(
        'https://example.com/node/7/layout',
        expect.any(Object)
      );
    });

    test('drops blocks whose section address cannot be resolved', async () => {
      document.body.innerHTML = `
        <div class="layout-builder">
          <div class="layout-builder__section">
            <div data-layout-block-uuid="orphan-uuid" data-block-plugin-id="x">no add link</div>
          </div>
        </div>`;

      const result = await manager.queryLayoutBlocks(1);
      expect(result.success).toBe(true);
      expect(result.blocks).toEqual([]);
    });

    test('fails clearly when BASE_URL is missing', async () => {
      delete process.env.BASE_URL;
      const result = await manager.queryLayoutBlocks(1);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/BASE_URL/);
    });
  });

  describe('getLayoutBlockDetail', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <form>
          <input name="settings[label]" value="001 - Sherrerd Hall">
          <textarea name="settings[ps_core_description][value]">&lt;ul&gt;&lt;li&gt;Advisers&lt;/li&gt;&lt;/ul&gt;</textarea>
          <input type="checkbox" name="settings[label_display]" value="visible" checked>
          <input type="checkbox" name="settings[ps_core_description_enabled]" value="1">
          <input type="radio" name="settings[content_source]" value="curated">
          <input type="radio" name="settings[content_source]" value="dynamic" checked>
        </form>`;
    });

    test('returns the block address alongside its field values', async () => {
      const result = await manager.getLayoutBlockDetail(1, 2, 'content', 'abc-uuid');
      expect(result.success).toBe(true);
      expect(result.block).toMatchObject({ nodeId: 1, delta: 2, region: 'content', uuid: 'abc-uuid' });
    });

    test('surfaces the admin label', async () => {
      const result = await manager.getLayoutBlockDetail(1, 2, 'content', 'abc-uuid');
      expect(result.block.label).toBe('001 - Sherrerd Hall');
    });

    test('reads textarea content', async () => {
      const result = await manager.getLayoutBlockDetail(1, 2, 'content', 'abc-uuid');
      expect(result.block.data['settings[ps_core_description][value]']).toBe('<ul><li>Advisers</li></ul>');
    });

    test('reports checkbox state rather than the value attribute', async () => {
      const result = await manager.getLayoutBlockDetail(1, 2, 'content', 'abc-uuid');
      expect(result.block.data['settings[label_display]']).toBe('visible');
      expect(result.block.data['settings[ps_core_description_enabled]']).toBeNull();
    });

    test('reports the selected radio out of a group', async () => {
      const result = await manager.getLayoutBlockDetail(1, 2, 'content', 'abc-uuid');
      expect(result.block.data['settings[content_source]']).toBe('dynamic');
    });
  });

  describe('updateLayoutBlock', () => {
    let submitLocator;

    beforeEach(() => {
      submitLocator = {
        count: jest.fn().mockResolvedValue(1),
        click: jest.fn().mockResolvedValue(undefined)
      };
      manager.page.locator.mockReturnValue({ first: () => submitLocator });
    });

    test('stages the change without saving the layout by default', async () => {
      jest.spyOn(manager, 'updateFormFields').mockResolvedValue({
        updated: [{ field: 'settings[label]', value: 'New' }],
        skipped: []
      });
      const saveSpy = jest.spyOn(manager, 'saveLayout');

      const result = await manager.updateLayoutBlock(1, 2, 'content', 'abc', { 'settings[label]': 'New' });

      expect(result.success).toBe(true);
      expect(result.saved).toBe(false);
      expect(saveSpy).not.toHaveBeenCalled();
      expect(submitLocator.click).toHaveBeenCalled();
    });

    test('saves the layout when asked to', async () => {
      jest.spyOn(manager, 'updateFormFields').mockResolvedValue({
        updated: [{ field: 'settings[label]', value: 'New' }],
        skipped: []
      });
      jest.spyOn(manager, 'saveLayout').mockResolvedValue({ success: true });

      const result = await manager.updateLayoutBlock(
        1, 2, 'content', 'abc', { 'settings[label]': 'New' }, { save: true }
      );

      expect(result.saved).toBe(true);
      expect(manager.saveLayout).toHaveBeenCalledWith(1);
    });

    test('reports failure when the layout save fails', async () => {
      jest.spyOn(manager, 'updateFormFields').mockResolvedValue({
        updated: [{ field: 'settings[label]', value: 'New' }],
        skipped: []
      });
      jest.spyOn(manager, 'saveLayout').mockResolvedValue({ success: false, error: 'save blew up' });

      const result = await manager.updateLayoutBlock(
        1, 2, 'content', 'abc', { 'settings[label]': 'New' }, { save: true }
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('save blew up');
    });

    test('does not submit when no field resolved', async () => {
      jest.spyOn(manager, 'updateFormFields').mockResolvedValue({
        updated: [],
        skipped: [{ field: 'settings[nope]', reason: 'Field not found' }]
      });

      const result = await manager.updateLayoutBlock(1, 2, 'content', 'abc', { 'settings[nope]': 'x' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/form not submitted/);
      expect(submitLocator.click).not.toHaveBeenCalled();
    });

    test('fails when the Update button is missing', async () => {
      jest.spyOn(manager, 'updateFormFields').mockResolvedValue({
        updated: [{ field: 'settings[label]', value: 'New' }],
        skipped: []
      });
      submitLocator.count.mockResolvedValue(0);

      const result = await manager.updateLayoutBlock(1, 2, 'content', 'abc', { 'settings[label]': 'New' });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Update button/);
    });

    test('block forms are filled without a content type schema', async () => {
      const spy = jest.spyOn(manager, 'updateFormFields').mockResolvedValue({
        updated: [{ field: 'settings[label]', value: 'New' }],
        skipped: []
      });

      await manager.updateLayoutBlock(1, 2, 'content', 'abc', { 'settings[label]': 'New' });

      expect(spy).toHaveBeenCalledWith({ 'settings[label]': 'New' }, null);
    });
  });

  describe('saveLayout / discardLayoutChanges', () => {
    let button;

    beforeEach(() => {
      button = {
        count: jest.fn().mockResolvedValue(1),
        click: jest.fn().mockResolvedValue(undefined)
      };
      manager.page.locator.mockReturnValue({ first: () => button });
    });

    test('saveLayout clicks Save layout on the layout page', async () => {
      const result = await manager.saveLayout(1);

      expect(result.success).toBe(true);
      expect(result.action).toBe('save');
      expect(manager.page.goto).toHaveBeenCalledWith(
        'https://example.com/node/1/layout',
        expect.any(Object)
      );
      expect(button.click).toHaveBeenCalled();
    });

    test('saveLayout reports a missing button rather than silently passing', async () => {
      button.count.mockResolvedValue(0);
      const result = await manager.saveLayout(1);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Save layout/);
    });

    test('saveLayout reports a missing button when the wait times out', async () => {
      manager.page.waitForSelector.mockRejectedValue(new Error('Timeout 10000ms exceeded'));
      const result = await manager.saveLayout(1);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Save layout/);
      expect(button.click).not.toHaveBeenCalled();
    });

    test('waits on the action button, not a generic form', async () => {
      await manager.saveLayout(1);

      const waited = manager.page.waitForSelector.mock.calls[0];
      expect(waited[0]).toMatch(/Save layout/);
      expect(waited[1]).toMatchObject({ state: 'attached' });
    });

    test('discardLayoutChanges clicks through the confirmation step', async () => {
      const result = await manager.discardLayoutChanges(1);

      expect(result.success).toBe(true);
      expect(result.action).toBe('discard');
      // once for Discard, once for the confirmation form
      expect(button.click).toHaveBeenCalledTimes(2);
    });
  });
});
