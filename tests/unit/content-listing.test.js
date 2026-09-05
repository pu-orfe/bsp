/**
 * @jest-environment jsdom
 *
 * Exercises the admin/content table parser inside queryContent() against the
 * markup Drupal actually renders, including the bulk-operations checkbox column
 * and "Restricted" status badges that shifted the old fixed-index parser.
 */

// Playwright's bundle does not load under the jsdom environment, and this
// suite never launches a browser - the in-page callback runs against jsdom.
jest.mock('playwright', () => ({ chromium: { launch: jest.fn() } }));

const PlaywrightManager = require('../../src/playwrightManager');

// Drupal core admin/content markup: a bulk-select column first, then
// Title / Content type / Status / Updated / Created / Operations.
const ADMIN_CONTENT_HTML = `
<table>
  <thead>
    <tr>
      <th class="select-all"></th>
      <th>Title</th>
      <th>Content type</th>
      <th>Status</th>
      <th>Updated <span>Sort ascending</span></th>
      <th>Created</th>
      <th>Operations</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><input type="checkbox" title="Update this item"><label>Update this item</label></td>
      <td><a href="/events/2026/clara-bloom" hreflang="en">Clara Bloom</a><div class="node-path">/events/2026/clara-bloom</div></td>
      <td>Event</td>
      <td>Published<div class="restricted-indicator">Restricted</div></td>
      <td>03/27/26 - 11:24 am


bino</td>
      <td>04/30/26 - 10:46 am


cdreyer</td>
      <td>
        <ul class="dropbutton">
          <li class="edit"><a href="/node/396/edit?destination=/admin/content">Edit</a></li>
          <li class="delete"><a href="/node/396/delete?destination=/admin/content">Delete</a></li>
          <li class="view"><a href="/node/396">View</a></li>
        </ul>
      </td>
    </tr>
    <tr>
      <td><input type="checkbox" title="Update this item"><label>Update this item</label></td>
      <td><a href="/schedule" hreflang="en">Symposium Schedule</a><div class="node-path">/schedule</div></td>
      <td>Page</td>
      <td>Published</td>
      <td>04/29/25 - 2:08 pm


bino</td>
      <td>05/01/26 - 8:31 am


cdreyer</td>
      <td><ul class="dropbutton"><li class="edit"><a href="/node/1/edit?destination=/admin/content">Edit</a></li></ul></td>
    </tr>
    <tr>
      <td><input type="checkbox" title="Update this item"><label>Update this item</label></td>
      <td><a href="/node/706" hreflang="en">Under Revision</a><div class="node-path">/node/706</div></td>
      <td>Alert</td>
      <td>Unpublished</td>
      <td>03/27/26 - 4:32 pm


bino</td>
      <td>05/01/26 - 12:00 am


cdreyer</td>
      <td><ul class="dropbutton"><li class="edit"><a href="/node/706/edit?destination=/admin/content">Edit</a></li></ul></td>
    </tr>
  </tbody>
</table>
<nav class="pager"><a href="?page=1" class="pager__link pager__link--next">Next ›</a></nav>
`;

// Legacy layout with no thead labels, to prove the positional fallback still works
const HEADERLESS_HTML = `
<table>
  <tbody>
    <tr>
      <td>Legacy Title</td>
      <td>/legacy-path</td>
      <td>Article</td>
      <td>Published</td>
      <td>01/15/25 - 2:30 pm</td>
      <td>01/01/25 - 9:00 am</td>
      <td><a href="/node/42/edit">Edit</a></td>
    </tr>
  </tbody>
</table>
`;

describe('PlaywrightManager - admin/content listing parser', () => {
  let manager;

  beforeEach(() => {
    process.env.BASE_URL = 'https://symposium.orfe.princeton.edu';

    manager = new PlaywrightManager();
    manager.page = {
      url: jest.fn().mockReturnValue('https://symposium.orfe.princeton.edu/admin/content'),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      // Run the in-page callback against jsdom rather than a real browser
      evaluate: jest.fn().mockImplementation((fn, arg) => Promise.resolve(fn(arg)))
    };

    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.BASE_URL;
    document.body.innerHTML = '';
  });

  describe('Drupal admin content table', () => {
    beforeEach(() => {
      document.body.innerHTML = ADMIN_CONTENT_HTML;
    });

    test('reads the title from the title column, not the bulk-select column', async () => {
      const result = await manager.queryContent(10);
      expect(result.success).toBe(true);
      expect(result.content.map(item => item.title)).toEqual([
        'Clara Bloom',
        'Symposium Schedule',
        'Under Revision'
      ]);
      expect(result.content.map(item => item.title)).not.toContain('Update this item');
    });

    test('extracts node IDs from the operations edit link', async () => {
      const result = await manager.queryContent(10);
      expect(result.content.map(item => item.id)).toEqual([396, 1, 706]);
    });

    test('separates a Restricted badge from the published status', async () => {
      const result = await manager.queryContent(10);
      const event = result.content[0];
      expect(event.status).toBe('Published');
      expect(event.restricted).toBe(true);
    });

    test('leaves the restricted flag false when there is no badge', async () => {
      const result = await manager.queryContent(10);
      expect(result.content[1].restricted).toBe(false);
      expect(result.content[1].status).toBe('Published');
    });

    test('reads unpublished status correctly', async () => {
      const result = await manager.queryContent(10);
      expect(result.content[2].status).toBe('Unpublished');
    });

    test('reads the content type column', async () => {
      const result = await manager.queryContent(10);
      expect(result.content.map(item => item.type)).toEqual(['Event', 'Page', 'Alert']);
    });

    test('keeps updated and created in the right columns', async () => {
      const result = await manager.queryContent(10);
      expect(result.content[0].updated).toBe('03/27/26 - 11:24 am');
      expect(result.content[0].created).toBe('04/30/26 - 10:46 am');
    });

    test('captures the node path and a clean view URL', async () => {
      const result = await manager.queryContent(10);
      expect(result.content[0].contentTitle).toBe('/events/2026/clara-bloom');
      expect(result.content[0].viewUrl).toBe('/node/396');
    });

    test('filters by content type across the whole table', async () => {
      const result = await manager.queryContent(10, 'Event');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].id).toBe(396);
    });

    test('applies the limit after filtering, not before', async () => {
      // 'Alert' is the last row; a pre-filter limit of 1 would drop it entirely
      const result = await manager.queryContent(1, 'Alert');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('Alert');
    });

    test('caps results at the requested limit', async () => {
      const result = await manager.queryContent(2);
      expect(result.content).toHaveLength(2);
    });

    test('detects the next-page link', async () => {
      const result = await manager.queryContent(10);
      expect(result.pagination.hasNextPage).toBe(true);
    });
  });

  describe('table without header labels', () => {
    beforeEach(() => {
      document.body.innerHTML = HEADERLESS_HTML;
    });

    test('falls back to positional columns', async () => {
      const result = await manager.queryContent(10);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        id: 42,
        title: 'Legacy Title',
        type: 'Article',
        status: 'Published'
      });
    });
  });

  describe('page with no table', () => {
    test('returns an empty result set', async () => {
      document.body.innerHTML = '<p>Access denied</p>';
      const result = await manager.queryContent(10);
      expect(result.success).toBe(true);
      expect(result.content).toEqual([]);
    });
  });
});
