import { normalizeSessionMap, restoreText } from "./session-map.js";

/**
 * Restores placeholders in an arbitrarily chunked text stream without emitting
 * a prefix that might later become a complete placeholder.
 */
export class StreamingPlaceholderRestorer {
  constructor(sessionMap = {}) {
    this.sessionMap = normalizeSessionMap(sessionMap);
    this.placeholders = Object.keys(this.sessionMap).sort((a, b) => b.length - a.length);
    this.buffer = "";
  }

  push(chunk) {
    if (typeof chunk !== "string") {
      throw new TypeError("StreamingPlaceholderRestorer.push expects a string chunk.");
    }
    if (chunk.length === 0) return "";
    this.buffer += chunk;
    const holdLength = longestPossiblePlaceholderPrefixSuffix(this.buffer, this.placeholders);
    const emitLength = this.buffer.length - holdLength;
    if (emitLength <= 0) return "";
    const emitted = this.buffer.slice(0, emitLength);
    this.buffer = this.buffer.slice(emitLength);
    return restoreText(emitted, this.sessionMap);
  }

  flush() {
    const emitted = restoreText(this.buffer, this.sessionMap);
    this.buffer = "";
    return emitted;
  }

  get pendingLength() {
    return this.buffer.length;
  }
}

function longestPossiblePlaceholderPrefixSuffix(text, placeholders) {
  let longest = 0;
  for (const placeholder of placeholders) {
    const maximum = Math.min(text.length, placeholder.length - 1);
    for (let length = maximum; length > longest; length -= 1) {
      if (text.endsWith(placeholder.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}
