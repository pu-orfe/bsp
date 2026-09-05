# Build Sites Programmatically (BSP)

An API for the Drupal UI when the actual API is MIA.

## Features

- **Containerized Browser Automation**: Headful Chromium runs in Docker via Xvfb + VNC
- **Interactive Login Flow**: Manual authentication with session capture for programmatic reuse
- **REST API**: Full control over browser lifecycle and UI automation
- **VNC Access**: Real-time browser interaction via noVNC web interface
- **Session Persistence**: Browser contexts saved to persistent storage
- **CRUD Operations**: Create, Read, Update, Delete content via UI automation
- **Layout Builder**: Read and bulk-edit placed blocks, staged then published in one commit
- **CSV Import/Export**: Mapping-driven import, filtered export, and reproducible scheduling

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 18+ (for local development and JS examples)
- Conda/Miniconda (for Python examples)

### 1. Launch Platform

```bash
# Start the containerized platform
docker-compose up -d

# Check health
curl http://localhost:3000/health
```

> **Port already in use?** The host ports are configurable - set `BSP_API_PORT`,
> `BSP_NOVNC_PORT` and `BSP_VNC_PORT` in `.env`. The examples below use the
> defaults (3000 / 8080). See [Host Ports](#host-ports).

### 2. Authenticate

```bash
# Start interactive browser session
curl -X POST http://localhost:3000/login/interactive

# Open VNC interface in your browser
open http://localhost:8080/vnc.html

# Navigate to your Drupal login page and authenticate

# Save the session
curl -X POST http://localhost:3000/login/save
```

### 3. Use the API

```bash
# Load saved session
curl -X POST http://localhost:3000/login/load

# List content
curl "http://localhost:3000/content?limit=10"

# Get content details
curl "http://localhost:3000/content/detail/123"

# Create new content
curl -X POST -H "Content-Type: application/json" \
  http://localhost:3000/content \
  -d '{"contentType": "article", "fields": {"title": "New Article", "body": "Content here"}}'

# Update content
curl -X PUT -H "Content-Type: application/json" \
  http://localhost:3000/content/123 \
  -d '{"title": "Updated Title"}'
```

---

## 📋 API Reference

### Complete Endpoint Table

| Endpoint | Method | Description | Auth Required |
|----------|--------|-------------|---------------|
| **Health & Status** ||||
| `/health` | GET | Service health check | No |
| `/playwright/ready` | GET | Browser readiness status | No |
| **Authentication** ||||
| `/login/interactive` | POST | Launch interactive browser session | No |
| `/login/navigate` | POST | Navigate to default login URL | Yes |
| `/login/check` | GET | Verify authentication status | Yes |
| `/login/save` | POST | Save current session to storage | Yes |
| `/login/load` | POST | Load saved session from storage | No |
| **Content Discovery** ||||
| `/content/types` | GET | Query available content types | Yes |
| `/content` | GET | List content with pagination | Yes |
| `/content/detail/:nodeId` | GET | Get detailed content by node ID | Yes |
| **Content Modification** ||||
| `/content` | POST | Create new content | Yes |
| `/content/:nodeId` | PUT | Update content by node ID | Yes |
| **Layout Builder** ||||
| `/layout/:nodeId/blocks` | GET | List blocks placed in a node's layout | Yes |
| `/layout/:nodeId/block/:delta/:region/:uuid` | GET | Read a block's configuration | Yes |
| `/layout/:nodeId/block/:delta/:region/:uuid` | PUT | Update a block's configuration (staged) | Yes |
| `/layout/:nodeId/save` | POST | Persist staged layout changes | Yes |
| `/layout/:nodeId/discard` | POST | Drop staged layout changes | Yes |
| **Debug** ||||
| `/debug/screenshot` | GET | Capture current page screenshot | Yes |
| `/debug/page` | GET | Get current page information | Yes |

---

## 🏗️ CRUD Operations

### Prerequisites

All CRUD operations require an authenticated admin session:
1. Configure `BASE_URL` in `.env` file (e.g., `BASE_URL=https://your-drupal-site.com`)
2. Start interactive session: `POST /login/interactive`
3. Authenticate via VNC interface
4. Verify: `GET /login/check` returns `{"authenticated": true, "adminAccess": true}`

---

### Create

Create new content by specifying a content type and field values. The API validates that the content type exists and that all required fields are provided before creating the content.

**Endpoint:** `POST /content`

**Request Body:**
```json
{
  "contentType": "article",
  "fields": {
    "title": "New Article Title",
    "body": "Article body content goes here",
    "status": true
  }
}
```

**Content Type Validation:**

Before creating content, the API queries available content types and validates that the requested type exists. Use `GET /content/types` to discover available types.

**Required Fields Validation:**

The API loads the schema for the specified content type and validates that all required fields are provided. If any required fields are missing, the request will fail with a descriptive error message.

**Content Type Schemas:**

Schemas define the fields, selectors, types, and requirements for each content type. They are stored in the `schemas/` directory as JSON files named by content type machine name (e.g., `schemas/article.json`, `schemas/event.json`).

**Schema Behavior:**
- **If schema exists**: The API validates required fields before submission and uses exact field selectors
- **If schema is missing**: The API uses best-effort field matching based on field names and IDs
- Schemas are optional but recommended for reliable field validation and accurate field targeting

**Schema Structure:**
```json
{
  "contentType": "article",
  "description": "Schema for Article content type",
  "fields": {
    "title": {
      "selector": "[name=\"title[0][value]\"]",
      "type": "text",
      "required": true,
      "label": "Title"
    },
    "body": {
      "selector": "[name=\"body[0][value]\"]",
      "type": "textarea",
      "required": false,
      "label": "Body"
    }
  }
}
```

**Creating Custom Schemas:**

1. Query your content type's creation form to identify field names
2. Create a JSON file in `schemas/` named `{contentType}.json`
3. Define each field with its selector, type, and whether it's required
4. The API will automatically load and use the schema for validation

**Supported Field Types:**
- `text` - Single-line text input
- `textarea` - Multi-line text area
- `date` - Date input (YYYY-MM-DD format)
- `time` - Time input (HH:MM format)
- `checkbox` - Boolean checkbox
- `select` - Dropdown selection

**Examples:**

**Create an Article:**
```bash
curl -X POST -H "Content-Type: application/json" \
  http://localhost:3000/content \
  -d '{
    "contentType": "article",
    "fields": {
      "title": "My New Article",
      "body": "This is the article content.",
      "status": true
    }
  }'
```

**Create a Page:**
```bash
curl -X POST -H "Content-Type: application/json" \
  http://localhost:3000/content \
  -d '{
    "contentType": "page",
    "fields": {
      "title": "About Us",
      "body": "Information about our organization."
    }
  }'
```

**Create an Event:**
```bash
curl -X POST -H "Content-Type: application/json" \
  http://localhost:3000/content \
  -d '{
    "contentType": "event",
    "fields": {
      "title": "Annual Conference 2025",
      "body": "Join us for our annual conference.",
      "event_date": "2025-12-31",
      "location": "Conference Center",
      "status": true
    }
  }'
```

**Success Response:**
```json
{
  "success": true,
  "nodeId": 456,
  "contentType": "article",
  "message": "Content created successfully with node ID 456",
  "redirectUrl": "https://your-site.com/node/456",
  "filledFields": [
    {"field": "title", "value": "My New Article", "type": "text"},
    {"field": "body", "value": "This is the article content.", "type": "textarea"},
    {"field": "status", "value": true, "type": "checkbox"}
  ],
  "skippedFields": []
}
```

**Error Response (Missing Required Fields):**
```json
{
  "success": false,
  "error": "Missing required fields: title",
  "contentType": "article"
}
```

**Error Response (Invalid Content Type):**
```json
{
  "success": false,
  "error": "Content type \"invalid_type\" not found. Available types: article, page, event, news",
  "contentType": "invalid_type"
}
```

**Default Values:**

Fields not specified in the request will retain their default values from the Drupal form (e.g., a checked "Published" checkbox will remain checked unless you explicitly set `"status": false`).

**Executable Example:**

See `examples/create-content.js` for a complete working example that demonstrates:
- Loading an authenticated session
- Querying available content types
- Creating content with validation
- Verifying the created content

```bash
# Run the example (requires authenticated session)
CONTENT_TYPE=article node examples/create-content.js

# Create an event
CONTENT_TYPE=event node examples/create-content.js
```

---

### Read

#### List Content

**Query content with pagination and filtering:**

```bash
# Get 10 most recent items
curl "http://localhost:3000/content?limit=10"

# Get 5 news items
curl "http://localhost:3000/content?limit=5&type=news"

# Get page 2 with 20 items per page
curl "http://localhost:3000/content?limit=20&page=2"
```

**Parameters:**
- `limit` (optional): Items per page (1-100, default: 10)
- `type` (optional): Filter by content type (e.g., "news", "page", "event")
- `page` (optional): Page number (1-based, default: 1)

**Response:**
```json
{
  "success": true,
  "content": [
    {
      "id": 123,
      "title": "Article Title",
      "type": "Article",
      "status": "Published",
      "author": "admin",
      "updated": "01/15/25 - 2:30 pm",
      "editUrl": "/node/123/edit",
      "viewUrl": "/node/123"
    }
  ],
  "count": 10,
  "pagination": {
    "currentPage": 1,
    "hasNextPage": true,
    "totalPages": 46
  }
}
```

#### Get Content Details

**Retrieve detailed field information for a specific node:**

```bash
curl "http://localhost:3000/content/detail/123"
```

**Response:**
```json
{
  "success": true,
  "content": {
    "nodeId": 123,
    "title": "Article Title",
    "url": "https://example.com/node/123/edit",
    "interface": "edit",
    "data": {
      "title": "Article Title",
      "body[0][value]": "Article content...",
      "status[value]": "1",
      "field_custom[0][value]": "Custom value"
    },
    "extractedAt": "2025-01-15T12:00:00.000Z"
  }
}
```

**Features:**
- Attempts edit interface first for full field access
- Falls back to view interface if edit access denied
- Uses content type schemas when available
- Returns all form fields with their current values

#### Discover Content Types

**Query available content types:**

```bash
curl "http://localhost:3000/content/types"
```

**Response:**
```json
{
  "success": true,
  "contentTypes": [
    {
      "name": "Article",
      "machineName": "article",
      "description": "Use articles for time-sensitive content"
    },
    {
      "name": "Event",
      "machineName": "event",
      "description": "Calendar events"
    }
  ],
  "count": 2,
  "source": "admin"
}
```

---

### Update

**Update content fields by node ID:**

```bash
curl -X PUT -H "Content-Type: application/json" \
  http://localhost:3000/content/123 \
  -d '{
    "title": "Updated Title",
    "body[0][value]": "Updated content",
    "status[value]": "1"
  }'
```

**Request Body:**
- JSON object with field names as keys and new values as values
- Field names match Drupal form field names (e.g., `title`, `body[0][value]`, `field_custom[0][value]`)
- Values can be strings, numbers, or booleans depending on field type

**Response:**
```json
{
  "success": true,
  "nodeId": 123,
  "message": "Content 123 updated successfully",
  "updatedFields": [
    {
      "field": "title",
      "value": "Updated Title"
    },
    {
      "field": "body[0][value]",
      "value": "Updated content"
    }
  ],
  "skippedFields": [],
  "redirectUrl": "https://example.com/node/123"
}
```

#### Update Examples

**Update text fields:**
```bash
curl -X PUT -H "Content-Type: application/json" \
  http://localhost:3000/content/123 \
  -d '{
    "title": "New Title",
    "field_subtitle[0][value]": "New Subtitle"
  }'
```

**Update checkbox (publish/unpublish):**
```bash
# Publish
curl -X PUT -H "Content-Type: application/json" \
  http://localhost:3000/content/123 \
  -d '{"status[value]": "1"}'

# Unpublish
curl -X PUT -H "Content-Type: application/json" \
  http://localhost:3000/content/123 \
  -d '{"status[value]": "0"}'
```

**Update multiple fields:**
```bash
curl -X PUT -H "Content-Type: application/json" \
  http://localhost:3000/content/123 \
  -d '{
    "title": "Updated Event",
    "field_event_date[0][value][date]": "2025-02-15",
    "field_location[0][value]": "Conference Room A",
    "status[value]": "1"
  }'
```

#### Field Resolution Strategy

The update API uses smart field resolution:

1. **Schema-based** (if schema exists in `schemas/` directory):
   - Uses precise selectors from schema files
   - Knows field types (text, checkbox, select, date, etc.)

2. **Fallback patterns** (if no schema):
   - Tries common Drupal patterns: `fieldname[0][value]`
   - Tests multiple selector variations
   - Auto-detects checkbox fields

3. **Alternative selectors**:
   - `[name="fieldname"]`
   - `[name="fieldname[value]"]`
   - `[id*="fieldname"]`
   - `[name*="fieldname"]`

#### Supported Field Types

- **text**: Single-line text fields
- **textarea**: Multi-line text fields
- **checkbox**: Boolean fields (published, featured, etc.)
- **select**: Dropdown/select fields
- **date**: Date fields
- **time**: Time fields

#### Error Handling

- Fields that cannot be found are skipped and reported in `skippedFields`
- Returns detailed field-level feedback for debugging
- Update succeeds even if some fields are skipped
- Check `skippedFields` array to see what couldn't be updated

**Example with skipped fields:**
```json
{
  "success": true,
  "nodeId": 123,
  "updatedFields": [
    {"field": "title", "value": "New Title"}
  ],
  "skippedFields": [
    {"field": "nonexistent_field", "reason": "Field not found"}
  ]
}
```

#### Complete Update Example Script

See `examples/update-content.js` for a complete workflow:

```bash
# Run the example
NODE_ID=123 node examples/update-content.js
```

The example demonstrates:
- Loading authenticated session
- Fetching current content details
- Applying updates
- Verifying changes

---

### Bulk Unpublish Events

`examples/unpublish-events.js` finds every published event node and unpublishes
it by clearing the node form's **Published** checkbox (`status[value]`).

It is a **dry run by default** - it lists what it would change and touches
nothing until you pass `--execute`.

```bash
# 1. See what would be unpublished (no changes)
node examples/unpublish-events.js

# 2. Sanity-check a single node first
node examples/unpublish-events.js --execute --nodes 123

# 3. Unpublish everything it found
node examples/unpublish-events.js --execute --report unpublish-report.json
```

**Options:**

| Option | Description |
|--------|-------------|
| `--execute` | Apply the changes (default is a dry run) |
| `--type <name>` | Content type label or machine name (default: `events`, `ps_events`, `event`) |
| `--nodes <ids>` | Comma-separated node IDs; restricts the run to these nodes |
| `--max <n>` | Safety cap on how many nodes may be unpublished (default: 500) |
| `--delay <ms>` | Delay between node updates (default: 1500) |
| `--page-size <n>` | Items per `admin/content` page request (default: 50, max 100) |
| `--report <path>` | Write a JSON report of the run |
| `--api <url>` | API base URL (default: `$API_BASE` or `http://localhost:3000`) |

**Safety behaviour:**
- Only rows whose type matches *and* whose status is `Published` are selected.
- A node is counted as unpublished only when the API reports `status[value]` in
  `updatedFields`; a skipped field is reported as a failure, not a success.
- A failed node does not abort the run; failures are listed at the end and the
  script exits non-zero.

---

### Delete (Not Yet Implemented)

Coming soon.

---

## 🧱 Layout Builder

Drupal's Layout Builder places configurable blocks into a node's layout. BSP
addresses each block the way Layout Builder does - by **section delta**,
**region**, and **UUID** - and exposes the block's own configuration form.

### Staged vs. saved

Layout Builder writes edits to a per-user tempstore. A block update changes
nothing on the live page until the layout is saved. That is deliberate: it lets
you stage many block edits and publish them in a single commit, or walk away
from a half-finished batch without touching the live site.

```
PUT  /layout/1/block/2/content/<uuid>     -> staged (live page unchanged)
PUT  /layout/1/block/2/content/<uuid>     -> staged
POST /layout/1/save                       -> all staged edits go live at once
POST /layout/1/discard                    -> staged edits thrown away
```

Pass `?save=true` on a block update to stage and save in one call.

### Discovering blocks

```bash
curl "http://localhost:3000/layout/1/blocks"
```

```json
{
  "success": true,
  "nodeId": "1",
  "blocks": [
    {
      "uuid": "cd8dc15d-e080-4765-9ffe-8d4a417ca4ff",
      "delta": 2,
      "region": "content",
      "pluginId": "ps_events_list_conference",
      "label": "001 - Sherrerd Hall",
      "preview": "001 - Sherrerd Hall ORFE Advisers: TBD ..."
    }
  ],
  "count": 8
}
```

`pluginId` and `label` are read straight from the layout markup, which makes
them cheap filters for "every block of this type". Add `?fields=true` to also
list each block's configurable field names - that costs one page load per block.

### Reading and updating a block

```bash
# Read every field on the block's configure form
curl "http://localhost:3000/layout/1/block/2/content/<uuid>"

# Update fields (staged)
curl -X PUT -H "Content-Type: application/json" \
  "http://localhost:3000/layout/1/block/2/content/<uuid>" \
  -d '{"settings[label]": "New label"}'

# Publish everything staged so far
curl -X POST "http://localhost:3000/layout/1/save"
```

Field names are the raw Drupal form names, as returned by the block read
endpoint (`settings[label]`, `settings[ps_core_description][value]`, ...).
Block forms are plugin-defined, so there is no schema to consult - the field
type is inferred from the rendered widget, including CKEditor-backed textareas.

### Bulk Block Updates

`examples/update-layout-blocks.js` applies field values across every block in a
layout that matches a filter. It stages all matching blocks, then saves once. If
any block fails to stage, the layout is **not** saved and staged changes are
discarded, so the live layout is left exactly as it was.

```bash
# Inspect: which blocks match, and what the field currently holds
node examples/update-layout-blocks.js --node 1 \
  --plugin ps_events_list_conference \
  --field 'settings[ps_core_description][value]'

# Apply the same value to every matching block
node examples/update-layout-blocks.js --node 1 \
  --plugin ps_events_list_conference \
  --field 'settings[ps_core_description][value]' \
  --value '<ul><li>ORFE Advisers: TBD</li><li>PhD Candidates / Graduate Students: TBD</li></ul>' \
  --execute --report layout-report.json
```

| Option | Description |
|--------|-------------|
| `--node <id>` | Node whose layout to edit (required) |
| `--plugin <id>` | Only blocks with this block plugin ID |
| `--label <regex>` | Only blocks whose admin label matches this regex |
| `--uuids <list>` | Comma-separated block UUIDs |
| `--field <name>` | Field to set (repeatable, pairs with `--value`) |
| `--value <text>` | Value for the preceding `--field` |
| `--value-file <path>` | Read the preceding field's value from a file |
| `--execute` | Apply the changes (default is a dry run) |
| `--keep-staged` | On failure, leave staged changes instead of discarding |
| `--report <path>` | Write a JSON report of the run |

A `--field` with no `--value` inspects that field instead of changing it.

---

## 🔧 Authentication & Session Management

### Interactive Login Flow

**Two navigation approaches:**

1. **Manual Navigation (Recommended)**
   - Browser starts with `about:blank`
   - Manually navigate to login page
   - Avoids automation detection
   - Best for sites with bot protection

2. **Programmatic Navigation**
   - API navigates to `DEFAULT_LOGIN_URL`
   - Faster for development/testing
   - May trigger bot detection

**Complete flow:**

```bash
# 1. Launch browser
curl -X POST http://localhost:3000/login/interactive

# 2. Navigate (choose one):
#    Option A: Manual via VNC at http://localhost:8080/vnc.html
#    Option B: Programmatic
curl -X POST http://localhost:3000/login/navigate

# 3. Complete login via VNC interface

# 4. Save session
curl -X POST http://localhost:3000/login/save
```

### Session Persistence

**Save session:**
```bash
curl -X POST http://localhost:3000/login/save
```

**Load session:**
```bash
curl -X POST http://localhost:3000/login/load
```

**Storage:** Sessions saved to `storage/storageState.json` (gitignored for security)

**Note:** Session files contain authentication cookies and may become stale. Re-authenticate if operations fail.

### Session Keepalive

**Automatic Keepalive (Internal):**

The system includes an internal keepalive mechanism that automatically refreshes your session to prevent expiration. This is especially important for CAS/Shibboleth authentication where session cookies are session-based.

**Features:**
- **Enabled by default** - Runs automatically when session is loaded
- **Immediate first refresh** - Performs initial refresh immediately on start
- **Configurable interval**: 5-1440 minutes (5 minutes to 24 hours), default 60 minutes
- **Retry logic**: Automatically retries navigation failures up to 3 times with 2-second delays
- **Circuit breaker**: Disables keepalive after 3 consecutive failures to prevent resource waste
- **Auto-recovery**: Resets failure counter on successful refresh
- **Input validation**: Interval automatically constrained to valid range (5-1440 minutes)

**Configuration:**
```bash
KEEPALIVE_ENABLED=true          # Enable/disable (default: true)
KEEPALIVE_INTERVAL_MINUTES=60   # Interval in minutes (default: 60, range: 5-1440)
KEEPALIVE_MAX_FAILURES=3        # Circuit breaker threshold (default: 3)
```

**Important Notes:**
- Minimum interval: 5 minutes (prevents server overload)
- Maximum interval: 1440 minutes/24 hours (prevents sessions from never refreshing)
- Invalid intervals are automatically constrained and logged as warnings

**Check keepalive status:**
```bash
curl http://localhost:3000/session/keepalive/status
```

**Response:**
```json
{
  "success": true,
  "enabled": true,
  "running": true,
  "intervalMinutes": 60,
  "circuitBreaker": {
    "open": false,
    "consecutiveFailures": 0,
    "maxFailures": 3
  }
}
```

**Manual Keepalive (External):**

You can also manually refresh the session as an additional safety layer. The endpoint is **rate-limited to once per minute** to prevent abuse.

```bash
curl -X POST http://localhost:3000/session/keepalive
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "message": "Session refreshed",
  "sessionExpiry": {
    "expiresDate": "2026-12-14T21:41:49.162Z",
    "hoursUntilExpiry": 9595
  },
  "circuitBreaker": {
    "open": false,
    "consecutiveFailures": 0,
    "maxFailures": 3
  }
}
```

**Rate Limit Response (429 Too Many Requests):**
```json
{
  "success": false,
  "error": "Rate limit exceeded. Please wait 45 seconds before refreshing again.",
  "rateLimitInfo": {
    "minIntervalSeconds": 60,
    "secondsRemaining": 45,
    "lastRefreshTime": "2025-11-10T03:15:30.123Z"
  }
}
```

### Authentication Status

**Check authentication:**
```bash
curl http://localhost:3000/login/check
```

**Response:**
```json
{
  "authenticated": true,
  "adminAccess": true
}
```

---

## 📇 CSV Import & Export

Three scripts cover bulk data in and out. They share one idea: **column-to-field
decisions live in a mapping file, not in the script**, so the same tooling serves
any CSV shape and any content type.

| Script | Purpose |
|--------|---------|
| `examples/import-csv.js` | Create nodes from a CSV via a field mapping |
| `examples/export-csv.js` | Write site content out to a CSV |
| `examples/schedule-events.js` | Fill blank room/time columns reproducibly |

Ready-made starting points live in [`examples/templates/`](examples/templates/)
(CSV files) and `examples/mappings/` (field mappings).

---

### Field Mappings

A mapping says which CSV columns become which Drupal form fields:

```json
{
  "contentType": "ps_events",
  "fields": {
    "title":            { "template": "{First} {Last}", "required": true },
    "subtitle":         "{Talk Title|TBD}",
    "body":             "<p>Adviser: {Adviser|TBD}</p>",
    "event_audience":   "{Event Audience}",
    "event_start_date": { "template": "{Date}", "transform": "date" },
    "event_start_time": { "template": "{Start Time}", "transform": "time" },
    "all_day":          { "value": false }
  }
}
```

**Template syntax**

| Form | Meaning |
|------|---------|
| `{Column}` | Value of that CSV column |
| `{Column\|fallback}` | That value, or `fallback` when blank or missing |
| `{{` and `}}` | Literal braces |
| Any surrounding text | Kept as-is, so `<p>Adviser: {Adviser}</p>` works |

**Field options**

| Key | Meaning |
|-----|---------|
| `"template"` | Rendered from the row (a bare string is shorthand for this) |
| `"value"` | A literal - use for booleans and constants, never read from the CSV |
| `"transform"` | `date`, `time`, `number`, `boolean`, `trim`, `upper`, `lower` |
| `"required"` | Abort the run if it resolves empty |
| `"allowEmpty"` | Send the field even when blank (default: omit it) |

Column names are not fixed anywhere. A CSV of `Name,Room,When` just needs a
mapping that reads those columns - no script changes:

```json
{
  "contentType": "ps_events",
  "fields": {
    "title": { "template": "{Name}", "required": true },
    "event_audience": "{Room}",
    "event_start_date": { "template": "{When}", "transform": "date" }
  }
}
```

---

### Import

**Dry run by default** - it prints exactly what it would submit and creates
nothing until `--execute`.

```bash
# 1. See what would be created
node examples/import-csv.js --csv roster.csv \
  --map examples/mappings/ps-events-symposium.json --unpublished

# 2. Canary a single row
node examples/import-csv.js --csv roster.csv --map <spec> --unpublished --limit 1 --execute

# 3. Create the rest
node examples/import-csv.js --csv roster.csv --map <spec> --unpublished --skip 1 --execute \
  --report import-report.json
```

| Option | Description |
|--------|-------------|
| `--csv <path>` | CSV to import (required) |
| `--map <path>` | Mapping JSON |
| `--type <name>` | Content type, overriding the mapping's `contentType` |
| `--set <f=tmpl>` | Add or override one mapped field, repeatable |
| `--execute` | Create the nodes (default is a dry run) |
| `--unpublished` / `--published` | Force the published state |
| `--limit <n>` | Only the first n rows (canary) |
| `--skip <n>` | Skip the first n rows (resume a partial run) |
| `--delay <ms>` | Delay between creations (default: 2000) |
| `--report <path>` | Write a JSON report |
| `--api <url>` | API base URL |

`--set` is for one-off tweaks without editing the mapping file:

```bash
node examples/import-csv.js --csv roster.csv --map <spec> \
  --set 'subtitle={Talk Title|Untitled}' --set 'field_room={Room}'
```

**Safety behaviour**

- Every row's field map is built **before** the first node is created, so a
  malformed row aborts the run rather than leaving a half-imported roster.
- Missing CSV columns are reported up front, naming what the mapping needs and
  what the file actually has.
- A create whose fields were silently skipped counts as a **failure**, not a
  success.

---

### Export

Pages the admin listing into a CSV. Listing columns are free; node field values
cost one request per node.

```bash
# Everything
node examples/export-csv.js --out content.csv

# Published events only
node examples/export-csv.js --out events.csv --type Event --status Published

# Pull node fields in as named columns
node examples/export-csv.js --out roster.csv --type Event \
  --columns id,title,status \
  --field 'field_ps_events_subtitle[0][value]=Talk Title' \
  --field 'field_ps_events_date[0][value][date]=Date'
```

| Option | Description |
|--------|-------------|
| `--out <path>` | Where to write (default: stdout, so it pipes) |
| `--type <name>` | Only rows of this content type |
| `--status <name>` | Only rows with this status |
| `--columns <list>` | Listing columns (default: `id,title,type,status,author,updated,created`) |
| `--field <f=Col>` | Export a node form field as column `Col`, repeatable |
| `--limit <n>` | Stop after n matching rows |
| `--page-size <n>` | Rows per listing request (default: 50, max 100) |

Progress goes to stderr, so `--out` can be omitted and the CSV piped elsewhere.
A `Published` filter matches trailing status markers such as
`Published Restricted`, and never matches `Unpublished`.

**Round-tripping:** export writes the same shape import reads, so content can be
exported, edited in a spreadsheet, and imported back.

---

### Scheduling

`examples/schedule-events.js` fills blank room and time columns on a partially
complete roster.

```bash
node examples/schedule-events.js --csv roster.csv \
  --rooms-file rooms.txt --date 2027-04-30 --seed 20270430 \
  --start '9:00 AM' --slot 15 --break '10:15 AM' --break-minutes 30
```

| Option | Description |
|--------|-------------|
| `--csv <path>` | CSV to read (required) |
| `--out <path>` | Where to write (default: overwrite `--csv`) |
| `--date <date>` | Value for the Date column (required) |
| `--rooms <list>` | Comma-separated room names |
| `--rooms-file <path>` | One room name per line (for names containing commas) |
| `--seed <n>` | PRNG seed (required) |
| `--start <time>` | First slot start (default: 9:00 AM) |
| `--slot <minutes>` | Slot length (default: 15) |
| `--break <time>` | Start of a window no slot may occupy |
| `--break-minutes <n>` | Break length (default: 30) |
| `--room-column <name>` | Column to write the room into (default: Event Audience) |
| `--dry-run` | Print the schedule without writing |

**What the assignment guarantees**

- **Reproducible.** A seeded mulberry32 PRNG drives the shuffle, so the same
  inputs always produce the same schedule. Re-running never reshuffles everyone.
- **Evenly loaded.** Positions advance across all rooms before moving to the next
  time slot, so room counts differ by at most one.
- **No gaps.** Each room's talks form a contiguous run from the first slot.
- **No double-booking.** Every (room, time) position is used at most once.
- **Break respected.** No slot starts inside or runs across the break window.

Omit `--rooms` to reuse the distinct room values already in the CSV, which makes
re-scheduling an existing roster a one-liner.

---

## 📦 Batch Processing

### Pagination

All `/content` responses include comprehensive pagination metadata:
- `currentPage`, `hasNextPage`, `hasPrevPage` - Navigation flags
- `totalPages` - Total pages available (enables batch processing)
- `totalItems` - Total items across all pages
- `currentPageRange` - Text description (e.g., "1-50")

### Batch Processing Examples

**JavaScript Example:**
```bash
npm install
node examples/batch-processor.js
```

**Python Example:**
```bash
conda env create -f environment.yml
conda activate drupal-ui-automation-examples
python3 examples/batch-processor.py
```

Both examples demonstrate:
- Automatic page calculation
- Concurrent/sequential fetching
- Progress tracking
- Result aggregation

---

## 🧪 Testing

### Run Tests

```bash
# All tests in container (REQUIRED for integration tests)
npm run test:container

# Integration tests only
npm run test:integration:container

# Unit tests (host system)
npm test
```

### Test Architecture

**Containerized Testing**: Integration tests run in Docker for consistent environment

**Test Isolation**: Each test starts with clean browser state via cleanup endpoint

**Test Types**:
- **Unit Tests**: Component testing with mocks
- **Integration Tests**: Full browser environment with real Playwright

**Mock API**: Comprehensive mock available for unit testing:

```javascript
const MockApiResponder = require('./tests/mock-api-responder');

const mockApi = new MockApiResponder({ simulateDelays: false });
await mockApi.request('POST', '/login/interactive');
```

---

## 🔧 Configuration

### Environment Variables (.env)

```bash
# Base URL of the Drupal site (REQUIRED)
BASE_URL=https://example.com

# Default login URL (for reference/programmatic navigation)
DEFAULT_LOGIN_URL=https://example.com/login

# Display settings
DISPLAY=:99

# Application settings
NODE_ENV=production

# Debug logging (set to 'true' to enable detailed logging)
# DEBUG_LOGGING=true

# Extra HTTP headers sent with every browser request (JSON object)
# EXTRA_HTTP_HEADERS={"x-wdsoit-bot-bypass":"true"}

# Host ports published by docker-compose (container is always 3000/8080/5900)
# BSP_API_PORT=3000
# BSP_NOVNC_PORT=8080
# BSP_VNC_PORT=5900
```

### Host Ports

The container always listens on **3000** (API), **8080** (noVNC) and **5900**
(VNC) internally. Only the *host* side is configurable, which matters because
those defaults are heavily contended - and on macOS, AirPlay Receiver
permanently holds **5000** and **7000**.

```bash
# .env
BSP_API_PORT=3080
BSP_NOVNC_PORT=8090
BSP_VNC_PORT=5901
```

```bash
docker-compose up -d
curl http://localhost:3080/health
open http://localhost:8090/vnc.html
```

The example scripts read `.env` themselves, so they follow `BSP_API_PORT`
without any flags. Precedence, highest first:

1. `--api http://host:port` on the command line
2. `API_BASE` exported in the shell
3. `BSP_API_PORT` exported in the shell
4. `BSP_API_PORT` in `.env`
5. `http://localhost:3000`

To check what already owns a port on macOS:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

### Extra HTTP Headers (WAF / bot-detection bypass)

Sites behind Cloudflare or a similar bot filter often block headless-style
traffic before it ever reaches Drupal. `EXTRA_HTTP_HEADERS` takes a JSON object
of header name/value pairs that are attached to **every** request the browser
context makes - page loads, form posts, and assets alike.

```bash
# .env
EXTRA_HTTP_HEADERS={"x-wdsoit-bot-bypass":"true"}
```

Notes:
- Applies to both the interactive login context and the restored session context.
- Invalid JSON is ignored with a warning rather than crashing the browser launch.
- Only header *names* are logged; values may be secrets and are never printed.
- Princeton `*.princeton.edu` sites accept `x-wdsoit-bot-bypass` (any value) to
  bypass Cloudflare bot detection.

### Docker Services

- `drupal-ui-automation`: Main application server + browser automation
- `test`: Isolated testing environment (via `--profile test`)

---

## 🏛️ Architecture

### Browser Launch

```
Server Start → No Browser Processes
↓
API Call (/login/interactive) → Browser Launches
↓
Manual Navigation → Session Capture → Programmatic Reuse
```

**Key principles:**
- **Lazy Loading**: Browsers launch only when requested, not on server startup
- **Resource Efficiency**: No idle browser processes
- **Clean State**: Each session starts fresh
- **Manual Navigation**: Respects automation detection
- **Scalability**: Multiple concurrent sessions possible

### Containerization

- **Xvfb Display**: Virtual framebuffer provides headless display (`:99`)
- **VNC Stack**: x11vnc + websockify + noVNC for web-based browser access
- **Process Management**: supervisord orchestrates all services
- **Volume Mounts**: Persistent storage for browser contexts and artifacts

### Schema System

Content type schemas define field extraction and updates. Schemas live in `schemas/` directory.

**Example schema** (`schemas/article.json`):
```json
{
  "contentType": "article",
  "fields": {
    "title": {
      "selector": "[name=\"title[0][value]\"]",
      "type": "text",
      "required": true
    },
    "body": {
      "selector": "[name=\"body[0][value]\"]",
      "type": "textarea"
    },
    "status": {
      "selector": "[name=\"status[value]\"]",
      "type": "checkbox"
    }
  }
}
```

Schemas are automatically loaded based on content type machine name.

---

## 🔍 Troubleshooting

### Browser Not Visible

```bash
# Check browser processes
docker-compose exec drupal-ui-automation ps aux | grep chrome

# Trigger browser launch
curl -X POST http://localhost:3000/login/interactive

# Access via VNC
open http://localhost:8080/vnc.html
```

### Tests Failing

```bash
# Run with verbose output
npm run test:container

# Check container logs
docker-compose logs drupal-ui-automation
```

### VNC Connection Issues

```bash
# Verify VNC services
docker-compose exec drupal-ui-automation ps aux | grep -E "(x11vnc|websockify)"

# Check port accessibility
curl -I http://localhost:8080
```

### Session Expired

```bash
# Re-authenticate
curl -X POST http://localhost:3000/login/interactive
# Complete login via VNC
curl -X POST http://localhost:3000/login/save
```

---

## 📁 Project Structure

```
├── server.js                      # Express API server
├── src/
│   ├── playwrightManager.js       # Browser lifecycle, content & layout automation
│   ├── apiClient.js               # Shared HTTP client + .env loading for scripts
│   ├── csv.js                     # RFC 4180 CSV parse/format
│   ├── fieldMapping.js            # Declarative CSV column -> Drupal field mapping
│   ├── schedule.js                # Seeded room/time-slot assignment
│   └── validation.js              # Request validation
├── examples/
│   ├── import-csv.js              # CSV -> nodes, driven by a field mapping
│   ├── export-csv.js              # Site content -> CSV
│   ├── schedule-events.js         # Fill blank room/time columns
│   ├── unpublish-events.js        # Bulk unpublish by type and status
│   ├── update-layout-blocks.js    # Bulk Layout Builder block edits
│   ├── create-content.js          # Single-node creation workflow
│   ├── update-content.js          # Single-node update workflow
│   ├── update-symposium.js        # Update existing nodes from a CSV
│   ├── batch-processor.js / .py   # Pagination and aggregation examples
│   ├── mappings/                  # Field mapping specs
│   └── templates/                 # Starter CSV files (see its README)
├── schemas/                       # Content type field schemas
├── tests/
│   ├── integration/               # API integration tests
│   ├── unit/                      # Unit tests
│   └── mock-api-responder.js      # Mock API for testing
├── storage/                       # Persistent browser contexts
├── environment.yml                # Conda environment for Python
├── Dockerfile                     # Multi-stage container build
├── docker-compose.yml             # Development orchestration
├── supervisord.conf               # Process management
└── .env                           # Environment configuration
```

---

## 💻 Development

### Local Development

```bash
npm install
npm run dev
```

### Container Development

```bash
docker-compose up --build
```

### Adding New Content Type Support

1. Create schema file in `schemas/` directory (e.g., `schemas/custom_type.json`)
2. Define field selectors and types
3. Schema is automatically loaded for read/update operations

---

## 📚 Additional Resources

- **VNC Interface**: http://localhost:8080/vnc.html
- **API Server**: http://localhost:3000
- **Health Check**: http://localhost:3000/health

---

**Built with**: Node.js, Express, Playwright, Docker, Xvfb, VNC

**Purpose**: Interactive Drupal UI automation with session capture for programmatic workflows.
