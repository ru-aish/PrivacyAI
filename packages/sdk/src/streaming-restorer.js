import { normalizeSessionMap } from "./session-map-contract.js";
import { compileNormalizedTextRestorer } from "./placeholder-transform.js";

/**
 * Restores exact placeholders from arbitrarily chunked text without emitting a
 * suffix that could still become a complete placeholder.
 */
export class StreamingPlaceholderRestorer {
  constructor(sessionMap = {}) {
    this.sessionMap = normalizeSessionMap(sessionMap);
    this.placeholders = Object.keys(this.sessionMap)
      .sort((left, right) => right.length - left.length);
    this.candidatesByFirstUnit = indexByFirstUnit(this.placeholders);
    this.restoreBufferedText = compileNormalizedTextRestorer(this.sessionMap);
    this.buffer = "";
  }

  push(chunk) {
    if (typeof chunk !== "string") {
      throw new TypeError("StreamingPlaceholderRestorer.push expects a string chunk.");
    }
    if (chunk.length === 0) return "";
    this.buffer += chunk;

    let cursor = 0;
    let output = "";
    while (cursor < this.buffer.length) {
      const candidates = this.candidatesByFirstUnit.get(this.buffer[cursor]) || [];
      if (isIncompletePlaceholder(this.buffer, cursor, candidates)) break;

      const placeholder = candidates.find(candidate =>
        this.buffer.startsWith(candidate, cursor)
      );
      if (placeholder) {
        output += this.sessionMap[placeholder];
        cursor += placeholder.length;
        continue;
      }
      if (isTrailingHighSurrogate(this.buffer, cursor)) break;
      output += this.buffer[cursor];
      cursor += 1;
    }

    this.buffer = this.buffer.slice(cursor);
    return output;
  }

  flush() {
    const output = this.restoreBufferedText(this.buffer);
    this.buffer = "";
    return output;
  }

  get pendingLength() {
    return this.buffer.length;
  }
}

function indexByFirstUnit(placeholders) {
  const index = new Map();
  for (const placeholder of placeholders) {
    const firstUnit = placeholder[0];
    const candidates = index.get(firstUnit) || [];
    candidates.push(placeholder);
    index.set(firstUnit, candidates);
  }
  return index;
}

function isIncompletePlaceholder(text, start, candidates) {
  const remainingLength = text.length - start;
  return candidates.some(placeholder => {
    if (placeholder.length <= remainingLength) return false;
    for (let offset = 0; offset < remainingLength; offset += 1) {
      if (placeholder[offset] !== text[start + offset]) return false;
    }
    return true;
  });
}

function isTrailingHighSurrogate(text, index) {
  if (index !== text.length - 1) return false;
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}
