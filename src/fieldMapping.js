/**
 * Map CSV rows onto Drupal content fields via a declarative spec.
 *
 * Hardcoding "First + Last becomes the title" or "Adviser goes in the body"
 * only works for one site. A mapping spec moves those decisions into data, so
 * the same importer serves any CSV shape and any content type.
 *
 * Spec shape:
 *   {
 *     "contentType": "ps_events",
 *     "fields": {
 *       "title":    "{First} {Last}",                    // shorthand: a template
 *       "subtitle": { "template": "{Talk Title|TBD}" },  // placeholder fallback
 *       "body":     { "template": "<p>Adviser: {Adviser|TBD}</p>" },
 *       "start":    { "template": "{Date}", "transform": "date" },
 *       "all_day":  { "value": false },                  // literal, no CSV lookup
 *       "title2":   { "template": "{X}", "required": true }
 *     }
 *   }
 *
 * Template syntax:
 *   {Column}            value of that CSV column
 *   {Column|fallback}   that value, or the fallback when blank/missing
 *   {{ and }}           literal braces
 */

const TRANSFORMS = {
  trim: value => String(value).trim(),
  upper: value => String(value).toUpperCase(),
  lower: value => String(value).toLowerCase(),

  /** "5/1/26" or "2027-04-30" -> "2027-04-30" */
  date: value => {
    const text = String(value).trim();
    if (text === '') return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    const parts = text.split('/');
    if (parts.length !== 3) {
      throw new Error(`Could not parse date: "${value}"`);
    }

    const month = parts[0].padStart(2, '0');
    const day = parts[1].padStart(2, '0');
    let year = parts[2];
    if (year.length === 2) year = '20' + year;

    return `${year}-${month}-${day}`;
  },

  /** "9:00 AM" -> "09:00 AM" */
  time: value => {
    const text = String(value).trim();
    if (text === '') return '';

    const match = text.match(/^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/);
    if (!match) return text;

    return `${match[1].padStart(2, '0')}:${match[2]} ${match[3].toUpperCase()}M`;
  },

  number: value => {
    const parsed = Number(String(value).trim());
    if (Number.isNaN(parsed)) throw new Error(`Could not parse number: "${value}"`);
    return parsed;
  },

  boolean: value => {
    const text = String(value).trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes' || text === 'y';
  }
};

/**
 * Render a template string against a CSV row.
 *
 * @param {string} template - Template containing {Column} placeholders
 * @param {Object} row - CSV row keyed by column name
 * @returns {string} Rendered text
 */
function renderTemplate(template, row) {
  const text = String(template);
  let output = '';
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    // {{ and }} are literal braces
    if (char === '{' && text[i + 1] === '{') { output += '{'; i += 2; continue; }
    if (char === '}' && text[i + 1] === '}') { output += '}'; i += 2; continue; }

    if (char === '{') {
      const close = text.indexOf('}', i + 1);
      if (close === -1) {
        throw new Error(`Unclosed placeholder in template: "${template}"`);
      }

      const body = text.slice(i + 1, close);
      const pipe = body.indexOf('|');
      const column = (pipe === -1 ? body : body.slice(0, pipe)).trim();
      const fallback = pipe === -1 ? '' : body.slice(pipe + 1);

      if (column === '') {
        throw new Error(`Empty placeholder in template: "${template}"`);
      }

      const raw = row[column];
      const value = raw === undefined || raw === null ? '' : String(raw).trim();
      output += value === '' ? fallback : value;

      i = close + 1;
      continue;
    }

    output += char;
    i++;
  }

  return output;
}

/**
 * Collect the CSV column names a template refers to.
 */
function templateColumns(template) {
  const columns = [];
  const text = String(template);

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { i++; continue; }
    if (text[i] !== '{') continue;

    const close = text.indexOf('}', i + 1);
    if (close === -1) break;

    const body = text.slice(i + 1, close);
    const pipe = body.indexOf('|');
    const column = (pipe === -1 ? body : body.slice(0, pipe)).trim();
    if (column) columns.push(column);

    i = close;
  }

  return [...new Set(columns)];
}

/**
 * Normalise a field definition to its object form.
 */
function normalizeDefinition(definition) {
  if (typeof definition === 'string') {
    return { template: definition };
  }
  if (definition && typeof definition === 'object') {
    return definition;
  }
  // Numbers, booleans and null are literal values
  return { value: definition };
}

/**
 * Validate a mapping spec, throwing on anything the importer cannot honour.
 */
function validateMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') {
    throw new Error('Mapping must be an object');
  }
  if (!mapping.fields || typeof mapping.fields !== 'object' || Array.isArray(mapping.fields)) {
    throw new Error('Mapping must have a "fields" object');
  }
  if (Object.keys(mapping.fields).length === 0) {
    throw new Error('Mapping "fields" is empty - nothing would be written');
  }

  for (const [name, rawDefinition] of Object.entries(mapping.fields)) {
    const definition = normalizeDefinition(rawDefinition);

    const hasTemplate = definition.template !== undefined;
    const hasValue = definition.value !== undefined;

    if (hasTemplate && hasValue) {
      throw new Error(`Field "${name}" has both "template" and "value" - use one`);
    }
    if (!hasTemplate && !hasValue) {
      throw new Error(`Field "${name}" needs either "template" or "value"`);
    }
    if (definition.transform && !TRANSFORMS[definition.transform]) {
      throw new Error(
        `Field "${name}" uses unknown transform "${definition.transform}". ` +
        `Available: ${Object.keys(TRANSFORMS).join(', ')}`
      );
    }
  }

  return true;
}

/**
 * Every CSV column a mapping reads.
 */
function requiredColumns(mapping) {
  const columns = [];

  for (const rawDefinition of Object.values(mapping.fields)) {
    const definition = normalizeDefinition(rawDefinition);
    if (definition.template !== undefined) {
      columns.push(...templateColumns(definition.template));
    }
  }

  return [...new Set(columns)];
}

/**
 * Build the field map for one CSV row.
 *
 * @param {Object} row - CSV row keyed by column name
 * @param {Object} mapping - Validated mapping spec
 * @returns {Object} Field name/value pairs ready to POST
 */
function applyMapping(row, mapping) {
  const fields = {};

  for (const [name, rawDefinition] of Object.entries(mapping.fields)) {
    const definition = normalizeDefinition(rawDefinition);

    if (definition.value !== undefined) {
      fields[name] = definition.value;
      continue;
    }

    let value = renderTemplate(definition.template, row);

    if (definition.transform) {
      try {
        value = TRANSFORMS[definition.transform](value);
      } catch (error) {
        throw new Error(`Field "${name}": ${error.message}`);
      }
    }

    // A template like "{First} {Last}" renders to a lone space when both columns
    // are blank, which would otherwise sail past an emptiness check and create
    // a node titled " ". Treat whitespace-only output as empty.
    const isEmpty = typeof value === 'string' && value.trim() === '';

    if (definition.required && (isEmpty || value === null || value === undefined)) {
      throw new Error(`Field "${name}" is required but resolved to an empty value`);
    }

    // Drop empties unless the mapping asks to send them
    if (isEmpty && !definition.required) {
      if (definition.allowEmpty !== true) continue;
      value = '';
    }

    fields[name] = value;
  }

  return fields;
}

module.exports = {
  TRANSFORMS,
  renderTemplate,
  templateColumns,
  normalizeDefinition,
  validateMapping,
  requiredColumns,
  applyMapping
};
