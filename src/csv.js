/**
 * Minimal RFC 4180 CSV reader/writer.
 *
 * Splitting on commas breaks as soon as a field contains a comma, a quote, or a
 * newline - all of which show up in real data (talk titles especially). These
 * helpers handle quoting in both directions.
 */

/**
 * Parse CSV text into an array of row objects keyed by header name.
 *
 * @param {string} text - Raw CSV content
 * @returns {{headers: string[], rows: Object[]}}
 */
function parseCSV(text) {
  let input = String(text);

  // Strip a UTF-8 BOM, which Excel likes to add
  if (input.charCodeAt(0) === 0xFEFF) {
    input = input.slice(1);
  }

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
      sawAnyChar = true;
    } else if (char === '\r') {
      // Handled by the \n branch; bare \r is treated as a line break too
      if (input[i + 1] !== '\n') {
        record.push(field);
        records.push(record);
        field = '';
        record = [];
        sawAnyChar = false;
      }
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
      sawAnyChar = false;
    } else {
      field += char;
      sawAnyChar = true;
    }
  }

  // Trailing record with no final newline
  if (sawAnyChar || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // Drop trailing blank lines
  while (records.length > 0 && records[records.length - 1].every(value => value.trim() === '')) {
    records.pop();
  }

  if (records.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = records[0].map(header => header.trim());
  const rows = records.slice(1).map(values => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] !== undefined ? values[index].trim() : '';
    });
    return row;
  });

  return { headers, rows };
}

/**
 * Quote a single CSV field only when it needs it.
 */
function escapeField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Serialise rows back to CSV text.
 *
 * @param {string[]} headers - Column order
 * @param {Object[]} rows - Row objects keyed by header name
 * @returns {string} CSV text ending in a newline
 */
function formatCSV(headers, rows) {
  const lines = [headers.map(escapeField).join(',')];

  for (const row of rows) {
    lines.push(headers.map(header => escapeField(row[header])).join(','));
  }

  return lines.join('\n') + '\n';
}

module.exports = { parseCSV, formatCSV, escapeField };
