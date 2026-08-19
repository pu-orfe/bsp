const request = require('supertest');
const { chromium } = require('playwright');

const app = require('../../server');

jest.setTimeout(60000);

// Determine test target based on environment
const isInContainer = process.env.NODE_ENV === 'test';
const testTarget = isInContainer ? app : app; // Always use the app directly

describe('Browser Auto-Launch and Navigation Tests', () => {
  let testApp;

  beforeAll(async () => {
    // Start Xvfb for browser testing in containerized environments
    if (process.env.NODE_ENV === 'test' && process.platform === 'linux') {
      try {
        const { exec } = require('child_process');
        console.log('Starting Xvfb for integration tests...');
        exec('Xvfb :99 -screen 0 1024x768x24 &', (error, stdout, stderr) => {
          if (error) {
            console.log('Xvfb start output:', stdout);
            console.log('Xvfb start error:', stderr);
          }
        });
        // Wait for Xvfb to initialize
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('Xvfb started for integration tests');
      } catch (error) {
        console.log('Failed to start Xvfb:', error.message);
      }
    }

    // Always start a test server instance for integration tests
    testApp = app.listen(3001);
    console.log('Integration test server started on port 3001');
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
          console.log('Integration test server stopped');
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

  describe('Browser Auto-Launch Prevention', () => {
    test('should not auto-launch browser on server start', async () => {
      // Test that the server starts without launching a browser
      // This is validated by checking that /playwright/ready returns false initially
      const response = await getTestTarget()
        .get('/playwright/ready')
        .expect(200);

      // Initially, no browser should be running
      expect(response.body.ready).toBe(false);
      expect(response.body.browser).toBe(false);
      expect(response.body.context).toBe(false);
      expect(response.body.page).toBe(false);
    });

    test('should only launch browser when explicitly requested via API', async () => {
      // Initially no browser
      let response = await getTestTarget()
        .get('/playwright/ready')
        .expect(200);

      expect(response.body.ready).toBe(false);

      // Create interactive context - this should launch the browser
      const interactiveResponse = await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      expect(interactiveResponse.body.success).toBe(true);

      // Now browser should be ready
      response = await getTestTarget()
        .get('/playwright/ready')
        .expect(200);

      expect(response.body.ready).toBe(true);
      expect(response.body.browser).toBe(true);
      expect(response.body.context).toBe(true);
      expect(response.body.page).toBe(true);
    });
  });

  describe('Default URL Auto-Load Prevention', () => {
    test('should start browser with about:blank, not default URL', async () => {
      // Create interactive context
      const interactiveResponse = await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      expect(interactiveResponse.body.success).toBe(true);

      // Check that the page is at about:blank, not the default URL
      const pageResponse = await getTestTarget()
        .get('/debug/page')
        .expect(200);

      expect(pageResponse.body.success).toBe(true);
      expect(pageResponse.body.url).toBe('about:blank');
      expect(pageResponse.body.title).toBe('');
      expect(pageResponse.body.bodyVisible).toBe(true);

      // Ensure it's NOT at the default URL
      const defaultUrl = process.env.DEFAULT_LOGIN_URL || 'https://example.com/login';
      expect(pageResponse.body.url).not.toBe(defaultUrl);
      expect(pageResponse.body.url).not.toContain('princeton.edu');
    });

    test('should not automatically navigate to default URL', async () => {
      // Create interactive context
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      // Wait a moment to ensure no automatic navigation occurs
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check that page is still at about:blank
      const pageResponse = await getTestTarget()
        .get('/debug/page')
        .expect(200);

      expect(pageResponse.body.url).toBe('about:blank');
      expect(pageResponse.body.title).toBe('');
    });

    test('should provide manual navigation instructions', async () => {
      const response = await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.instructions).toContain('about:blank');
      expect(response.body.instructions).toContain('Manually navigate');

      // Should contain the configured login URL (from DEFAULT_LOGIN_URL env var)
      const expectedUrl = process.env.DEFAULT_LOGIN_URL || 'https://example.com/login';
      expect(response.body.instructions).toContain(expectedUrl);
    });
  });

  describe('Playwright Control Validation', () => {
    test('should have browser under Playwright control', async () => {
      // Create interactive context
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      // Check that browser is ready and controllable
      const readyResponse = await getTestTarget()
        .get('/playwright/ready')
        .expect(200);

      expect(readyResponse.body.ready).toBe(true);
      expect(readyResponse.body.browser).toBe(true);
      expect(readyResponse.body.context).toBe(true);
      expect(readyResponse.body.page).toBe(true);

      // Verify we can still get page info (this should always work)
      const pageResponse = await getTestTarget()
        .get('/debug/page')
        .expect(200);
      
      expect(pageResponse.body.url).toBeDefined();
      expect(pageResponse.body.title).toBeDefined();

      // Note: Screenshot functionality may not work in containerized CI environments
      // but page interaction and control validation above confirms Playwright control
    }, 60000);

    test('should maintain control without automatic navigation', async () => {
      // Create interactive context
      await getTestTarget()
        .post('/login/interactive')
        .expect(200);

      // Verify initial state
      let pageResponse = await getTestTarget()
        .get('/debug/page')
        .expect(200);

      expect(pageResponse.body.url).toBe('about:blank');

      // Wait and verify it stays at about:blank
      await new Promise(resolve => setTimeout(resolve, 3000));

      pageResponse = await getTestTarget()
        .get('/debug/page')
        .expect(200);

      expect(pageResponse.body.url).toBe('about:blank');
      expect(pageResponse.body.bodyVisible).toBe(true);
    });
  });
});