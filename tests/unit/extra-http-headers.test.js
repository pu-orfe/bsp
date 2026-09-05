const PlaywrightManager = require('../../src/playwrightManager');

describe('PlaywrightManager - Extra HTTP Headers', () => {
  let manager;
  let warnSpy;
  let logSpy;

  beforeEach(() => {
    delete process.env.EXTRA_HTTP_HEADERS;
    manager = new PlaywrightManager();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.EXTRA_HTTP_HEADERS;
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  describe('getExtraHTTPHeaders', () => {
    test('returns null when EXTRA_HTTP_HEADERS is unset', () => {
      expect(manager.getExtraHTTPHeaders()).toBeNull();
    });

    test('returns null when EXTRA_HTTP_HEADERS is blank', () => {
      process.env.EXTRA_HTTP_HEADERS = '   ';
      expect(manager.getExtraHTTPHeaders()).toBeNull();
    });

    test('parses a JSON object of headers', () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-wdsoit-bot-bypass":"true"}';
      expect(manager.getExtraHTTPHeaders()).toEqual({ 'x-wdsoit-bot-bypass': 'true' });
    });

    test('coerces non-string scalar values to strings', () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-flag":true,"x-count":3}';
      expect(manager.getExtraHTTPHeaders()).toEqual({ 'x-flag': 'true', 'x-count': '3' });
    });

    test('drops entries whose value is not a scalar', () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-good":"1","x-bad":{"nested":true},"x-null":null}';
      expect(manager.getExtraHTTPHeaders()).toEqual({ 'x-good': '1' });
      expect(warnSpy).toHaveBeenCalled();
    });

    test('returns null and warns on invalid JSON', () => {
      process.env.EXTRA_HTTP_HEADERS = 'x-wdsoit-bot-bypass: true';
      expect(manager.getExtraHTTPHeaders()).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    });

    test('returns null and warns when JSON is not an object', () => {
      process.env.EXTRA_HTTP_HEADERS = '["x-wdsoit-bot-bypass"]';
      expect(manager.getExtraHTTPHeaders()).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
    });

    test('does not log header values', () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-secret":"super-secret-value"}';
      manager.getExtraHTTPHeaders();
      const logged = logSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('x-secret');
      expect(logged).not.toContain('super-secret-value');
    });
  });

  describe('buildContextOptions', () => {
    test('passes base options through unchanged when no headers configured', () => {
      const options = manager.buildContextOptions({ viewport: { width: 1280, height: 720 } });
      expect(options).toEqual({ viewport: { width: 1280, height: 720 } });
      expect(options.extraHTTPHeaders).toBeUndefined();
    });

    test('merges configured headers into the context options', () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-wdsoit-bot-bypass":"true"}';
      const options = manager.buildContextOptions({ storageState: { cookies: [] } });
      expect(options).toEqual({
        storageState: { cookies: [] },
        extraHTTPHeaders: { 'x-wdsoit-bot-bypass': 'true' }
      });
    });

    test('does not mutate the caller-supplied options object', () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-wdsoit-bot-bypass":"true"}';
      const base = { viewport: { width: 800, height: 600 } };
      manager.buildContextOptions(base);
      expect(base.extraHTTPHeaders).toBeUndefined();
    });
  });

  describe('context creation', () => {
    let mockBrowser;
    let mockContext;
    let mockPage;

    beforeEach(() => {
      mockPage = {
        goto: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        url: jest.fn().mockReturnValue('about:blank')
      };
      mockContext = { newPage: jest.fn().mockResolvedValue(mockPage) };
      mockBrowser = { newContext: jest.fn().mockResolvedValue(mockContext) };

      jest.spyOn(manager, 'launchBrowser').mockResolvedValue(mockBrowser);
      jest.spyOn(manager, 'ensureStorageDir').mockResolvedValue(undefined);
    });

    test('interactive context receives the configured headers', async () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-wdsoit-bot-bypass":"true"}';

      await manager.createInteractiveContext();

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: { width: 1280, height: 720 },
          extraHTTPHeaders: { 'x-wdsoit-bot-bypass': 'true' }
        })
      );
    });

    test('authenticated context receives the configured headers', async () => {
      process.env.EXTRA_HTTP_HEADERS = '{"x-wdsoit-bot-bypass":"true"}';
      process.env.BASE_URL = 'https://example.com';

      const fs = require('fs').promises;
      const readFileSpy = jest
        .spyOn(fs, 'readFile')
        .mockResolvedValue(JSON.stringify({ cookies: [], origins: [] }));

      await manager.loadAuthenticatedContext();

      expect(mockBrowser.newContext).toHaveBeenCalledWith(
        expect.objectContaining({
          storageState: { cookies: [], origins: [] },
          extraHTTPHeaders: { 'x-wdsoit-bot-bypass': 'true' }
        })
      );

      readFileSpy.mockRestore();
      delete process.env.BASE_URL;
    });
  });
});
