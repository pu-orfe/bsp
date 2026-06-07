const PlaywrightManager = require('../../src/playwrightManager');

jest.setTimeout(30000);

describe('PlaywrightManager - Content Update', () => {
  let manager;
  let mockPage;
  let mockContext;
  let mockBrowser;
  let mockLocator;

  beforeEach(() => {
    // Create mock locator factory for proper chaining
    function createMockLocator() {
      const locator = {
        count: jest.fn().mockResolvedValue(1),
        fill: jest.fn().mockResolvedValue(undefined),
        check: jest.fn().mockResolvedValue(undefined),
        uncheck: jest.fn().mockResolvedValue(undefined),
        selectOption: jest.fn().mockResolvedValue(undefined),
        click: jest.fn().mockResolvedValue(undefined),
        getAttribute: jest.fn().mockResolvedValue('text'),
        first: jest.fn()
      };
      locator.first.mockImplementation(() => createMockLocator());
      return locator;
    }
    mockLocator = createMockLocator();

    // Create mock page
    mockPage = {
      goto: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://example.com/node/123/edit'),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      waitForURL: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue(mockLocator),
      evaluate: jest.fn().mockResolvedValue('article'),
      title: jest.fn().mockResolvedValue('Edit Article')
    };

    // Create mock context
    mockContext = {
      newPage: jest.fn().mockResolvedValue(mockPage),
      storageState: jest.fn().mockResolvedValue({ cookies: [], origins: [] }),
      close: jest.fn().mockResolvedValue(undefined)
    };

    // Create mock browser
    mockBrowser = {
      newContext: jest.fn().mockResolvedValue(mockContext),
      close: jest.fn().mockResolvedValue(undefined),
      contexts: jest.fn().mockReturnValue([])
    };

    // Create manager instance and inject mocks
    manager = new PlaywrightManager();
    manager.browser = mockBrowser;
    manager.context = mockContext;
    manager.page = mockPage;

    // Set environment variable for BASE_URL
    process.env.BASE_URL = 'https://example.com';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('updateContent', () => {
    test('should throw error if no page is available', async () => {
      manager.page = null;

      const result = await manager.updateContent(123, { title: 'Updated' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No active page');
    });

    test('should throw error if BASE_URL is not set', async () => {
      delete process.env.BASE_URL;

      const result = await manager.updateContent(123, { title: 'Updated' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('BASE_URL environment variable is required');

      // Restore BASE_URL
      process.env.BASE_URL = 'https://example.com';
    });

    test('should navigate to edit page with correct URL', async () => {
      mockPage.url.mockReturnValue('https://example.com/node/123/edit');

      await manager.updateContent(123, { title: 'Updated Title' });

      expect(mockPage.goto).toHaveBeenCalledWith(
        'https://example.com/node/123/edit',
        expect.objectContaining({ waitUntil: 'domcontentloaded' })
      );
    });

    test('should wait for form to be loaded', async () => {
      mockPage.url.mockReturnValue('https://example.com/node/123/edit');

      await manager.updateContent(123, { title: 'Updated Title' });

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('form', expect.any(Object));
    });

    test('should detect content type from page', async () => {
      mockPage.url.mockReturnValue('https://example.com/node/123/edit');
      mockPage.evaluate.mockResolvedValue('article');

      await manager.updateContent(123, { title: 'Updated Title' });

      expect(mockPage.evaluate).toHaveBeenCalled();
    });

    test('should return success when update completes', async () => {
      mockPage.url.mockReturnValue('https://example.com/node/123/edit');
      mockLocator.count.mockResolvedValue(1);

      const result = await manager.updateContent(123, { title: 'Updated Title' });

      expect(result.success).toBe(true);
      expect(result.nodeId).toBe(123);
      expect(result.message).toContain('updated successfully');
    });

    test('should include updated fields in response', async () => {
      mockPage.url.mockReturnValue('https://example.com/node/123/edit');
      mockLocator.count.mockResolvedValue(1);

      const result = await manager.updateContent(123, { title: 'Updated Title' });

      expect(result.updatedFields).toBeDefined();
      expect(Array.isArray(result.updatedFields)).toBe(true);
    });

    test('should include skipped fields in response', async () => {
      mockPage.url.mockReturnValue('https://example.com/node/123/edit');
      mockLocator.count.mockResolvedValue(1);

      const result = await manager.updateContent(123, {
        title: 'Updated Title',
        nonexistent_field: 'value'
      });

      expect(result.skippedFields).toBeDefined();
      expect(Array.isArray(result.skippedFields)).toBe(true);
    });
  });

  describe('detectContentType', () => {
    test('should detect content type from form selector', async () => {
      mockPage.evaluate.mockResolvedValue('article');

      const contentType = await manager.detectContentType();

      expect(contentType).toBe('article');
    });

    test('should return unknown if content type cannot be detected', async () => {
      mockPage.evaluate.mockResolvedValue(null);

      const contentType = await manager.detectContentType();

      expect(contentType).toBe('unknown');
    });

    test('should handle errors gracefully', async () => {
      mockPage.evaluate.mockRejectedValue(new Error('Evaluation failed'));

      const contentType = await manager.detectContentType();

      expect(contentType).toBe('unknown');
    });
  });

  describe('loadSchemaForContentType', () => {
    test('should return null if schema file does not exist', async () => {
      const schema = await manager.loadSchemaForContentType('nonexistent_type');

      expect(schema).toBeNull();
    });

    test('should return null if schema is invalid JSON', async () => {
      const schema = await manager.loadSchemaForContentType('invalid');

      expect(schema).toBeNull();
    });

    test('should return null if content type contains invalid characters (path injection)', async () => {
      const schema = await manager.loadSchemaForContentType('../something');

      expect(schema).toBeNull();
    });
  });

  describe('updateFormFields', () => {
    test('should update text fields', async () => {
      const result = await manager.updateFormFields(
        { title: 'New Title' },
        null
      );

      expect(mockLocator.fill).toHaveBeenCalledWith('New Title');
      expect(result.updated).toHaveLength(1);
      expect(result.updated[0].field).toBe('title');
    });

    test('should update checkbox fields', async () => {
      // Mock getAttribute to return 'checkbox' for this test
      mockLocator.getAttribute.mockResolvedValue('checkbox');

      const result = await manager.updateFormFields(
        { status: true },
        {
          fields: {
            status: {
              selector: '[name="status[value]"]',
              type: 'checkbox'
            }
          }
        }
      );

      expect(mockLocator.check).toHaveBeenCalled();
      expect(result.updated).toHaveLength(1);
    });

    test('should uncheck checkbox when value is false', async () => {
      // Mock getAttribute to return 'checkbox' for this test
      mockLocator.getAttribute.mockResolvedValue('checkbox');

      const result = await manager.updateFormFields(
        { status: false },
        {
          fields: {
            status: {
              selector: '[name="status[value]"]',
              type: 'checkbox'
            }
          }
        }
      );

      expect(mockLocator.uncheck).toHaveBeenCalled();
      expect(result.updated).toHaveLength(1);
    });

    test('should skip fields that cannot be found', async () => {
      mockLocator.count.mockResolvedValue(0);

      const result = await manager.updateFormFields(
        { nonexistent: 'value' },
        null
      );

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].field).toBe('nonexistent');
      expect(result.skipped[0].reason).toBe('Field not found');
    });

    test('should try alternative selectors if primary fails', async () => {
      mockLocator.count
        .mockResolvedValueOnce(0) // First selector fails
        .mockResolvedValueOnce(0) // Alternative 1 fails
        .mockResolvedValueOnce(1); // Alternative 2 succeeds

      const result = await manager.updateFormFields(
        { custom_field: 'value' },
        null
      );

      // Should be called at least once for primary and once for alternatives
      expect(mockPage.locator).toHaveBeenCalled();
      expect(result.updated.length).toBeGreaterThan(0);
    });

    test('should use schema selectors when available', async () => {
      const schema = {
        fields: {
          title: {
            selector: '[name="title[0][value]"]',
            type: 'text'
          }
        }
      };

      await manager.updateFormFields({ title: 'Test' }, schema);

      expect(mockPage.locator).toHaveBeenCalledWith('[name="title[0][value]"]');
    });

    test('should handle multiple field updates', async () => {
      const result = await manager.updateFormFields(
        {
          title: 'Title',
          body: 'Body'
        },
        null
      );

      expect(result.updated.length).toBeGreaterThan(0);
      expect(mockLocator.fill).toHaveBeenCalledTimes(2);
    });

    test('should handle errors during field update', async () => {
      // Mock getAttribute to succeed, but fill to fail
      mockLocator.getAttribute.mockResolvedValue('text');
      mockLocator.fill.mockRejectedValue(new Error('Fill failed'));

      const result = await manager.updateFormFields(
        { title: 'Test' },
        null
      );

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('Fill failed');
    });
  });
});
