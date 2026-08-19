const request = require('supertest');
const app = require('../../server');

jest.setTimeout(60000);

// Determine test target based on environment
const isInContainer = process.env.NODE_ENV === 'test';

describe('Keepalive API Tests', () => {
  let testApp;

  beforeAll(async () => {
    // Start Xvfb for browser testing in containerized environments
    if (process.env.NODE_ENV === 'test' && process.platform === 'linux') {
      try {
        const { exec } = require('child_process');
        console.log('Starting Xvfb for keepalive tests...');
        exec('Xvfb :99 -screen 0 1024x768x24 &', (error, stdout, stderr) => {
          if (error) {
            console.log('Xvfb start output:', stdout);
            console.log('Xvfb start error:', stderr);
          }
        });
        // Wait for Xvfb to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('Xvfb started for keepalive tests');
      } catch (error) {
        console.log('Failed to start Xvfb:', error.message);
      }
    }

    // Always start a test server instance for integration tests
    testApp = app.listen(3002);
    console.log('Keepalive test server started on port 3002');
  });

  afterAll(async () => {
    if (testApp) {
      try {
        await request(testApp)
          .post('/test/cleanup')
          .expect(200);
      } catch (error) {
        console.log('Final API cleanup failed:', error.message);
      }
    }

    if (testApp) {
      // Close the test server
      await new Promise((resolve, reject) => {
        testApp.close(error => {
          if (error) {
            return reject(error);
          }
          console.log('Keepalive test server stopped');
          return resolve();
        });
      });
      testApp = null;
    }

    // Additional cleanup for any remaining browser processes
    try {
      console.log('Performing final cleanup...');
      const { execSync } = require('child_process');
      execSync('pkill -f chromium || true');
      execSync('pkill -f chrome || true');
      console.log('Final cleanup completed');
    } catch (error) {
      console.log('Final cleanup completed (some processes may not have been running)');
    }
  });

  // Helper function to get the correct test target
  const getTestTarget = () => request(testApp);

  beforeEach(async () => {
    // Clean up any existing browser sessions before each test
    try {
      await getTestTarget()
        .post('/test/cleanup')
        .expect(200);
    } catch (error) {
      // Cleanup might fail if no sessions exist, that's ok
      console.log('Cleanup before test:', error.message);
    }
  });

  describe('GET /session/keepalive/status', () => {
    test('should return keepalive status before session is loaded', async () => {
      const response = await getTestTarget()
        .get('/session/keepalive/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.enabled).toBeDefined();
      expect(response.body.running).toBeDefined();
      expect(response.body.intervalMinutes).toBeDefined();
      expect(typeof response.body.enabled).toBe('boolean');
      expect(typeof response.body.running).toBe('boolean');
      expect(typeof response.body.intervalMinutes).toBe('number');

      // Check circuit breaker state
      expect(response.body.circuitBreaker).toBeDefined();
      expect(response.body.circuitBreaker.open).toBe(false);
      expect(response.body.circuitBreaker.consecutiveFailures).toBe(0);
      expect(response.body.circuitBreaker.maxFailures).toBeDefined();
    });

    test('should respect KEEPALIVE_ENABLED environment variable', async () => {
      // This test verifies that the status endpoint returns the configured value
      const response = await getTestTarget()
        .get('/session/keepalive/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      // Default should be enabled (true) unless explicitly set to false
      if (process.env.KEEPALIVE_ENABLED === 'false') {
        expect(response.body.enabled).toBe(false);
      } else {
        expect(response.body.enabled).toBe(true);
      }
    });

    test('should show correct interval from environment variable', async () => {
      const response = await getTestTarget()
        .get('/session/keepalive/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      // Should match KEEPALIVE_INTERVAL_MINUTES if set, otherwise default to 60
      const expectedInterval = parseInt(process.env.KEEPALIVE_INTERVAL_MINUTES) || 60;
      expect(response.body.intervalMinutes).toBe(expectedInterval);
    });
  });

  describe('POST /session/keepalive', () => {
    test('should return error when browser is not ready', async () => {
      const response = await getTestTarget()
        .post('/session/keepalive')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('not ready');
    });

    test('should refresh session successfully when browser is ready', async () => {
      // First create an interactive context
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      // Now try to refresh the session
      const response = await getTestTarget()
        .post('/session/keepalive')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Session refreshed');
    });

    test('should return session expiry information when available', async () => {
      // Create interactive context
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      // Refresh session
      const response = await getTestTarget()
        .post('/session/keepalive')
        .expect(200);

      expect(response.body.success).toBe(true);
      // Session expiry might not always be present (depends on cookie type)
      // Just verify the response structure is correct
      if (response.body.sessionExpiry) {
        expect(response.body.sessionExpiry).toHaveProperty('expiresDate');
        expect(response.body.sessionExpiry).toHaveProperty('hoursUntilExpiry');
      }
    });
  });

  describe('POST /login/load with keepalive', () => {
    test('should start keepalive automatically when loading session', async () => {
      // First create and save a session
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      await getTestTarget()
        .post('/login/save')
        .expect(200);

      // Now load the session - this should start keepalive
      const loadResponse = await getTestTarget()
        .post('/login/load')
        .expect(200);

      expect(loadResponse.body.success).toBe(true);
      expect(loadResponse.body.keepalive).toBeDefined();
      expect(loadResponse.body.keepalive.enabled).toBeDefined();
      expect(loadResponse.body.keepalive.running).toBeDefined();
      expect(loadResponse.body.keepalive.intervalMinutes).toBeDefined();

      // Verify keepalive is running
      const statusResponse = await getTestTarget()
        .get('/session/keepalive/status')
        .expect(200);

      // If keepalive is enabled, it should be running after loading session
      if (statusResponse.body.enabled) {
        expect(statusResponse.body.running).toBe(true);
      }
    });

    test('should not start keepalive when KEEPALIVE_ENABLED=false', async () => {
      // This test assumes KEEPALIVE_ENABLED is set to false
      // Skip if it's enabled
      if (process.env.KEEPALIVE_ENABLED !== 'false') {
        console.log('Skipping test - KEEPALIVE_ENABLED is not false');
        return;
      }

      // Create and save a session
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      await getTestTarget()
        .post('/login/save')
        .expect(200);

      // Load the session
      const loadResponse = await getTestTarget()
        .post('/login/load')
        .expect(200);

      expect(loadResponse.body.success).toBe(true);
      expect(loadResponse.body.keepalive.enabled).toBe(false);
      expect(loadResponse.body.keepalive.running).toBe(false);
    });
  });

  describe('Keepalive interaction with browser lifecycle', () => {
    test('should stop keepalive when browser is closed', async () => {
      // Create interactive context
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      // Save session
      await getTestTarget()
        .post('/login/save')
        .expect(200);

      // Load session (starts keepalive)
      await getTestTarget()
        .post('/login/load')
        .expect(200);

      // Verify keepalive is running (if enabled)
      const statusBefore = await getTestTarget()
        .get('/session/keepalive/status')
        .expect(200);

      // Close the browser
      await getTestTarget()
        .post('/test/cleanup')
        .expect(200);

      // Verify keepalive is stopped
      const statusAfter = await getTestTarget()
        .get('/session/keepalive/status')
        .expect(200);

      expect(statusAfter.body.running).toBe(false);
    });
  });
});
