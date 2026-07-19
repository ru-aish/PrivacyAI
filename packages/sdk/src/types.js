/**
 * Canonical placeholder-to-original session map. Placeholder matching is exact
 * for restoration; original matching is case-insensitive for sanitization.
 *
 * @typedef {Record<string, string>} SessionMap
 */

/**
 * @typedef {Object} Detection
 * @property {string} type
 * @property {string} value
 * @property {number} start
 * @property {number} end
 * @property {number} confidence
 * @property {string} source
 */

/**
 * @typedef {Object} SanitizedPrompt
 * @property {string} originalText
 * @property {string} sanitizedText
 * @property {Detection[]} detections
 * @property {SessionMap} sessionMap
 */

/**
 * @typedef {Object} PrivateAIResult
 * @property {string} originalText
 * @property {string} sanitizedText
 * @property {string} modelText
 * @property {string} finalText
 * @property {Detection[]} detections
 * @property {SessionMap} sessionMap
 * @property {Object} provider
 */
