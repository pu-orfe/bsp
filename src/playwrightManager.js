const { chromium } = require('playwright');
const fs = require('fs').promises;
const fsSync = require('fs'); // For synchronous operations like appendFileSync
const path = require('path');
const { validateContentRequest } = require('./validation');

// Debug flag - set DEBUG_LOGGING=true to enable detailed logging
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true';

// Timeout constants (in milliseconds)
const TIMEOUTS = {
  NAVIGATION: 30000,        // Page navigation timeout
  FORM_LOAD: 10000,         // Form element load timeout
  DOM_CONTENT_LOADED: 5000, // DOM content loaded timeout
  NETWORK_IDLE: 30000,      // Network idle timeout
  SHUTDOWN: 10000           // Per-resource limit when tearing the browser down
};

// Bound a shutdown step so a wedged browser process cannot hang close()
// forever. Callers drop the resource reference either way, and the surviving
// OS process is reaped by the container/test teardown.
function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Input validation constants
const VALIDATION = {
  MAX_TEXT_LENGTH: 10000,      // Maximum length for text fields
  MAX_TEXTAREA_LENGTH: 50000,  // Maximum length for textarea fields
  MAX_FIELDS_COUNT: 50         // Maximum number of fields in one request
};

console.log('PlaywrightManager module loaded');

class PlaywrightManager {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.storageDir = path.join(process.cwd(), 'storage');
    this.storageStatePath = path.join(this.storageDir, 'storageState.json');
    this.display = process.env.DISPLAY || ':99';
    this.keepaliveInterval = null;
    this.keepaliveEnabled = process.env.KEEPALIVE_ENABLED !== 'false'; // Default: enabled

    // Validate and constrain keepalive interval (min: 5 minutes, max: 1440 minutes/24 hours)
    const intervalMinutes = parseInt(process.env.KEEPALIVE_INTERVAL_MINUTES, 10) || 60;
    this.keepaliveIntervalMinutes = Math.max(5, Math.min(1440, intervalMinutes));
    if (intervalMinutes !== this.keepaliveIntervalMinutes) {
      console.warn(`KEEPALIVE_INTERVAL_MINUTES=${intervalMinutes} out of range. Constrained to ${this.keepaliveIntervalMinutes} minutes (valid range: 5-1440)`);
    }

