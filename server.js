const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const PlaywrightManager = require('./src/playwrightManager');
const { rateLimit } = require('express-rate-limit');
const { validateContentRequest } = require('./src/validation');

// Debug flag for server logging
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';
const fsSync = require('fs'); // For synchronous debug logging

// Debug logging helper
function debugLog(message) {
  if (DEBUG_LOGGING) {
    fsSync.appendFileSync('/tmp/debug.log', `${message}\n`);
  }
}

console.log('Server.js starting...');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
// Add payload size limit (1MB) for security
app.use(express.json({ limit: '1mb' }));

// Rate limiters for security
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  limit: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 15, // Limit each IP to 15 auth requests per windowMs
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'Too many login attempts, please try again after 15 minutes.' }
});

// Apply general rate limiting to all requests
app.use(generalLimiter);

// Request logging middleware
app.use((req, res, next) => {
  const fs = require('fs');
  fs.appendFileSync('/tmp/requests.log', `${new Date().toISOString()} ${req.method} ${req.url}\n`);
  next();
});

// Initialize Playwright manager
const playwrightManager = new PlaywrightManager();

// Routes

// Test route
app.get('/test', (req, res) => {
  const fs = require('fs');
  fs.appendFileSync('/tmp/test.log', `Test route hit at ${new Date().toISOString()}\n`);
  res.json({ message: 'Test route works' });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'drupal-ui-automation'
  });
});

// Playwright readiness check
app.get('/playwright/ready', async (req, res) => {
  try {
    const isReady = playwrightManager.isReady();
    res.json({
      ready: isReady,
      browser: !!playwrightManager.browser,
      context: !!playwrightManager.context,
      page: !!playwrightManager.page
    });
  } catch (error) {
    res.status(500).json({
      ready: false,
      error: error.message
    });
  }
});

// Interactive login - creates fresh browser context for VNC access
app.post('/login/interactive', authLimiter, async (req, res) => {
  try {
    console.log('Starting interactive login process...');
    
    // Close any existing context to start fresh
    console.log('Closing existing browser context...');
    await playwrightManager.close();

    // Small delay to ensure cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 500));

    // Create new interactive context
    console.log('Creating interactive context...');
    const { context, page } = await playwrightManager.createInteractiveContext();
    console.log('Interactive context created successfully');

    // Small delay to ensure context is fully ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Return connection info for noVNC access
    const novncUrl = process.env.NOVNC_URL || 'http://localhost:8080/vnc.html';

    res.json({
      success: true,
      message: 'Interactive login context created',
      novncUrl: novncUrl,
      instructions: `Open the noVNC URL in a browser. The browser will start with about:blank. Manually navigate to ${process.env.DEFAULT_LOGIN_URL || 'your Drupal login page'} and log in. Your session will be captured for programmatic use.`,
      contextId: Date.now().toString()
    });
  } catch (error) {
    console.error('Interactive login error:', error.message);
    console.error('Error details:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.toString(),
      suggestion: 'Check browser launch configuration and Xvfb display'
    });
  }
});

// Check authentication status
app.get('/login/check', authLimiter, async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.json({
        authenticated: false,
        reason: 'No active browser session'
      });
    }

    const authStatus = await playwrightManager.checkAuthentication();
    res.json(authStatus);
  } catch (error) {
    console.error('Auth check error:', error);
    res.status(500).json({
      authenticated: false,
      error: error.message
    });
  }
});

// Navigate to default login URL programmatically
app.post('/login/navigate', authLimiter, async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        success: false,
        error: 'No active browser session. Call /login/interactive first.'
      });
    }

    const defaultUrl = process.env.DEFAULT_LOGIN_URL || 'https://example.com/login';
    console.log('Navigating to default login URL:', defaultUrl);
    
    await playwrightManager.page.goto(defaultUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    res.json({
      success: true,
      message: 'Navigated to default login URL',
      url: defaultUrl,
      instructions: 'Complete login manually via noVNC interface, then save the session with /login/save'
    });
  } catch (error) {
    console.error('Navigation error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      suggestion: 'Check if the URL is accessible and try again'
    });
  }
});

