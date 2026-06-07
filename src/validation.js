/**
 * Shared validation utilities for content operations
 */

const VALIDATION = {
  MAX_TEXT_LENGTH: 10000,
  MAX_TEXTAREA_LENGTH: 50000,
  MAX_FIELDS_COUNT: 50
};

/**
 * Validate content creation/update request
 * @param {string} contentType - Content type machine name
 * @param {object} fields - Field values to validate
 * @returns {{valid: boolean, error?: string, statusCode?: number}}
 */
function validateContentRequest(contentType, fields) {
  // Validate content type
  if (!contentType || typeof contentType !== 'string') {
    return {
      valid: false,
      error: 'Content type is required and must be a string',
      statusCode: 400
    };
  }

  if (contentType.trim().length === 0) {
    return {
      valid: false,
      error: 'Content type cannot be empty',
      statusCode: 400
    };
  }

  // Validate fields object
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {
      valid: false,
      error: 'Fields must be provided as an object',
      statusCode: 400
    };
  }

  const fieldKeys = Object.keys(fields);

  if (fieldKeys.length === 0) {
    return {
      valid: false,
      error: 'At least one field must be provided',
      statusCode: 400
    };
  }

  if (fieldKeys.length > VALIDATION.MAX_FIELDS_COUNT) {
    return {
      valid: false,
      error: `Too many fields. Maximum ${VALIDATION.MAX_FIELDS_COUNT} fields allowed`,
      statusCode: 400
    };
  }

  // Validate field values
  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    // Check field name
    if (typeof fieldName !== 'string' || fieldName.trim().length === 0) {
      return {
        valid: false,
        error: 'Field names must be non-empty strings',
        statusCode: 400
      };
    }

    // Check field value types and lengths
    if (typeof fieldValue === 'string') {
      const length = fieldValue.length;

      // Determine if this is likely a textarea based on length or field name
      const isTextarea = length > 500 || fieldName.toLowerCase().includes('body') ||
                         fieldName.toLowerCase().includes('description');

      const maxLength = isTextarea ? VALIDATION.MAX_TEXTAREA_LENGTH : VALIDATION.MAX_TEXT_LENGTH;

      if (length > maxLength) {
        return {
          valid: false,
          error: `Field "${fieldName}" exceeds maximum length of ${maxLength} characters`,
          statusCode: 400
        };
      }

      // Check for potential XSS - basic check for script tags
      const lowerValue = fieldValue.toLowerCase();
      if (lowerValue.includes('<script') || lowerValue.includes('</script')) {
        return {
          valid: false,
          error: `Field "${fieldName}" contains potentially malicious content`,
          statusCode: 400
        };
      }
    }

    // Validate other types
    if (fieldValue !== null && fieldValue !== undefined) {
      const valueType = typeof fieldValue;
      if (!['string', 'number', 'boolean'].includes(valueType)) {
        return {
          valid: false,
          error: `Field "${fieldName}" has invalid type. Must be string, number, or boolean`,
          statusCode: 400
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Sanitize HTML entities in text
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeText(text) {
  if (typeof text !== 'string') return text;

  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

module.exports = {
  validateContentRequest,
  sanitizeText,
  VALIDATION
};