    this.keepaliveConsecutiveFailures = 0;
    this.keepaliveMaxFailures = parseInt(process.env.KEEPALIVE_MAX_FAILURES, 10) || 3; // Circuit breaker threshold
    this.keepaliveCircuitOpen = false;
    this.keepaliveLastRefresh = null; // Track last successful refresh
  }

  // Debug logging helper
  debugLog(message, ...args) {
    if (DEBUG_LOGGING) {
      console.log(`DEBUG: ${message}`, ...args);
    }
  }

  // File debug logging helper
  debugFileLog(logFile, message) {
    if (DEBUG_LOGGING) {
      fsSync.appendFileSync(logFile, message);
    }
  }

  // URL construction helper - ensures no double slashes
  buildUrl(baseUrl, ...pathSegments) {
    // Remove trailing slash from baseUrl
    const normalizedBase = baseUrl.replace(/\/$/, '');
    // Join path segments and ensure they start with /
    const path = pathSegments.map(seg => seg.replace(/^\/+/, '')).join('/');
    return `${normalizedBase}/${path}`;
  }

  /**
   * Extra HTTP headers applied to every browser request.
   *
   * Some sites sit behind a WAF/bot filter that only lets automated traffic
   * through when a specific header is present (e.g. Cloudflare bypass headers).
   * Configure with EXTRA_HTTP_HEADERS as a JSON object, e.g.
   *   EXTRA_HTTP_HEADERS={"x-wdsoit-bot-bypass":"true"}
   *
   * @returns {Object|null} Header map, or null when none are configured/valid
   */
  getExtraHTTPHeaders() {
    const raw = process.env.EXTRA_HTTP_HEADERS;
    if (!raw || !raw.trim()) {
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(`Ignoring EXTRA_HTTP_HEADERS: not valid JSON (${error.message})`);
      return null;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('Ignoring EXTRA_HTTP_HEADERS: expected a JSON object of header name/value pairs');
      return null;
    }

    const headers = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (value === null || value === undefined || typeof value === 'object') {
        console.warn(`Ignoring EXTRA_HTTP_HEADERS entry "${name}": value must be a string, number, or boolean`);
        continue;
      }
      headers[name] = String(value);
    }

    const names = Object.keys(headers);
    if (names.length === 0) {
      return null;
    }

    // Log names only - header values can be secrets
    console.log('Applying extra HTTP headers to browser context:', names.join(', '));
    return headers;
  }

  /**
   * Build newContext() options, merging in any configured extra HTTP headers.
   *
   * @param {Object} options - Base context options
   * @returns {Object} Context options including extraHTTPHeaders when configured
   */
  buildContextOptions(options = {}) {
    const extraHTTPHeaders = this.getExtraHTTPHeaders();
    return extraHTTPHeaders ? { ...options, extraHTTPHeaders } : { ...options };
  }

  async ensureStorageDir() {
    try {
      await fs.access(this.storageDir);
    } catch {
      await fs.mkdir(this.storageDir, { recursive: true });
    }
  }

  async launchBrowser() {
    if (this.browser) {
      return this.browser;
    }

    // Prevent launching browser on host system - only allow in container with proper display
    if (process.env.NODE_ENV !== 'test' && (!process.env.DISPLAY || process.env.DISPLAY !== ':99')) {
      throw new Error('Browser launch only allowed in container environment with DISPLAY=:99');
    }

    console.log('Launching browser with display:', this.display);
    console.log('DISPLAY environment variable:', process.env.DISPLAY);
    console.log('NODE_ENV:', process.env.NODE_ENV);

    try {
      // Launch browser in headful mode for Docker/Xvfb compatibility
      this.browser = await chromium.launch({
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          `--display=${this.display}`,
          '--window-size=1280,720'
        ]
      });
      console.log('Browser launched successfully with display:', this.display);
      
      // Verify browser is actually connected to our display
      const pages = this.browser.contexts()[0]?.pages() || [];
      console.log('Browser has', pages.length, 'pages after launch');
      
      // Wait a moment for browser to connect to display
      await new Promise(resolve => setTimeout(resolve, 1000));
      return this.browser;
    } catch (error) {
      console.error('Failed to launch browser:', error);
      console.error('Error details:', error.message);
      console.error('Error stack:', error.stack);
      throw error;
    }
  }

  async createInteractiveContext() {
    console.log('Creating interactive context...');
    await this.ensureStorageDir();
    const browser = await this.launchBrowser();
    console.log('Browser instance obtained:', !!browser);

    // Create fresh context for interactive login (don't load existing storageState)
    this.context = await browser.newContext(this.buildContextOptions({
      viewport: { width: 1280, height: 720 }
    }));
    console.log('Context created successfully');

    this.page = await this.context.newPage();
    console.log('Page created successfully');
    
    // Add event listeners to track navigation
    this.page.on('framenavigated', frame => {
      console.log('Frame navigated:', frame.url());
    });
    this.page.on('domcontentloaded', () => {
      console.log('DOMContentLoaded event fired');
    });
    this.page.on('load', () => {
      console.log('Load event fired');
    });
    
    // For interactive login, start with about:blank and let user navigate manually
    const defaultUrl = process.env.DEFAULT_LOGIN_URL || 'https://example.com/login';
    console.log('Setting up interactive login for:', defaultUrl);
    
    try {
      // Start with about:blank to avoid any automation detection
      await this.page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.DOM_CONTENT_LOADED });
      console.log('Started with about:blank');
      
      // Don't try to navigate automatically - let the user do it manually
      console.log('User will need to manually navigate to:', defaultUrl);
      
    } catch (error) {
      console.error('Failed to initialize page:', error.message);
    }
    
    console.log('Interactive context created - user must navigate manually');
    return { context: this.context, page: this.page };
  }

  async loadAuthenticatedContext() {
    await this.ensureStorageDir();
    const browser = await this.launchBrowser();

    try {
      // Try to load existing authenticated context
      const storageState = JSON.parse(await fs.readFile(this.storageStatePath, 'utf8'));
      this.context = await browser.newContext(this.buildContextOptions({ storageState }));
      this.page = await this.context.newPage();
      
      // Navigate to the base URL to establish the session context
      const baseUrl = process.env.BASE_URL;
      if (baseUrl) {
        console.log('Navigating to base URL after loading session:', baseUrl);
        await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
      } else {
        console.warn('BASE_URL not set, session may not work correctly');
      }
      
      console.log('Authenticated context loaded');
      return { context: this.context, page: this.page };
    } catch (error) {
      console.log('No valid storage state found, creating fresh context');
      return await this.createInteractiveContext();
    }
  }

  async saveStorageState() {
    if (!this.context) {
      throw new Error('No context available to save');
    }

    await this.ensureStorageDir();
    const storageState = await this.context.storageState();
    await fs.writeFile(this.storageStatePath, JSON.stringify(storageState, null, 2));
    console.log('Storage state saved');
  }

  async checkAuthentication() {
    if (!this.page) {
      return { authenticated: false, reason: 'No active page' };
    }

    try {
      // Check for Drupal admin indicators
      const adminIndicators = [
        'text=/Administration/',
        'text=/Content/',
        'text=/Structure/',
        '[data-drupal-selector="edit-submit"]'
      ];

      for (const indicator of adminIndicators) {
        try {
          await this.page.waitForSelector(indicator, { timeout: 2000 });
          return { authenticated: true, adminAccess: true };
        } catch {
          // Continue checking other indicators
        }
      }

      // Check if we're on a login page
      const loginIndicators = [
        'text=/Log in/',
        '[name="name"]',
        '[name="pass"]'
      ];

      for (const indicator of loginIndicators) {
        try {
          await this.page.waitForSelector(indicator, { timeout: 2000 });
          return { authenticated: false, reason: 'On login page' };
        } catch {
          // Continue checking
        }
      }

      return { authenticated: false, reason: 'No authentication indicators found' };
    } catch (error) {
      return { authenticated: false, reason: `Error checking auth: ${error.message}` };
    }
  }

  async takeScreenshot(filename = 'debug-screenshot.png') {
    if (!this.page) {
      throw new Error('No active page for screenshot');
    }

    const screenshotPath = path.join('/tmp', filename);
    await this.page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  async queryContentTypes() {
    if (!this.page) {
      throw new Error('No active page for content type query');
    }

    try {
      // Get the base URL from environment
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        throw new Error('BASE_URL environment variable is required for content type queries');
      }

      // Ensure we're on the correct domain
      const currentUrl = this.page.url();
      const currentDomain = new URL(currentUrl).hostname;
      const targetDomain = new URL(baseUrl).hostname;

      if (currentDomain !== targetDomain) {
        console.log(`Current domain (${currentDomain}) doesn't match target (${targetDomain}), navigating to base URL`);
        await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
      }

      // First try the admin structure page
      const adminUrl = this.buildUrl(baseUrl, 'admin/structure/types');
      console.log('Attempting to access content types via admin:', adminUrl);
      
      try {
        await this.page.goto(adminUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.FORM_LOAD });
        
        // Check if we can access the admin page (look for the table)
        const tableExists = await this.page.locator('table').count() > 0;
        
        if (tableExists) {
          console.log('Successfully accessed admin content types page');
          // Extract content type information from the admin table
          const contentTypes = await this.page.evaluate(() => {
            const table = document.querySelector('table');
            if (!table) return [];

            const rows = table.querySelectorAll('tbody tr');
            const types = [];

            rows.forEach(row => {
              const cells = row.querySelectorAll('td');
              if (cells.length >= 3) {
                const nameCell = cells[0];
                const machineNameCell = cells[1];
                const descriptionCell = cells[2];

                // Extract the machine name from the operations links
                const operationsCell = cells[cells.length - 1];
                const editLink = operationsCell.querySelector('a[href*="edit"]');
                let machineName = '';
                if (editLink) {
                  const href = editLink.getAttribute('href');
                  const match = href.match(/\/admin\/structure\/types\/manage\/([^\/]+)/);
                  if (match) machineName = match[1];
                }

                types.push({
                  name: nameCell.textContent.trim(),
                  machineName: machineName || machineNameCell.textContent.trim(),
                  description: descriptionCell.textContent.trim()
                });
              }
            });

            return types;
          });

          console.log(`Found ${contentTypes.length} content types via admin page`);
          return {
            success: true,
            contentTypes: contentTypes,
            count: contentTypes.length,
            source: 'admin'
          };
        }
      } catch (adminError) {
        console.log('Admin content types page not accessible, trying /node/add fallback');
      }
      
      // Fallback: Try /node/add page
      const nodeAddUrl = this.buildUrl(baseUrl, 'node/add');
      console.log('Attempting to access content types via node/add:', nodeAddUrl);
      
      await this.page.goto(nodeAddUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.FORM_LOAD });
      
      // Extract content types from the node/add page
      const contentTypes = await this.page.evaluate(() => {
        // Look for content type links in various possible formats
        const typeLinks = document.querySelectorAll('a[href*="/node/add/"]');
        const types = [];
        
        typeLinks.forEach(link => {
          const href = link.getAttribute('href');
          const match = href.match(/\/node\/add\/([^\/\?]+)/);
          if (match) {
            const machineName = match[1];
            // Skip if we already have this type
            if (!types.find(t => t.machineName === machineName)) {
        types.push({
          name: link.textContent.trim(),
          machineName: machineName,
          description: '', // Description not available on node/add page
          createUrl: href
        });
            }
          }
        });
        
        return types;
      });

      console.log(`Found ${contentTypes.length} content types via node/add page`);
      return {
        success: true,
        contentTypes: contentTypes,
        count: contentTypes.length,
        source: 'node_add'
      };
    } catch (error) {
      console.error('Error querying content types:', error);
      return {
        success: false,
        error: error.message,
        suggestion: 'Ensure BASE_URL is set and you are logged in with appropriate permissions'
      };
    }
  }

  async queryContent(limit = 10, contentType = null, page = 1) {
    if (!this.page) {
      throw new Error('No active page for content query');
    }

    try {
      // Get the base URL from environment
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        throw new Error('BASE_URL environment variable is required for content queries');
      }

      // Ensure we're on the correct domain
      const currentUrl = this.page.url();
      const currentDomain = new URL(currentUrl).hostname;
      const targetDomain = new URL(baseUrl).hostname;

      if (currentDomain !== targetDomain) {
        console.log(`Current domain (${currentDomain}) doesn't match target (${targetDomain}), navigating to base URL`);
        await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
      }

      // Navigate to admin content page with pagination
      let contentUrl = this.buildUrl(baseUrl, 'admin/content');
      if (page > 1) {
        contentUrl += `?page=${page - 1}`; // Drupal uses 0-based page indexing
      }
      console.log('Navigating to admin content page:', contentUrl);
      
      await this.page.goto(contentUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });

      // Wait for the content table to load
      await this.page.waitForSelector('table', { timeout: TIMEOUTS.FORM_LOAD });

      // Extract content information from the table
      const result = await this.page.evaluate(({ limit, contentType, page }) => {
        console.log('Evaluating page content...');

        // Look for any table on the page
        const tables = document.querySelectorAll('table');
        console.log(`Found ${tables.length} tables on the page`);

        if (tables.length === 0) {
          console.log('No tables found on the page');
          return { content: [], hasNextPage: false, hasPrevPage: page > 1 };
        }

        // Prefer a table that looks like the admin content listing (has Title
        // and Status headers); fall back to the first table on the page.
        const headerTexts = table => Array.from(table.querySelectorAll('thead th'))
          .map(th => th.textContent.trim().toLowerCase());

        let table = tables[0];
        for (const candidate of tables) {
          const heads = headerTexts(candidate);
          if (heads.some(h => h.startsWith('title')) && heads.some(h => h.startsWith('status'))) {
            table = candidate;
            break;
          }
        }

        // Map columns by header label rather than fixed positions - Drupal
        // sites reorder these columns and add a bulk-operations checkbox column.
        const heads = headerTexts(table);
        const findColumn = (names, fallback) => {
          const index = heads.findIndex(head => names.some(name => head.startsWith(name)));
          return index >= 0 ? index : fallback;
        };

        const columns = {
          title: findColumn(['title'], 0),
          type: findColumn(['content type', 'type'], 2),
          status: findColumn(['status'], 3),
          updated: findColumn(['updated'], 4),
          created: findColumn(['created'], 5),
          author: findColumn(['author'], -1),
          operations: findColumn(['operations'], 6)
        };
        console.log('Column map:', JSON.stringify(columns));

        const rows = table.querySelectorAll('tbody tr');
        console.log('Found', rows.length, 'rows in table');

        const cellAt = (cells, index) => (index >= 0 && cells[index] ? cells[index] : null);
        const textAt = (cells, index) => {
          const cell = cellAt(cells, index);
          return cell ? cell.textContent.trim() : '';
        };
        const firstLine = text => (text.split('\n').map(part => part.trim()).filter(Boolean)[0] || '');

        const contentItems = [];

        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 3) continue;

          // Title cell holds a link to the node plus, on some themes, the path
          const titleCell = cellAt(cells, columns.title);
          const titleLink = titleCell ? titleCell.querySelector('a') : null;
          const title = titleLink
            ? titleLink.textContent.trim()
            : firstLine(textAt(cells, columns.title)) || 'Unknown';

          const pathElement = titleCell ? titleCell.querySelector('.node-path') : null;
          const contentPath = pathElement
            ? pathElement.textContent.trim()
            : (titleLink ? titleLink.getAttribute('href') || '' : '');

          const type = firstLine(textAt(cells, columns.type)) || 'Unknown';

          // Status cells can carry extra markers (e.g. a "Restricted" badge).
          // Keep the plain Published/Unpublished value and flag the rest.
          const statusCell = cellAt(cells, columns.status);
          let status = 'Unknown';
          let restricted = false;
          if (statusCell) {
            restricted = !!statusCell.querySelector('.restricted-indicator');
            const directText = Array.from(statusCell.childNodes)
              .filter(node => node.nodeType === 3)
              .map(node => node.textContent.trim())
              .filter(Boolean)
              .join(' ');
            status = directText || firstLine(statusCell.textContent) || 'Unknown';
          }

          // Date cells contain the timestamp followed by the acting user
          const updatedField = textAt(cells, columns.updated);
          const updated = firstLine(updatedField);
          const createdField = textAt(cells, columns.created);
          const created = firstLine(createdField);

          let author = 'Unknown';
          if (columns.author >= 0) {
            author = firstLine(textAt(cells, columns.author)) || 'Unknown';
          } else {
            const authorMatch = updatedField.match(/\n\s*\n\s*\n?\s*([^\n]+)/);
            if (authorMatch) author = authorMatch[1].trim();
          }

          // Operations cell holds the edit link; fall back to any edit link in the row
          const operationsCell = cellAt(cells, columns.operations) || cells[cells.length - 1];
          let editLink = operationsCell ? operationsCell.querySelector('a[href*="/edit"]') : null;
          if (!editLink) editLink = row.querySelector('a[href*="/edit"]');
          const editUrl = editLink ? editLink.getAttribute('href') : null;

          // Node ID can come from the edit link or the node path
          let nodeId = null;
          const idSource = editUrl || (titleLink ? titleLink.getAttribute('href') : '') || contentPath;
          const idMatch = idSource ? idSource.match(/\/node\/(\d+)/) : null;
          if (idMatch) nodeId = parseInt(idMatch[1], 10);

          // Apply content type filter if specified
          if (contentType && type.toLowerCase() !== contentType.toLowerCase()) {
            continue;
          }

          contentItems.push({
            id: nodeId,
            title: title,
            contentTitle: contentPath,
            type: type,
            status: status,
            restricted: restricted,
            author: author,
            updated: updated,
            created: created,
            editUrl: editUrl,
            viewUrl: nodeId ? `/node/${nodeId}` : null
          });

          // Filter first, then cap - otherwise a type filter silently drops
          // matching rows that sit past the limit in the unfiltered table
          if (contentItems.length >= limit) break;
        }

        // Check for pagination information
        let hasNextPage = false;
        let hasPrevPage = page > 1;
        let totalPages = 1;
        let totalItems = contentItems.length;
        let currentPageRange = null;
        
        // Look for pagination elements (Drupal-specific patterns)
        const pagerLinks = document.querySelectorAll('.pager a, .pagination a, a[title*="next"], a[title*="previous"], .pager__link');
        const nextLinks = Array.from(pagerLinks).filter(link => 
          link.textContent.toLowerCase().includes('next') || 
          link.textContent.includes('›') ||
          link.textContent.includes('»') ||
          link.getAttribute('title')?.toLowerCase().includes('next') ||
          link.classList.contains('pager__link--next')
        );
        
        if (nextLinks.length > 0) {
          hasNextPage = true;
        }

        // Extract total pages from pagination links (look for numbered page links)
        const pageNumberLinks = Array.from(pagerLinks).filter(link => {
          const text = link.textContent.trim();
          const href = link.getAttribute('href') || '';
          // Look for numeric links or links with page parameters
          return /^\d+$/.test(text) || href.includes('page=');
        });
        
        if (pageNumberLinks.length > 0) {
          const pageNumbers = pageNumberLinks.map(link => {
            const text = link.textContent.trim();
            if (/^\d+$/.test(text)) {
              return parseInt(text);
            }
            // Extract page number from href
            const href = link.getAttribute('href') || '';
            const match = href.match(/[?&]page=(\d+)/);
            return match ? parseInt(match[1]) + 1 : null; // Convert 0-based to 1-based
          }).filter(num => num !== null && !isNaN(num));
          
          if (pageNumbers.length > 0) {
            totalPages = Math.max(...pageNumbers);
          }
        }

        // Look for Drupal-specific pagination text patterns
        const pagerTextElements = document.querySelectorAll('.pager .pager-text, .pagination-info, .pager-info, .pager__text');
        for (const element of pagerTextElements) {
          const text = element.textContent.trim();
          console.log('Found pager text element:', text);
          
          // Try to extract total items from patterns like "Showing 1-50 of 250 items"
          const totalMatch = text.match(/of\s+(\d+)\s+items?/i) || 
                           text.match(/(\d+)\s+total/i) || 
                           text.match(/total:?\s*(\d+)/i) ||
                           text.match(/(\d+)\s+results?/i);
          if (totalMatch) {
            totalItems = parseInt(totalMatch[1]);
          }
          
          // Extract current range
          const rangeMatch = text.match(/showing\s+([\d\s\-]+)\s+of/i) || 
                           text.match(/([\d\s\-]+)\s+of/i) ||
                           text.match(/items?\s+([\d\s\-]+)/i);
          if (rangeMatch) {
            currentPageRange = rangeMatch[1].trim();
          }
        }

        // Alternative: Look for any text containing item counts in the entire page
        if (totalItems === contentItems.length) {
          const allText = document.body.textContent;
          const patterns = [
            /of\s+(\d+)\s+items?/gi,
            /(\d+)\s+total\s+items?/gi,
            /total\s+items?:\s*(\d+)/gi,
            /(\d+)\s+results?/gi
          ];
          
          for (const pattern of patterns) {
            const match = allText.match(pattern);
            if (match) {
              const num = parseInt(match[1]);
              if (num > totalItems) {
                totalItems = num;
                break;
              }
            }
          }
        }

        // If we still don't have total pages but have next page, estimate conservatively
        if (totalPages === 1 && hasNextPage) {
          totalPages = page + 1; // At minimum, current page + 1
        }

        console.log('Extracted', contentItems.length, 'content items');
        console.log('Pagination info:', {
          hasNextPage, 
          hasPrevPage, 
          totalPages, 
          totalItems, 
          currentPageRange
        });
        
        return { 
          content: contentItems, 
          hasNextPage, 
          hasPrevPage,
          totalPages,
          totalItems,
          currentPageRange
        };
      }, { limit, contentType, page });

      console.log(`Found ${result.content.length} content items on page ${page}`);
      return {
        success: true,
        content: result.content,
        count: result.content.length,
        limit: limit,
        page: page,
        contentType: contentType,
        pagination: {
          currentPage: page,
          hasNextPage: result.hasNextPage,
          hasPrevPage: result.hasPrevPage,
          totalPages: result.totalPages,
          totalItems: result.totalItems,
          currentPageRange: result.currentPageRange
        }
      };
    } catch (error) {
      console.error('Error querying content:', error);
      return {
        success: false,
        error: error.message,
        suggestion: 'Ensure BASE_URL is set and you are logged in with appropriate permissions'
      };
    }
  }

  /**
   * Perform a single keepalive refresh
   * Internal method used by both automatic and manual keepalive
   */
  async performKeepaliveRefresh() {
    // Check circuit breaker
    if (this.keepaliveCircuitOpen) {
      console.warn(`Keepalive: Circuit breaker OPEN (${this.keepaliveConsecutiveFailures} consecutive failures). Skipping refresh.`);
      return false;
    }

    try {
      if (!this.isReady()) {
        console.log('Keepalive: Browser not ready, skipping');
        return false;
      }

      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        console.log('Keepalive: BASE_URL not set, skipping');
        return false;
      }

      console.log(`Keepalive: Refreshing session by navigating to ${baseUrl}`);
      const currentUrl = this.page.url();

      // Attempt navigation with retry logic
      let retries = 3;
      let lastError = null;
      let success = false;

      while (retries > 0 && !success) {
        try {
          await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.FORM_LOAD });
          success = true;
        } catch (error) {
          lastError = error;
          retries--;
          if (retries > 0) {
            console.warn(`Keepalive: Navigation failed, retrying (${retries} attempts remaining)...`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
          }
        }
      }

      if (!success) {
        throw lastError;
      }

      // Get session cookie info
      const cookies = await this.context.cookies();
      const sessionCookie = cookies.find(c => c.name.includes('SESS') || c.name.includes('SSESS'));

      if (sessionCookie && sessionCookie.expires > 0) {
        const now = Date.now() / 1000;
        const hoursUntilExpiry = Math.round((sessionCookie.expires - now) / 3600);
        console.log(`Keepalive: Session refreshed successfully. Expires in ${hoursUntilExpiry} hours`);
      } else {
        console.log('Keepalive: Session refreshed (session cookie or no expiry)');
      }

      // Navigate back if we were somewhere else
      if (currentUrl !== baseUrl) {
        try {
          await this.page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.FORM_LOAD });
        } catch (error) {
          console.warn(`Keepalive: Could not navigate back to ${currentUrl}: ${error.message}`);
        }
      }

      // Success - reset failure counter and update last refresh time
      if (this.keepaliveConsecutiveFailures > 0) {
        console.log(`Keepalive: Recovery successful. Resetting failure counter from ${this.keepaliveConsecutiveFailures} to 0`);
        this.keepaliveConsecutiveFailures = 0;
      }
      this.keepaliveLastRefresh = Date.now();

      return true;

    } catch (error) {
      this.keepaliveConsecutiveFailures++;
      console.error(`Keepalive error (failure ${this.keepaliveConsecutiveFailures}/${this.keepaliveMaxFailures}): ${error.message}`);

      // Open circuit breaker if max failures reached
      if (this.keepaliveConsecutiveFailures >= this.keepaliveMaxFailures) {
        this.keepaliveCircuitOpen = true;
        console.error(`Keepalive: Circuit breaker OPENED after ${this.keepaliveConsecutiveFailures} consecutive failures. Keepalive is now disabled.`);
        console.error('Keepalive: To recover, restart keepalive manually or reload the session.');
      }

      return false;
    }
  }

  /**
   * Start internal keepalive mechanism
   * Automatically refreshes session at configured intervals with retry logic and circuit breaker
   */
  startKeepalive() {
    if (!this.keepaliveEnabled) {
      console.log('Keepalive disabled via KEEPALIVE_ENABLED=false');
      return;
    }

    // Stop existing keepalive first to prevent duplicates
    this.stopKeepalive();

    // Reset circuit breaker state
    this.keepaliveConsecutiveFailures = 0;
    this.keepaliveCircuitOpen = false;

    const intervalMs = this.keepaliveIntervalMinutes * 60 * 1000;
    console.log(`Starting internal keepalive: will refresh session every ${this.keepaliveIntervalMinutes} minutes`);
    console.log(`Keepalive circuit breaker: max failures = ${this.keepaliveMaxFailures}`);

    // Perform immediate first refresh
    console.log('Keepalive: Performing immediate first refresh...');
    this.performKeepaliveRefresh().catch(error => {
      console.error('Keepalive: Immediate refresh failed:', error.message);
    });

    // Set up periodic refresh
    this.keepaliveInterval = setInterval(async () => {
      await this.performKeepaliveRefresh();
    }, intervalMs);

    console.log('Internal keepalive started');
  }

  /**
   * Stop internal keepalive mechanism
   */
  stopKeepalive() {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
      console.log('Internal keepalive stopped');
    }
  }

  /**
   * Get keepalive status including circuit breaker state
   */
  getKeepaliveStatus() {
    return {
      enabled: this.keepaliveEnabled,
      running: this.keepaliveInterval !== null,
      intervalMinutes: this.keepaliveIntervalMinutes,
      circuitBreaker: {
        open: this.keepaliveCircuitOpen,
        consecutiveFailures: this.keepaliveConsecutiveFailures,
        maxFailures: this.keepaliveMaxFailures
      }
    };
  }

  async close() {
    console.log('Closing PlaywrightManager resources...');

    // Stop keepalive before closing
    this.stopKeepalive();

    // Reset keepalive timestamp to allow immediate refresh after reopen
    this.keepaliveLastRefresh = null;

    try {
      if (this.page) {
        await withTimeout(this.page.close(), TIMEOUTS.SHUTDOWN, 'Page close');
        console.log('Page closed');
      }
    } catch (error) {
      console.error('Error closing page:', error.message);
    } finally {
      this.page = null;
    }

    try {
      if (this.context) {
        await withTimeout(this.context.close(), TIMEOUTS.SHUTDOWN, 'Context close');
        console.log('Context closed');
      }
    } catch (error) {
      console.error('Error closing context:', error.message);
    } finally {
      this.context = null;
    }

    try {
      if (this.browser) {
        await withTimeout(this.browser.close(), TIMEOUTS.SHUTDOWN, 'Browser close');
        console.log('Browser closed');
      }
    } catch (error) {
      console.error('Error closing browser:', error.message);
    } finally {
      this.browser = null;
    }

    console.log('PlaywrightManager cleanup completed');
  }

  /**
   * Get detailed content information by node ID
   * Tries edit interface first, falls back to view interface
   */
  async getContentDetail(nodeId) {
    try {
      this.debugLog('getContentDetail method STARTED with nodeId:', nodeId);
      this.debugFileLog('/tmp/content_detail.log', `getContentDetail called with nodeId: ${nodeId}\n`);

      if (!this.page) {
        this.debugFileLog('/tmp/content_detail.log', 'No active page available\n');
        throw new Error('No active page for content detail extraction');
      }

      // Get the base URL from environment
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        this.debugFileLog('/tmp/content_detail.log', 'BASE_URL not set\n');
        throw new Error('BASE_URL environment variable is required for content detail extraction');
      }

      this.debugFileLog('/tmp/content_detail.log', `BASE_URL: ${baseUrl}\n`);
      this.debugFileLog('/tmp/content_detail.log', `Current page URL before navigation: ${await this.page.url()}\n`);

      // Always navigate to base URL first to ensure we're on the correct domain
      this.debugFileLog('/tmp/content_detail.log', `Navigating to base URL: ${baseUrl}\n`);
      await this.page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      this.debugFileLog('/tmp/content_detail.log', `After base URL navigation, current URL: ${await this.page.url()}\n`);

      // Try edit interface first
      const editUrl = this.buildUrl(baseUrl, `node/${nodeId}/edit`);
      this.debugFileLog('/tmp/content_detail.log', `Attempting to access content via edit URL: ${editUrl}\n`);

      try {
        this.debugFileLog('/tmp/content_detail.log', 'Navigating to edit URL...\n');
        await this.page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
        this.debugFileLog('/tmp/content_detail.log', `After edit URL navigation, current URL: ${await this.page.url()}\n`);

        // Check if we successfully reached the edit page
        const currentUrl = this.page.url();
        const isEditPage = currentUrl.includes(`/node/${nodeId}/edit`) || currentUrl.includes('edit');

        if (isEditPage) {
          this.debugFileLog('/tmp/content_detail.log', 'Successfully accessed edit page, extracting content details\n');

          // Extract content using DOM scraping
          const contentData = await this.extractContentFromPage(nodeId, 'edit');
          this.debugFileLog('/tmp/content_detail.log', `Extraction complete, returning success\n`);
          return {
            success: true,
            content: contentData
          };
        } else {
          this.debugFileLog('/tmp/content_detail.log', `Edit page not accessible, current URL: ${currentUrl}\n`);
          throw new Error('Edit page not accessible');
        }
      } catch (editError) {
        this.debugFileLog('/tmp/content_detail.log', `Edit interface not accessible: ${editError.message}\n`);

        // Fallback to view interface
        const viewUrl = this.buildUrl(baseUrl, `node/${nodeId}`);
        this.debugFileLog('/tmp/content_detail.log', `Attempting to access content via view URL: ${viewUrl}\n`);

        this.debugFileLog('/tmp/content_detail.log', 'Navigating to view URL...\n');
        await this.page.goto(viewUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
        this.debugFileLog('/tmp/content_detail.log', `After view URL navigation, current URL: ${await this.page.url()}\n`);

        // Check if we reached the view page
        const currentUrl = this.page.url();
        const isViewPage = currentUrl.includes(`/node/${nodeId}`) && !currentUrl.includes('/edit');

        if (isViewPage) {
          this.debugFileLog('/tmp/content_detail.log', 'Successfully accessed view page, extracting content details\n');

          // Extract content using DOM scraping
          const contentData = await this.extractContentFromPage(nodeId, 'view');
          this.debugFileLog('/tmp/content_detail.log', `Extraction complete, returning success\n`);
          return {
            success: true,
            content: contentData
          };
        } else {
          this.debugFileLog('/tmp/content_detail.log', `View page not accessible either, current URL: ${currentUrl}\n`);
          throw new Error('Could not access content via edit or view interfaces');
        }
      }
    } catch (error) {
      this.debugFileLog('/tmp/content_detail.log', `Error getting content detail: ${error.message}\n`);
      return {
        success: false,
        error: error.message,
        nodeId: nodeId
      };
    }
  }

  /**
   * Extract content data from the current page using DOM scraping
   */
  async extractContentFromPage(nodeId, interfaceType) {
    console.log(`Extracting content from ${interfaceType} interface`);

    try {
      // Use robust fallback extraction method
      const contentData = await this.extractContentViaFallback(nodeId, interfaceType);
      return contentData;

    } catch (error) {
      console.error('Error extracting content from page:', error);
      // Return basic information even if extraction fails
      return {
        nodeId: nodeId,
        title: await this.page.title(),
        url: this.page.url(),
        interface: interfaceType,
        data: {},
        extractedAt: new Date().toISOString(),
        extractionError: error.message
      };
    }
  }

  /**
   * Extract content using fallback methods (DOM scraping)
   */
  async extractContentViaFallback(nodeId, interfaceType) {
    console.log('Attempting fallback content extraction');

    const contentData = await this.page.evaluate(({ nodeId, interfaceType }) => {
      const data = {};

      // Extract title
      const titleElement = document.querySelector('h1') || document.querySelector('.page-title') || document.querySelector('title');
      data.title = titleElement ? titleElement.textContent.trim() : document.title;

      // Extract body content
      const bodySelectors = ['.field--name-body', '.node__content', 'article .content', '.content', '#content'];
      for (const selector of bodySelectors) {
        const element = document.querySelector(selector);
        if (element) {
          data.body = element.textContent.trim();
          break;
        }
      }

      // Extract common fields based on interface
      if (interfaceType === 'edit') {
        // Extract from form fields
        const formFields = document.querySelectorAll('input[name], textarea[name], select[name]');
        formFields.forEach(field => {
          const name = field.name;
          const value = field.value || field.textContent;
          if (name && value) {
            data[name] = value.trim();
          }
        });
      } else {
        // Extract from view page structure
        const fieldSelectors = [
          '.field--name-field-summary',
          '.field--name-field-tags',
          '.field--name-field-category',
          '.field--name-created',
          '.field--name-changed'
        ];

        fieldSelectors.forEach(selector => {
          const element = document.querySelector(selector);
          if (element) {
            const label = element.querySelector('.field__label');
            const value = element.querySelector('.field__item') || element;
            const fieldName = label ? label.textContent.trim().toLowerCase().replace(/\s+/g, '_') : selector.split('--name-')[1];
            data[fieldName] = value.textContent.trim();
          }
        });
      }

      return data;
    }, { nodeId, interfaceType });

    return {
      nodeId: nodeId,
      title: await this.page.title(),
      url: this.page.url(),
      interface: interfaceType,
      data: contentData,
      extractedAt: new Date().toISOString(),
      extractionMethod: 'fallback'
    };
  }

  /**
   * List the blocks placed in a node's Layout Builder layout.
   *
   * Layout Builder addresses each block by section delta, region, and UUID, so
   * those three values are what every other layout call needs. The admin label
   * and block plugin ID come free from the layout markup; the list of
   * configurable field names costs one page load per block, so it is opt-in.
   *
   * @param {string|number} nodeId - Node whose layout to inspect
   * @param {Object} options - { withFields: also list each block's form fields }
   * @returns {Object} Result with the block list
   */
  async queryLayoutBlocks(nodeId, options = {}) {
    const { withFields = false } = options;

    try {
      if (!this.page) {
        throw new Error('No active page for layout query');
      }

      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        throw new Error('BASE_URL environment variable is required for layout queries');
      }

      const layoutUrl = this.buildUrl(baseUrl, `node/${nodeId}/layout`);
      console.log('Navigating to layout page:', layoutUrl);
      await this.page.goto(layoutUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
      await this.page.waitForSelector('[data-layout-block-uuid], .layout-builder', { timeout: TIMEOUTS.FORM_LOAD });

      const blocks = await this.page.evaluate(() => {
        const found = [];

        // Each block sits inside a section wrapper. The section's "Add block"
        // link is the reliable carrier of the delta and region, because the
        // block elements themselves only expose the UUID.
        const sections = document.querySelectorAll('.layout-builder__section');

        const readSectionAddress = section => {
          const addLink = section.querySelector('a[href*="/layout_builder/choose/block/"]');
          if (!addLink) return null;
          const match = (addLink.getAttribute('href') || '')
            .match(/\/layout_builder\/choose\/block\/[^/]+\/[^/]+\/(\d+)\/([^/?#]+)/);
          return match ? { delta: parseInt(match[1], 10), region: match[2] } : null;
        };

        sections.forEach(section => {
          const address = readSectionAddress(section);
          const blockElements = section.querySelectorAll('[data-layout-block-uuid]');

          blockElements.forEach(element => {
            // Layout Builder renders the admin label as '"My label" block'
            const rawLabel = element.getAttribute('data-layout-content-preview-placeholder-label') || '';
            const labelMatch = rawLabel.match(/^"(.*)"\s+block$/);

            found.push({
              uuid: element.getAttribute('data-layout-block-uuid'),
              delta: address ? address.delta : null,
              region: address ? address.region : null,
              pluginId: element.getAttribute('data-block-plugin-id') || null,
              label: labelMatch ? labelMatch[1] : (rawLabel || null),
              preview: element.textContent.trim().replace(/\s+/g, ' ').slice(0, 120)
            });
          });
        });

        return found;
      });

      const usable = blocks.filter(block => block.uuid && block.delta !== null && block.region);
      if (usable.length !== blocks.length) {
        console.warn(`${blocks.length - usable.length} layout block(s) had no resolvable section address and were dropped`);
      }

      // Labels and plugin IDs come straight off the layout markup. Field names
      // require opening each block's configure form, so they stay opt-in.
      if (withFields) {
        for (const block of usable) {
          const detail = await this.getLayoutBlockDetail(nodeId, block.delta, block.region, block.uuid);
          block.fields = detail.success ? Object.keys(detail.block.data) : [];
        }
      }

      return {
        success: true,
        nodeId: nodeId,
        blocks: usable,
        count: usable.length
      };
    } catch (error) {
      console.error('Error querying layout blocks:', error);
      return {
        success: false,
        error: error.message,
        suggestion: 'Ensure the node uses Layout Builder and you have permission to edit its layout'
      };
    }
  }

  /**
   * Build the Layout Builder URL that renders a single block's configure form.
   */
  buildLayoutBlockUrl(baseUrl, nodeId, delta, region, uuid) {
    return this.buildUrl(
      baseUrl,
      `layout_builder/update/block/overrides/node.${nodeId}/${delta}/${region}/${uuid}`
    );
  }

  /**
   * Read the configure form of a single Layout Builder block.
   *
   * @returns {Object} Result with the block's label and all form field values
   */
  async getLayoutBlockDetail(nodeId, delta, region, uuid) {
    try {
      if (!this.page) {
        throw new Error('No active page for layout block query');
      }

      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        throw new Error('BASE_URL environment variable is required for layout queries');
      }

      const blockUrl = this.buildLayoutBlockUrl(baseUrl, nodeId, delta, region, uuid);
      await this.page.goto(blockUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
      // 'attached' rather than the default 'visible': a page can render a hidden
      // form (e.g. site search) ahead of the one being edited.
      await this.page.waitForSelector('form', { state: 'attached', timeout: TIMEOUTS.FORM_LOAD });

      const data = await this.page.evaluate(() => {
        const values = {};
        const fields = document.querySelectorAll('input[name], textarea[name], select[name]');

        fields.forEach(field => {
          const name = field.getAttribute('name');
          if (!name) return;

          // Radios and checkboxes report their checked state, not their value
          if (field.type === 'checkbox' || field.type === 'radio') {
            if (field.checked) values[name] = field.value;
            else if (!(name in values)) values[name] = null;
            return;
          }

          values[name] = field.value;
        });

        return values;
      });

      return {
        success: true,
        block: {
          nodeId: nodeId,
          delta: delta,
          region: region,
          uuid: uuid,
          label: data['settings[label]'] !== undefined ? data['settings[label]'] : null,
          url: this.page.url(),
          data: data
        }
      };
    } catch (error) {
      console.error('Error reading layout block:', error);
      return { success: false, error: error.message, uuid: uuid };
    }
  }

  /**
   * Update one Layout Builder block's configuration.
   *
   * Layout Builder stages edits in a per-user tempstore: submitting this form
   * changes nothing on the live page until saveLayout() is called. Batch several
   * updates and save once, or pass save: true to persist immediately.
   *
   * @param {string|number} nodeId - Node whose layout holds the block
   * @param {number} delta - Section delta
   * @param {string} region - Region machine name
   * @param {string} uuid - Block UUID
   * @param {Object} updates - Form field name/value pairs
   * @param {Object} options - { save: also persist the layout afterwards }
   */
  async updateLayoutBlock(nodeId, delta, region, uuid, updates, options = {}) {
    const { save = false } = options;

    try {
      if (!this.page) {
        throw new Error('No active page for layout block update');
      }

      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        throw new Error('BASE_URL environment variable is required for layout updates');
      }

      const blockUrl = this.buildLayoutBlockUrl(baseUrl, nodeId, delta, region, uuid);
      console.log('Navigating to layout block form:', blockUrl);
      await this.page.goto(blockUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
      await this.page.waitForSelector('form', { state: 'attached', timeout: TIMEOUTS.FORM_LOAD });

      // Block forms are plugin-defined, so there is no schema to consult -
      // field types are inferred from the rendered widget.
      const updateResults = await this.updateFormFields(updates, null);

      if (updateResults.updated.length === 0) {
        const reasons = updateResults.skipped.map(field => `${field.field}: ${field.reason}`).join('; ');
        return {
          success: false,
          uuid: uuid,
          error: `No fields could be updated on block ${uuid}, form not submitted${reasons ? ` (${reasons})` : ''}`,
          updatedFields: [],
          skippedFields: updateResults.skipped
        };
      }

      // The block form's submit button is labelled "Update" (or "Add block")
      const submitButton = this.page.locator(
        'input[type="submit"][value="Update"], button[type="submit"]:has-text("Update"), ' +
        'input[type="submit"][value*="Add block"], button[type="submit"]:has-text("Add block")'
      ).first();

      if (await submitButton.count() === 0) {
        throw new Error('Could not find the Update button on the block configure form');
      }

      await submitButton.click();

      try {
        await this.page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE });
      } catch {
        this.debugLog('Network idle timeout after block update, continuing');
      }

      const result = {
        success: true,
        nodeId: nodeId,
        delta: delta,
        region: region,
        uuid: uuid,
        message: `Block ${uuid} staged in the layout`,
        saved: false,
        updatedFields: updateResults.updated,
        skippedFields: updateResults.skipped
      };

      if (save) {
        const saveResult = await this.saveLayout(nodeId);
        result.saved = saveResult.success;
        if (!saveResult.success) {
          result.success = false;
          result.error = saveResult.error;
        }
      }

      return result;
    } catch (error) {
      console.error('Error updating layout block:', error);
      return { success: false, error: error.message, uuid: uuid };
    }
  }

  /**
   * Persist staged Layout Builder changes for a node.
   */
  async saveLayout(nodeId) {
    return await this.submitLayoutAction(nodeId, {
      selector: 'input[type="submit"][value*="Save layout"], button:has-text("Save layout")',
      action: 'save',
      missingMessage: 'Could not find the "Save layout" button - there may be no staged changes'
    });
  }

  /**
   * Drop staged Layout Builder changes for a node without saving them.
   */
  async discardLayoutChanges(nodeId) {
    const result = await this.submitLayoutAction(nodeId, {
      selector: 'input[type="submit"][value*="Discard changes"], button:has-text("Discard changes"), a:has-text("Discard changes")',
      action: 'discard',
      missingMessage: 'Could not find the "Discard changes" button - there may be no staged changes'
    });

    if (!result.success) return result;

    // Discarding asks for confirmation on its own page
    const confirmButton = this.page.locator(
      'input[type="submit"][value*="Confirm"], button:has-text("Confirm"), input[type="submit"][value*="Discard"]'
    ).first();

    if (await confirmButton.count() > 0) {
      await confirmButton.click();
      try {
        await this.page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE });
      } catch {
        this.debugLog('Network idle timeout after discard confirmation, continuing');
      }
    }

    return result;
  }

  /**
   * Shared driver for the Save/Discard buttons on the layout edit page.
   */
  async submitLayoutAction(nodeId, { selector, action, missingMessage }) {
    try {
      if (!this.page) {
        throw new Error(`No active page for layout ${action}`);
      }

      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        throw new Error(`BASE_URL environment variable is required for layout ${action}`);
      }

      const layoutUrl = this.buildUrl(baseUrl, `node/${nodeId}/layout`);
      await this.page.goto(layoutUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });

      // Wait for the action button itself. Waiting on a generic 'form' picks up
      // whichever form renders first (often a hidden search form) and stalls.
      try {
        await this.page.waitForSelector(selector, { state: 'attached', timeout: TIMEOUTS.FORM_LOAD });
      } catch {
        throw new Error(missingMessage);
      }

      const button = this.page.locator(selector).first();
      if (await button.count() === 0) {
        throw new Error(missingMessage);
      }

      await button.click();

      try {
        await this.page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE });
      } catch {
        this.debugLog(`Network idle timeout after layout ${action}, continuing`);
      }

      return {
        success: true,
        nodeId: nodeId,
        action: action,
        message: `Layout ${action === 'save' ? 'saved' : 'changes discarded'} for node ${nodeId}`,
        redirectUrl: this.page.url()
      };
    } catch (error) {
      console.error(`Error during layout ${action}:`, error);
      return { success: false, error: error.message, nodeId: nodeId, action: action };
    }
  }

  isReady() {
    return !!(this.browser && this.context && this.page);
  }

  /**
   * Extract select/option metadata from a content type's add form.
   * Returns a map of field names to their available options.
   */
  async getFormSelectOptions(contentType) {
    if (!this.page) {
      throw new Error('No active page');
    }

    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) {
      throw new Error('BASE_URL environment variable is required');
    }

    const createUrl = this.buildUrl(baseUrl, `node/add/${contentType}`);
    await this.page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });
    await this.page.waitForSelector('form', { timeout: TIMEOUTS.FORM_LOAD });

    const options = await this.page.evaluate(() => {
      const result = {};
      document.querySelectorAll('select[name]').forEach(select => {
        const name = select.getAttribute('name');
        result[name] = Array.from(select.options)
          .filter(opt => opt.value && opt.value !== '_none')
          .map(opt => ({ value: opt.value, label: opt.textContent.trim() }));
      });
      return result;
    });

    return { success: true, contentType, options };
  }

  /**
   * Update content by node ID
   * Navigates to edit page and updates fields based on provided data
   */
  async updateContent(nodeId, updates) {
    try {
      this.debugLog('updateContent method STARTED with nodeId:', nodeId);
      this.debugFileLog('/tmp/content_update.log', `updateContent called with nodeId: ${nodeId}\n`);
      this.debugFileLog('/tmp/content_update.log', `Updates: ${JSON.stringify(updates)}\n`);

      if (!this.page) {
        this.debugFileLog('/tmp/content_update.log', 'No active page available\n');
        throw new Error('No active page for content update');
      }

      // Get the base URL from environment
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        this.debugFileLog('/tmp/content_update.log', 'BASE_URL not set\n');
        throw new Error('BASE_URL environment variable is required for content update');
      }

      // Navigate to edit page
      const editUrl = this.buildUrl(baseUrl, `node/${nodeId}/edit`);
      this.debugFileLog('/tmp/content_update.log', `Navigating to edit URL: ${editUrl}\n`);

      await this.page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });

      // Wait for the form to be fully loaded
      await this.page.waitForSelector('form', { timeout: TIMEOUTS.FORM_LOAD });
      this.debugFileLog('/tmp/content_update.log', 'Edit form loaded\n');

      // Check if we successfully reached the edit page
      const currentUrl = this.page.url();
      const isEditPage = currentUrl.includes(`/node/${nodeId}/edit`) || currentUrl.includes('edit');

      if (!isEditPage) {
        throw new Error(`Could not access edit page for node ${nodeId}. Current URL: ${currentUrl}`);
      }

      // Load schema for content type if available
      const contentType = await this.detectContentType();
      this.debugFileLog('/tmp/content_update.log', `Detected content type: ${contentType}\n`);

      const schema = await this.loadSchemaForContentType(contentType);
      this.debugFileLog('/tmp/content_update.log', `Schema loaded: ${schema ? 'yes' : 'no'}\n`);

      // Update fields based on schema or field names
      const updateResults = await this.updateFormFields(updates, schema);
      this.debugFileLog('/tmp/content_update.log', `Fields updated: ${JSON.stringify(updateResults)}\n`);

      // Nothing resolved to a real form field - saving here would re-save the
      // node unchanged and hide the fact that the update never applied.
      if (updateResults.updated.length === 0) {
        const reasons = updateResults.skipped.map(field => `${field.field}: ${field.reason}`).join('; ');
        this.debugFileLog('/tmp/content_update.log', `No fields updated, skipping save. ${reasons}\n`);

        return {
          success: false,
          nodeId: nodeId,
          error: `No fields could be updated on node ${nodeId}, form not submitted`,
          updatedFields: [],
          skippedFields: updateResults.skipped
        };
      }

      // Submit the form
      this.debugFileLog('/tmp/content_update.log', 'Submitting form...\n');

      // Look for the Save button (Drupal typically uses "Save" as button text)
      const saveButton = this.page.locator('input[type="submit"][value*="Save"], button[type="submit"]:has-text("Save")').first();

      if (await saveButton.count() > 0) {
        await saveButton.click();

        // Wait for navigation or success message
        // Drupal typically redirects to the view page after save
        try {
          await this.page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE });
        } catch (error) {
          // If networkidle times out, that's okay - check for success message
          this.debugLog('Network idle timeout, checking for success indicators');
        }

        this.debugFileLog('/tmp/content_update.log', 'Form submitted successfully\n');

        return {
          success: true,
          nodeId: nodeId,
          message: `Content ${nodeId} updated successfully`,
          updatedFields: updateResults.updated,
          skippedFields: updateResults.skipped,
          redirectUrl: this.page.url()
        };
      } else {
        throw new Error('Could not find Save button on edit form');
      }

    } catch (error) {
      this.debugFileLog('/tmp/content_update.log', `Error updating content: ${error.message}\n`);
      return {
        success: false,
        error: error.message,
        nodeId: nodeId
      };
    }
  }

  /**
   * Create new content by content type
   * Navigates to content creation page, fills form fields, and submits
   *
   * @param {string} contentType - Machine name of content type (e.g., 'article', 'page')
   * @param {Object} fields - Field values as key-value pairs
   * @returns {Object} Result with success status, node ID if created, and field information
   */
  async createContent(contentType, fields) {
    try {
      this.debugLog('createContent method STARTED with contentType:', contentType);
      this.debugFileLog('/tmp/content_create.log', `createContent called with contentType: ${contentType}\n`);
      this.debugFileLog('/tmp/content_create.log', `Fields: ${JSON.stringify(fields)}\n`);

      if (!this.page) {
        this.debugFileLog('/tmp/content_create.log', 'No active page available\n');
        throw new Error('No active page for content creation');
      }

      // Get the base URL from environment
      const baseUrl = process.env.BASE_URL;
      if (!baseUrl) {
        this.debugFileLog('/tmp/content_create.log', 'BASE_URL not set\n');
        throw new Error('BASE_URL environment variable is required for content creation');
      }

      // Validate request using shared validation function
      const validationResult = validateContentRequest(contentType, fields);
      if (!validationResult.valid) {
        throw new Error(validationResult.error);
      }

      // First, verify the content type exists
      this.debugFileLog('/tmp/content_create.log', 'Verifying content type exists...\n');
      const contentTypesResult = await this.queryContentTypes();

      if (!contentTypesResult.success) {
        throw new Error(`Failed to query available content types: ${contentTypesResult.error}`);
      }

      const availableType = contentTypesResult.contentTypes.find(
        ct => ct.machineName === contentType
      );

      if (!availableType) {
        const availableTypes = contentTypesResult.contentTypes.map(ct => ct.machineName).join(', ');
        throw new Error(
          `Content type "${contentType}" not found. Available types: ${availableTypes}`
        );
      }

      this.debugFileLog('/tmp/content_create.log', `Content type "${contentType}" verified\n`);

      // Navigate to content creation page
      const createUrl = this.buildUrl(baseUrl, `node/add/${contentType}`);
      this.debugFileLog('/tmp/content_create.log', `Navigating to create URL: ${createUrl}\n`);

      await this.page.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUTS.NAVIGATION });

      // Wait for the form to be fully loaded
      await this.page.waitForSelector('form', { timeout: TIMEOUTS.FORM_LOAD });
      this.debugFileLog('/tmp/content_create.log', 'Create form loaded\n');

      // Check if we successfully reached the create page
      const currentUrl = this.page.url();
      const isCreatePage = currentUrl.includes(`/node/add/${contentType}`) || currentUrl.includes('/node/add');

      if (!isCreatePage) {
        throw new Error(`Could not access create page for content type "${contentType}". Current URL: ${currentUrl}`);
      }

      // Load schema for content type if available
      const schema = await this.loadSchemaForContentType(contentType);
      this.debugFileLog('/tmp/content_create.log', `Schema loaded: ${schema ? 'yes' : 'no'}\n`);

      // Check for required fields in schema
      if (schema && schema.fields) {
        const requiredFields = Object.entries(schema.fields)
          .filter(([_, fieldDef]) => fieldDef.required)
          .map(([fieldName, _]) => fieldName);

        const missingRequired = requiredFields.filter(reqField => !fields.hasOwnProperty(reqField));

        if (missingRequired.length > 0) {
          throw new Error(
            `Missing required fields: ${missingRequired.join(', ')}. Required fields for ${contentType}: ${requiredFields.join(', ')}`
          );
        }
      }

      // Fill in fields - only touch fields that are explicitly provided
      const updateResults = await this.updateFormFields(fields, schema);
      this.debugFileLog('/tmp/content_create.log', `Fields filled: ${JSON.stringify(updateResults)}\n`);

      // Submit the form
      this.debugFileLog('/tmp/content_create.log', 'Submitting form...\n');

      // Look for the Save button
      const saveButton = this.page.locator('input[type="submit"][value*="Save"], button[type="submit"]:has-text("Save")').first();

      if (await saveButton.count() > 0) {
        await saveButton.click();

        // Wait for navigation - Drupal redirects to the view page after creation
        try {
          await this.page.waitForLoadState('networkidle', { timeout: TIMEOUTS.NETWORK_IDLE });
        } catch (error) {
          this.debugLog('Network idle timeout, checking for success indicators');
        }

        this.debugFileLog('/tmp/content_create.log', 'Form submitted successfully\n');

        // Extract the new node ID from the redirect URL
        const redirectUrl = this.page.url();
        let nodeIdMatch = redirectUrl.match(/\/node\/(\d+)/);
        let nodeId = nodeIdMatch ? parseInt(nodeIdMatch[1]) : null;

        // If no node ID found in URL (e.g., using path aliases), try to extract from edit link
        if (!nodeId) {
          this.debugLog('No node ID in redirect URL, attempting to find edit link');
          try {
            // Wait a moment for the page to fully load
            await this.page.waitForLoadState('domcontentloaded', { timeout: TIMEOUTS.DOM_CONTENT_LOADED });

            // Try multiple selectors for edit links
            const editSelectors = [
              'a[href*="/node/"][href*="/edit"]',
              'a:has-text("Edit")',
              'ul.tabs a[href*="/edit"]',
              'nav a[href*="/edit"]',
              '.tabs__link[href*="/edit"]'
            ];

            for (const selector of editSelectors) {
              try {
                const editLink = this.page.locator(selector).first();
                const count = await editLink.count();

                if (count > 0) {
                  const editHref = await editLink.getAttribute('href');
                  this.debugLog(`Found edit link with selector "${selector}": ${editHref}`);

                  if (editHref) {
                    // Extract node ID from edit link (e.g., /node/123/edit)
                    const editNodeIdMatch = editHref.match(/\/node\/(\d+)/);
                    if (editNodeIdMatch) {
                      nodeId = parseInt(editNodeIdMatch[1]);
                      this.debugLog(`Extracted node ID ${nodeId} from edit link`);
                      break;
                    }
                  }
                }
              } catch (e) {
                // Try next selector
                continue;
              }
            }
          } catch (error) {
            this.debugLog(`Error finding edit link: ${error.message}`);
          }
        }

        return {
          success: true,
          nodeId: nodeId,
          contentType: contentType,
          message: nodeId
            ? `Content created successfully with node ID ${nodeId}`
            : 'Content created successfully',
          filledFields: updateResults.updated,
          skippedFields: updateResults.skipped,
          redirectUrl: redirectUrl
        };
      } else {
        throw new Error('Could not find Save button on create form');
      }

    } catch (error) {
      this.debugFileLog('/tmp/content_create.log', `Error creating content: ${error.message}\n`);
      return {
        success: false,
        error: error.message,
        contentType: contentType
      };
    }
  }

  /**
   * Detect content type from edit page
   */
  async detectContentType() {
    try {
      const contentType = await this.page.evaluate(() => {
        // Drupal renders a hidden form_id on every node form, shaped as
        // node_<machine_name>_form or node_<machine_name>_edit_form. This is
        // the most reliable source because it keeps underscores intact.
        const formId = document.querySelector('input[name="form_id"]')?.value || '';
        const formIdMatch = formId.match(/^node_(.+)_form$/);
        if (formIdMatch) {
          return formIdMatch[1].replace(/_edit$/, '');
        }

        // data-drupal-selector carries the same name with underscores rendered
        // as dashes (node-ps-events-edit-form), so convert them back.
        const form = document.querySelector('form[data-drupal-selector*="node-"]');
        if (form) {
          const selector = form.getAttribute('data-drupal-selector') || '';
          const selectorMatch = selector.match(/^node-(.+)-form$/);
          if (selectorMatch) {
            return selectorMatch[1].replace(/-edit$/, '').replace(/-/g, '_');
          }
        }

        // Fall back to the node/add/<type> path on a creation form
        const formAction = document.querySelector('form')?.action || '';
        const urlMatch = formAction.match(/\/node\/add\/([a-z0-9_]+)/);
        if (urlMatch) return urlMatch[1];

        return null;
      });

      return contentType || 'unknown';
    } catch (error) {
      console.error('Error detecting content type:', error);
      return 'unknown';
    }
  }

  async loadSchemaForContentType(contentType) {
    try {
      if (typeof contentType !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(contentType)) {
        return null;
      }
      const targetDir = path.resolve(process.cwd(), 'schemas');
      const schemaPath = path.resolve(targetDir, `${contentType}.json`);
      if (!schemaPath.startsWith(targetDir)) {
        return null;
      }
      const schemaContent = await fs.readFile(schemaPath, 'utf8');
      return JSON.parse(schemaContent);
    } catch (error) {
      console.log(`No schema found for content type: ${contentType}`);
      return null;
    }
  }

  /**
   * Update form fields based on provided updates and optional schema
   */
  /**
   * Find a schema field whose selector targets the given raw form field name.
   *
   * Lets callers address fields by their Drupal form name (the names returned
   * by /content/detail) while still picking up the schema's declared type.
   *
   * @param {Object|null} schema - Loaded content type schema
   * @param {string} fieldName - Raw Drupal form field name
   * @returns {Object|null} Matching schema field definition, or null
   */
  findSchemaFieldBySelector(schema, fieldName) {
    if (!schema || !schema.fields) {
      return null;
    }

    // Match [name="field"] and select[name="field"] alike
    const nameSelector = `[name="${fieldName}"]`;

    for (const definition of Object.values(schema.fields)) {
      const selector = definition && definition.selector;
      if (typeof selector === 'string' && selector.includes(nameSelector)) {
        return definition;
      }
    }

    return null;
  }

  async updateFormFields(updates, schema) {
    const updated = [];
    const skipped = [];

    for (const [fieldName, fieldValue] of Object.entries(updates)) {
      try {
        let selector = null;
        let fieldType = 'text';
        let typeFromSchema = false;

        // If schema is available, use it to get the selector and type
        if (schema && schema.fields && schema.fields[fieldName]) {
          selector = schema.fields[fieldName].selector;
          fieldType = schema.fields[fieldName].type || 'text';
          typeFromSchema = true;
        } else {
          // Callers may pass the raw Drupal form name (field_x[0][value])
          // rather than the schema's friendly key. Match it back to the schema
          // entry by selector so the declared field type still applies -
          // widgets like hidden_select need it to be handled correctly.
          const schemaEntry = this.findSchemaFieldBySelector(schema, fieldName);

          if (schemaEntry) {
            selector = schemaEntry.selector;
            fieldType = schemaEntry.type || 'text';
            typeFromSchema = true;
          } else {
            // Try to guess the selector based on common Drupal patterns
            selector = `[name="${fieldName}[0][value]"]`;
          }
        }

        console.log(`Attempting to update field: ${fieldName} with selector: ${selector}`);

        // Check if field exists
        const fieldExists = await this.page.locator(selector).count() > 0;

        if (!fieldExists) {
          // Try alternative selectors
          const altSelectors = [
            `[name="${fieldName}"]`,
            `[name="${fieldName}[value]"]`,
            `[id*="${fieldName}"]`,
            `[name*="${fieldName}"]`
          ];

          let found = false;
          for (const altSelector of altSelectors) {
            if (await this.page.locator(altSelector).count() > 0) {
              selector = altSelector;
              found = true;
              break;
            }
          }

          if (!found) {
            skipped.push({ field: fieldName, reason: 'Field not found' });
            continue;
          }
        }

        // Inspect the resolved element so the widget drives handling
        const element = this.page.locator(selector).first();
        const elementType = await element.getAttribute('type').catch(() => null);
        let tagName = null;
        try {
          tagName = await element.evaluate(node => node.tagName.toLowerCase());
        } catch {
          // Element evaluation is unavailable - fall back to the declared type
          tagName = null;
        }

        // A checkbox always wins - a schema that calls it text would misfire
        if (elementType === 'checkbox') {
          fieldType = 'checkbox';
        } else if (!typeFromSchema) {
          // Without a schema, infer from the markup. Textareas matter most:
          // Drupal wraps rich-text ones in CKEditor, which hides the element
          // and makes a plain fill() fail.
          if (tagName === 'textarea') {
            fieldType = 'textarea';
          } else if (tagName === 'select') {
            fieldType = 'select';
          } else if (elementType === 'date') {
            fieldType = 'date';
          } else if (elementType === 'time') {
            fieldType = 'time';
          }
        }

        // Update field based on type
        switch (fieldType) {
          case 'text':
            await this.page.locator(selector).fill(String(fieldValue));
            break;

          case 'textarea':
            // Check if this textarea uses CKEditor
            const hasCKEditor = await element.getAttribute('data-ckeditor5-id').catch(() => null);

            if (hasCKEditor) {
              // CKEditor is active - use JavaScript to set the content
              console.log(`Field ${fieldName} uses CKEditor (ID: ${hasCKEditor}), setting content via JavaScript`);

              try {
                await this.page.evaluate(({ selector, value }) => {
                  const textarea = document.querySelector(selector);
                  if (textarea && textarea.ckeditorInstance) {
                    // CKEditor 5 API
                    textarea.ckeditorInstance.setData(value);
                  } else if (textarea) {
                    // Fallback: try to find CKEditor instance via Drupal
                    const editorId = textarea.getAttribute('data-ckeditor5-id');
                    if (window.Drupal && window.Drupal.CKEditor5Instances) {
                      const instances = window.Drupal.CKEditor5Instances;
                      for (let instance of instances.values()) {
                        if (instance.sourceElement === textarea) {
                          instance.setData(value);
                          return;
                        }
                      }
                    }
                    // Last resort: set textarea value directly (may not trigger CKEditor)
                    textarea.value = value;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                  }
                }, { selector, value: String(fieldValue) });

                this.debugLog(`Successfully set CKEditor content for ${fieldName}`);
              } catch (ckError) {
                this.debugLog(`CKEditor JavaScript approach failed, trying direct click and type: ${ckError.message}`);

                // Alternative: Click on the CKEditor contenteditable area and type
                try {
                  const editorSelector = `.ck-editor__editable[data-cke-editor-id="${hasCKEditor}"]`;
                  const editorExists = await this.page.locator(editorSelector).count() > 0;

                  if (editorExists) {
                    await this.page.locator(editorSelector).click();
                    await this.page.locator(editorSelector).fill(String(fieldValue));
                    this.debugLog(`Successfully filled CKEditor via contenteditable for ${fieldName}`);
                  } else {
                    throw new Error('Could not find CKEditor contenteditable element');
                  }
                } catch (altError) {
                  throw new Error(`CKEditor field handling failed: ${altError.message}`);
                }
              }
            } else {
              // Regular textarea without CKEditor
              await this.page.locator(selector).fill(String(fieldValue));
            }
            break;

          case 'checkbox':
            // Convert various truthy/falsy values
            const shouldCheck = fieldValue === true ||
                               fieldValue === '1' ||
                               fieldValue === 1 ||
                               String(fieldValue).toLowerCase() === 'true';

            if (shouldCheck) {
              await this.page.locator(selector).check();
            } else {
              await this.page.locator(selector).uncheck();
            }
            break;

          case 'checkboxes':
            // For checkbox groups, select by label text
            await this.page.getByLabel(String(fieldValue), { exact: true }).check();
            break;

          case 'select':
            await this.page.locator(selector).selectOption(String(fieldValue));
            break;

          case 'hidden_select':
            // For select elements hidden by overlay widgets (e.g., aria-autocomplete)
            // Matches by option value first, then falls back to option text
            await this.page.evaluate(({ sel, val }) => {
              const select = document.querySelector(sel);
              if (!select) throw new Error('Select element not found');
              const targets = Array.isArray(val) ? val : [val];
              let matched = 0;
              Array.from(select.options).forEach(opt => {
                const isMatch = targets.some(t =>
                  opt.value === t || opt.textContent.trim() === t
                );
                opt.selected = isMatch;
                if (isMatch) matched++;
              });
              if (matched === 0) {
                const available = Array.from(select.options).map(o => o.textContent.trim()).join(', ');
                throw new Error(`No matching option for "${targets.join(', ')}". Available: ${available}`);
              }
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }, { sel: selector, val: fieldValue });
            break;

          case 'date':
            await this.page.locator(selector).fill(String(fieldValue));
            break;

          case 'time':
            await this.page.locator(selector).fill(String(fieldValue));
            break;

          default:
            await this.page.locator(selector).fill(String(fieldValue));
        }

        updated.push({ field: fieldName, value: fieldValue });
        console.log(`Successfully updated field: ${fieldName}`);

      } catch (error) {
        console.error(`Error updating field ${fieldName}:`, error.message);
        skipped.push({ field: fieldName, reason: error.message });
      }
    }

    return { updated, skipped };
  }
}

module.exports = PlaywrightManager;
