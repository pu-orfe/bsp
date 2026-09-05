/**
 * Thin client for the BSP API, shared by the example scripts.
 *
 * Centralises the base URL default, JSON handling, and the session check so the
 * scripts do not each carry their own copy.
 */

const fs = require('fs');
const path = require('path');

/**
 * Read the project's .env into process.env for values that are not already set.
 *
 * docker-compose feeds .env to the container, but these scripts run on the host
 * and would otherwise miss settings like BSP_API_PORT. Existing environment
 * variables always win, so an explicit export still overrides the file.
 */
function loadEnvFile(envPath = path.join(__dirname, '..', '.env')) {
  let contents;
  try {
    contents = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return {}; // No .env is a perfectly normal setup
  }

  const values = {};

  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip matching surrounding quotes
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1);
    }

    values[key] = value;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return values;
}

loadEnvFile();

// Host port is configurable - 3000 collides with all sorts of dev tooling.
// Override with API_BASE, or BSP_API_PORT to change only the port.
const DEFAULT_PORT = process.env.BSP_API_PORT || '3000';
const DEFAULT_API_BASE = process.env.API_BASE || `http://localhost:${DEFAULT_PORT}`;

/**
 * Perform a request against the API and parse its JSON body.
 *
 * @param {string} apiBase - API root, without a trailing slash
 * @param {string} path - Path beginning with "/"
 * @param {Object} [init] - fetch() options
 * @returns {Promise<{ok: boolean, status: number, body: Object}>}
 */
async function apiRequest(apiBase, path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from ${path} (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  return { ok: response.ok, status: response.status, body };
}

/**
 * Convenience wrappers for the verbs the scripts use.
 */
function getJSON(apiBase, path) {
  return apiRequest(apiBase, path);
}

function postJSON(apiBase, path, payload) {
  return apiRequest(apiBase, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
}

function putJSON(apiBase, path, payload) {
  return apiRequest(apiBase, path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/**
 * Ensure a usable session, loading the saved one if the browser has none.
 *
 * @throws {Error} with login instructions when no session can be established
 */
async function ensureAuthenticated(apiBase) {
  let check = await apiRequest(apiBase, '/login/check');

  if (!check.body.authenticated) {
    console.log('Session not active - attempting to load the saved session...');
    await postJSON(apiBase, '/login/load');
    check = await apiRequest(apiBase, '/login/check');
  }

  if (!check.body.authenticated) {
    throw new Error(
      `Not authenticated. Run: curl -X POST ${apiBase}/login/interactive, ` +
      `log in via VNC, then curl -X POST ${apiBase}/login/save`
    );
  }

  if (check.body.adminAccess === false) {
    console.warn('Warning: session is authenticated but reports no admin access.');
  }

  return check.body;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  loadEnvFile,
  DEFAULT_API_BASE,
  DEFAULT_PORT,
  apiRequest,
  getJSON,
  postJSON,
  putJSON,
  ensureAuthenticated,
  sleep
};
