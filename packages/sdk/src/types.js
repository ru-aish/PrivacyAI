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
 * @property {Record<string, string>} sessionMap
 */

/**
 * @typedef {Object} PrivateAIResult
 * @property {string} originalText
 * @property {string} sanitizedText
 * @property {string} modelText
 * @property {string} finalText
 * @property {Detection[]} detections
 * @property {Record<string, string>} sessionMap
 * @property {Object} provider
 */

