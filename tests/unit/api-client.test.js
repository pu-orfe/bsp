const {
  DEFAULT_API_BASE,
  apiRequest,
  getJSON,
  postJSON,
  putJSON,
  ensureAuthenticated
} = require('../../src/apiClient');

const API = 'http://localhost:3000';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, text: () => Promise.resolve(JSON.stringify(body)) });
}

describe('apiClient', () => {
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

  describe('DEFAULT_API_BASE', () => {
    test('is a localhost URL with a port', () => {
      expect(DEFAULT_API_BASE).toMatch(/^http:\/\/localhost:\d+$/);
    });
  });

  describe('apiRequest', () => {
    test('parses a JSON body', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ success: true }));
      const result = await apiRequest(API, '/health');
      expect(result.body).toEqual({ success: true });
      expect(result.ok).toBe(true);
    });

    test('treats an empty body as an empty object', async () => {
      fetchMock.mockReturnValueOnce(Promise.resolve({
        ok: true, status: 204, text: () => Promise.resolve('')
      }));
      await expect(apiRequest(API, '/x')).resolves.toMatchObject({ body: {} });
    });

    test('throws a helpful error on a non-JSON body', async () => {
      fetchMock.mockReturnValueOnce(Promise.resolve({
        ok: false, status: 502, text: () => Promise.resolve('<html>Bad Gateway</html>')
      }));
      await expect(apiRequest(API, '/x')).rejects.toThrow(/Non-JSON response from \/x \(HTTP 502\)/);
    });

    test('surfaces the failing status without throwing', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ error: 'nope' }, { ok: false, status: 400 }));
      const result = await apiRequest(API, '/x');
      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
    });
  });

  describe('verb helpers', () => {
    test('getJSON issues a plain GET', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({}));
      await getJSON(API, '/content');
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/content`);
      expect(fetchMock.mock.calls[0][1]).toEqual({});
    });

    test('postJSON sends a JSON body', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({}));
      await postJSON(API, '/content', { a: 1 });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual({ a: 1 });
    });

    test('postJSON omits the body when no payload is given', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({}));
      await postJSON(API, '/login/load');
      expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    });

    test('putJSON sends a PUT with a JSON body', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({}));
      await putJSON(API, '/content/1', { title: 'x' });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ title: 'x' });
    });
  });

  describe('ensureAuthenticated', () => {
    test('passes through when the session is already active', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ authenticated: true, adminAccess: true }));
      await expect(ensureAuthenticated(API)).resolves.toEqual({ authenticated: true, adminAccess: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('loads the saved session before giving up', async () => {
      fetchMock
        .mockReturnValueOnce(jsonResponse({ authenticated: false }))
        .mockReturnValueOnce(jsonResponse({ success: true }))
        .mockReturnValueOnce(jsonResponse({ authenticated: true, adminAccess: true }));

      await expect(ensureAuthenticated(API)).resolves.toMatchObject({ authenticated: true });
      expect(fetchMock.mock.calls[1][0]).toBe(`${API}/login/load`);
    });

    test('throws with login instructions when still unauthenticated', async () => {
      fetchMock
        .mockReturnValueOnce(jsonResponse({ authenticated: false }))
        .mockReturnValueOnce(jsonResponse({ success: false }))
        .mockReturnValueOnce(jsonResponse({ authenticated: false }));

      await expect(ensureAuthenticated(API)).rejects.toThrow(/Not authenticated/);
    });

    test('warns but proceeds when the session lacks admin access', async () => {
      fetchMock.mockReturnValueOnce(jsonResponse({ authenticated: true, adminAccess: false }));
      await ensureAuthenticated(API);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('no admin access'));
    });
  });
});