// Save current authentication state
app.post('/login/save', authLimiter, async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        success: false,
        error: 'No active browser session to save'
      });
    }

    await playwrightManager.saveStorageState();
    res.json({
      success: true,
      message: 'Authentication state saved'
    });
  } catch (error) {
    console.error('Save auth state error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Load saved authentication state
app.post('/login/load', authLimiter, async (req, res) => {
  try {
    await playwrightManager.close(); // Close any existing session
    const { context, page } = await playwrightManager.loadAuthenticatedContext();

    // Start internal keepalive after loading session
    playwrightManager.startKeepalive();

    res.json({
      success: true,
      message: 'Authentication state loaded',
      keepalive: playwrightManager.getKeepaliveStatus()
    });
  } catch (error) {
    console.error('Load auth state error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug screenshot
app.get('/debug/screenshot', async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        error: 'No active browser session for screenshot'
      });
    }

    const screenshotPath = await playwrightManager.takeScreenshot();
    res.json({
      success: true,
      screenshotPath: screenshotPath,
      message: 'Screenshot saved to /tmp'
    });
  } catch (error) {
    console.error('Screenshot error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Get keepalive status
app.get('/session/keepalive/status', async (req, res) => {
  try {
    const status = playwrightManager.getKeepaliveStatus();
    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Keepalive endpoint - refreshes session by making a simple request
// Rate-limited to prevent abuse
app.post('/session/keepalive', async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        success: false,
        error: 'Browser not ready. No active browser session.'
      });
    }

    // Rate limiting check (prevent refreshes more than once per minute)
    const now = Date.now();
    const lastRefresh = playwrightManager.keepaliveLastRefresh || 0;
    const timeSinceLastRefresh = now - lastRefresh;
    const minInterval = 60 * 1000; // 1 minute in milliseconds

    if (timeSinceLastRefresh < minInterval) {
      const secondsRemaining = Math.ceil((minInterval - timeSinceLastRefresh) / 1000);
      return res.status(429).json({
        success: false,
        error: `Rate limit exceeded. Please wait ${secondsRemaining} seconds before refreshing again.`,
        rateLimitInfo: {
          minIntervalSeconds: 60,
          secondsRemaining: secondsRemaining,
          lastRefreshTime: new Date(lastRefresh).toISOString()
        }
      });
    }

    // Use the shared performKeepaliveRefresh method
    const success = await playwrightManager.performKeepaliveRefresh();

    if (!success) {
      return res.status(500).json({
        success: false,
        error: 'Keepalive refresh failed. Check server logs for details.',
        circuitBreaker: playwrightManager.getKeepaliveStatus().circuitBreaker
      });
    }

    // Get updated session info
    const cookies = await playwrightManager.context.cookies();
    const sessionCookie = cookies.find(c => c.name.includes('SESS') || c.name.includes('SSESS'));

    const nowSeconds = Date.now() / 1000;
    const expiryInfo = sessionCookie && sessionCookie.expires > 0 ? {
      expiresDate: new Date(sessionCookie.expires * 1000).toISOString(),
      hoursUntilExpiry: Math.round((sessionCookie.expires - nowSeconds) / 3600)
    } : null;

    res.json({
      success: true,
      message: 'Session refreshed',
      sessionExpiry: expiryInfo,
      circuitBreaker: playwrightManager.getKeepaliveStatus().circuitBreaker
    });
  } catch (error) {
    console.error('Keepalive error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug page info
app.get('/debug/page', async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        error: 'No active browser session'
      });
    }

    // Wait a moment to ensure navigation is complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    const url = playwrightManager.page.url();
    const title = await playwrightManager.page.title();
    const isVisible = await playwrightManager.page.isVisible('body');
    
    console.log('Debug page info - URL:', url, 'Title:', title, 'Body visible:', isVisible);
    
    res.json({
      success: true,
      url: url,
      title: title,
      bodyVisible: isVisible,
      message: 'Page info retrieved'
    });
  } catch (error) {
    console.error('Page info error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Query available content types
app.get('/content/types', async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        success: false,
        error: 'No active browser session. Call /login/interactive first.'
      });
    }

    const result = await playwrightManager.queryContentTypes();
    res.json(result);
  } catch (error) {
    console.error('Content types query error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get select field options for a content type's add form
app.get('/content/form-options/:contentType', async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        success: false,
        error: 'No active browser session. Call /login/interactive first.'
      });
    }

    const result = await playwrightManager.getFormSelectOptions(req.params.contentType);
    res.json(result);
  } catch (error) {
    console.error('Form options error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get detailed content information by node ID
app.get('/content/detail/:nodeId', async (req, res) => {
  const fs = require('fs');
  fs.appendFileSync('/tmp/debug.log', `Route hit with params: ${JSON.stringify(req.params)}\n`);
  try {
    fs.appendFileSync('/tmp/debug.log', 'Checking playwright manager ready\n');
    if (!playwrightManager.isReady()) {
      fs.appendFileSync('/tmp/debug.log', 'Manager not ready\n');
      return res.status(400).json({
        success: false,
        error: 'No active browser session. Call /login/interactive first.'
      });
    }

    fs.appendFileSync('/tmp/debug.log', 'Parsing nodeId\n');
    const nodeId = parseInt(req.params.nodeId);
    fs.appendFileSync('/tmp/debug.log', `Parsed nodeId: ${nodeId}\n`);
    if (isNaN(nodeId) || nodeId < 1) {
      fs.appendFileSync('/tmp/debug.log', 'Invalid nodeId\n');
      return res.status(400).json({
        success: false,
        error: 'Invalid node ID. Must be a positive integer.'
      });
    }

    fs.appendFileSync('/tmp/debug.log', 'Calling getContentDetail\n');
    const result = await playwrightManager.getContentDetail(nodeId);
    fs.appendFileSync('/tmp/debug.log', `getContentDetail returned: ${JSON.stringify(result)}\n`);
    res.json(result);
  } catch (error) {
    fs.appendFileSync('/tmp/debug.log', `Content detail error: ${error.message}\n`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create new content
app.post('/content', async (req, res) => {
  debugLog(`POST /content route hit`);
  debugLog(`Request body: ${JSON.stringify(req.body)}`);

  try {
    if (!playwrightManager.isReady()) {
      debugLog('Manager not ready');
      return res.status(400).json({
        success: false,
        error: 'No active browser session. Call /login/interactive first.'
      });
    }

    // Validate request using shared validation function
    const contentType = req.body.contentType;
    const fields = req.body.fields;

    const validationResult = validateContentRequest(contentType, fields);
    if (!validationResult.valid) {
      return res.status(validationResult.statusCode).json({
        success: false,
        error: validationResult.error
      });
    }

    debugLog('Calling createContent');
    const result = await playwrightManager.createContent(contentType, fields);
    debugLog(`createContent returned: ${JSON.stringify(result)}`);

    if (result.success) {
      res.status(201).json(result);
    } else {
      // Determine appropriate status code based on error type
      const statusCode = result.error?.includes('not found') || result.error?.includes('does not exist')
        ? 404
        : result.error?.includes('required') || result.error?.includes('invalid') || result.error?.includes('must')
        ? 400
        : 500;
      res.status(statusCode).json(result);
    }
  } catch (error) {
    debugLog(`Content creation error: ${error.message}`);
    // Determine status code from error message
    const statusCode = error.message?.includes('not found') || error.message?.includes('does not exist')
      ? 404
      : error.message?.includes('required') || error.message?.includes('invalid') || error.message?.includes('must')
      ? 400
      : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

// Update content by node ID
app.put('/content/:nodeId', async (req, res) => {
  debugLog(`PUT /content/:nodeId route hit with params: ${JSON.stringify(req.params)}`);
  debugLog(`Request body: ${JSON.stringify(req.body)}`);

  try {
    if (!playwrightManager.isReady()) {
      debugLog('Manager not ready');
      return res.status(400).json({
        success: false,
        error: 'No active browser session. Call /login/interactive first.'
      });
    }

    debugLog('Parsing nodeId');
    const nodeId = parseInt(req.params.nodeId);
    debugLog(`Parsed nodeId: ${nodeId}`);

    if (isNaN(nodeId) || nodeId < 1) {
      debugLog('Invalid nodeId');
      return res.status(400).json({
        success: false,
        error: 'Invalid node ID. Must be a positive integer.'
      });
    }

    // Validate that updates object is provided
    if (!req.body || typeof req.body !== 'object' || Object.keys(req.body).length === 0) {
      debugLog('No updates provided');
      return res.status(400).json({
        success: false,
        error: 'No updates provided. Request body must contain field updates as key-value pairs.'
      });
    }

    debugLog('Calling updateContent');
    const result = await playwrightManager.updateContent(nodeId, req.body);
    debugLog(`updateContent returned: ${JSON.stringify(result)}`);

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    debugLog(`Content update error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get content list with pagination and filtering
app.get('/content', async (req, res) => {
  try {
    if (!playwrightManager.isReady()) {
      return res.status(400).json({
        success: false,
        error: 'No active browser session. Call /login/interactive first.'
      });
    }

    const limit = parseInt(req.query.limit) || 10;
    const contentType = req.query.type || null;
    const page = parseInt(req.query.page) || 1;

    // Validate limit
    if (limit < 1 || limit > 100) {
      return res.status(400).json({
        success: false,
        error: 'Limit must be between 1 and 100'
      });
    }

    // Validate page
    if (page < 1) {
      return res.status(400).json({
        success: false,
        error: 'Page must be 1 or greater'
      });
    }

    const result = await playwrightManager.queryContent(limit, contentType, page);
    res.json(result);
  } catch (error) {
    console.error('Content query error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Test cleanup endpoint - closes any running browser sessions
app.post('/test/cleanup', async (req, res) => {
  try {
    console.log('Test cleanup: Closing any existing browser sessions');
    await playwrightManager.close();
    
    res.json({
      success: true,
      message: 'Browser sessions cleaned up'
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await playwrightManager.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await playwrightManager.close();
  process.exit(0);
});

// Only start the server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Playwright ready: http://localhost:${PORT}/playwright/ready`);
  });
}

module.exports = app;