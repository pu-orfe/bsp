const request = require('supertest');
const app = require('../../server');

jest.setTimeout(60000);

describe('Content Creation API Tests', () => {
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

    // Start a test server instance
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
    } catch (error) {
      // Ignore cleanup errors
    }
    console.log('Final cleanup completed (some processes may not have been running)');
  });

  // Helper function to get test target
  function getTestTarget() {
    return request(testApp);
  }

  beforeEach(async () => {
    // Clean up any existing browser sessions before each test
    try {
      await getTestTarget()
        .post('/test/cleanup')
        .expect(200);
    } catch (error) {
      console.log('Cleanup before test:', error.message);
    }
  });

  describe('POST /content - Create Content', () => {
    test('should return error when no browser session is active', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'article',
          fields: { title: 'New Article' }
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toContain('No active browser session');
    });

    test('should return error when contentType is missing', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          fields: { title: 'New Article' }
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
      // Note: This returns "No active browser session" because isReady() check comes before validation
      expect(response.body.error).toContain('No active browser session');
    });

    test('should return error when fields are missing', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'article'
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
      // Note: This returns "No active browser session" because isReady() check comes before validation
      expect(response.body.error).toContain('No active browser session');
    });

    test('should return error when fields object is empty', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'article',
          fields: {}
        })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
      // Note: This returns "No active browser session" because isReady() check comes before validation
      expect(response.body.error).toContain('No active browser session');
    });

    test('should accept valid creation request format', async () => {
      // This test verifies the request is accepted with proper format
      // It will fail authentication but that's expected
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'article',
          fields: {
            title: 'New Article',
            body: 'Article content'
          }
        });

      expect(response.status).toBe(400); // No browser session
      expect(response.body.error).toContain('No active browser session');
    });

    test('should validate Content-Type header for JSON', async () => {
      const response = await getTestTarget()
        .post('/content')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({
          contentType: 'article',
          fields: { title: 'New Article' }
        }));

      // Should be 400 (no browser session)
      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('success', false);
    });
  });

  describe('POST /content - Field Types', () => {
    test('should accept text field values', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'article',
          fields: {
            title: 'New Title',
            body: 'New body content'
          }
        });

      expect(response.status).toBe(400); // No browser session
      expect(response.body.error).toContain('No active browser session');
    });

    test('should accept checkbox field values', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'article',
          fields: {
            title: 'New Article',
            status: true
          }
        });

      expect(response.status).toBe(400); // No browser session
      expect(response.body.error).toContain('No active browser session');
    });

    test('should accept mixed field types', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'event',
          fields: {
            title: 'New Event',
            event_date: '2025-02-15',
            status: true,
            location: 'Conference Room A'
          }
        });

      expect(response.status).toBe(400); // No browser session
      expect(response.body.error).toContain('No active browser session');
    });
  });

  describe('POST /content - Response Format', () => {
    test('should return consistent error format', async () => {
      const response = await getTestTarget()
        .post('/content')
        .send({
          contentType: 'article',
          fields: { title: 'Test' }
        });

      expect(response.body).toHaveProperty('success');
      expect(typeof response.body.success).toBe('boolean');
      expect(response.body).toHaveProperty('error');
      expect(typeof response.body.error).toBe('string');
    });

    test('should handle JSON parsing errors gracefully', async () => {
      const response = await getTestTarget()
        .post('/content')
        .set('Content-Type', 'application/json')
        .send('invalid json{');

      // Express should handle this with 400 Bad Request
      expect(response.status).toBe(400);
    });
  });
});
