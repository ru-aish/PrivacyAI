import {
  assertNoProtectedOriginalsInValue,
  normalizeSessionMap,
  rebaseSessionAdditions,
  sanitizeKnownText
} from "./session-map.js";
import { estimatePrivacyTokens, normalizeTokenBudget } from "./token-budget.js";

const DEFAULT_MAX_CONTEXT_CHARS = 200000;
const MAX_PRIVATE_SPAN_CHARS = 512;
const MIN_SAFE_CHUNK_CHARS = MAX_PRIVATE_SPAN_CHARS * 2;
const BATCH_OVERHEAD_CHARS = 128;

/**
 * Sanitize a JSON-compatible value as bounded text batches. The local model
 * returns only exact private mappings; PrivacyAI rebuilds the original shape
 * locally, so the classifier never needs to reproduce a large document.
 */
export async function sanitizeStructuredValue(value, options = {}) {
  throwIfAborted(options.signal);
  const initialMap = normalizeSessionMap(options.sessionMap);
  const maxContextChars = Number(options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS);
  if (!Number.isSafeInteger(maxContextChars) || maxContextChars <= 0) {
    throw new TypeError("maxContextChars must be a positive safe integer.");
  }
  const maxContextTokens = normalizeTokenBudget(
    options.maxContextTokens,
    Math.max(2048, Math.floor(maxContextChars / 2))
  );
  const countTokens = text => estimatePrivacyTokens(text, options.tokenCounter);

  const slots = [];
  const template = describeValue(value, slots);
  if (slots.length === 0) {
    // Preserve the established empty-value result shape. Callers that aggregate
    // batching metrics already know no model work occurred when no slots exist.
    return {
      value,
      sessionMapAdditions: {},
      changed: false
    };
  }
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Structured privacy sanitization requires a sanitizer function.");
  }
  assertSafeClassifierWindow(maxContextChars, maxContextTokens, countTokens);

  const state = {
    completeMap: { ...initialMap },
    additions: {}
  };
  const units = buildUnits(slots, maxContextChars, maxContextTokens, countTokens);
  const batches = buildBatches(units, maxContextChars, maxContextTokens);
  let packedChars = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    throwIfAborted(options.signal);
    const batch = batches[batchIndex];
    const rawBatchText = encodeBatch(batch);
    const inputTokens = countTokens(rawBatchText);
    if (rawBatchText.length > maxContextChars || inputTokens > maxContextTokens) {
      throw contextWindowError(maxContextChars, maxContextTokens);
    }
    packedChars += rawBatchText.length;
    const knownSafeText = sanitizeKnownText(rawBatchText, state.completeMap);
    const shield = shieldKnownPlaceholders(knownSafeText, Object.keys(state.completeMap));
    const result = await options.sanitizer(shield.text, {
      identityConfidenceThreshold: options.identityConfidenceThreshold ?? 0.85,
      artifactType: options.artifactType || "structured_context",
      signal: options.signal
    });
    throwIfAborted(options.signal);
    if (!result || typeof result.sanitizedPrompt !== "string") {
      throw new TypeError("Context privacy sanitizer did not return sanitizedPrompt.");
    }

    const classifierMap = normalizeSessionMap(result.sessionMap);
    const expected = sanitizeKnownText(shield.text, classifierMap);
    if (result.sanitizedPrompt !== expected) {
      const error = new Error(
        "PrivacyAI blocked structured context because the local sanitizer changed text outside exact private spans."
      );
      error.code = "PRIVACYAI_INVALID_SANITIZED_CONTEXT";
      throw error;
    }
    const restoredMap = restoreClassifierMap(classifierMap, shield);
    const relevantMap = filterClassifierMap(knownSafeText, restoredMap);
    mergeClassifierMap(relevantMap, state);
    if (typeof options.onBatchComplete === "function") {
      await options.onBatchComplete({
        batchIndex,
        batchCount: batches.length,
        unitCount: batch.length,
        inputChars: rawBatchText.length,
        estimatedInputTokens: inputTokens
      });
    }
  }

  const resolved = slots.map(slot => sanitizeKnownText(slot.value, state.completeMap));
  const sanitizedValue = rebuildValue(template, resolved);
  assertNoProtectedOriginalsInValue(sanitizedValue, state.completeMap);

  return {
    value: sanitizedValue,
    sessionMapAdditions: state.additions,
    changed: !valuesEqual(value, sanitizedValue),
    metrics: {
      modelCallCount: batches.length,
      batchCount: batches.length,
      unitCount: units.length,
      packedChars
    }
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("PrivacyAI stopped sanitization because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_REQUEST_ABORTED";
  throw error;
}

function describeValue(value, slots, options = {}) {
  if (typeof value === "string") {
    const index = slots.length;
    slots.push({ value, kind: options.kind || "value" });
    return { type: "slot", index };
  }
  if (Array.isArray(value)) {
    return { type: "array", items: value.map(entry => describeValue(entry, slots)) };
  }
  if (!value || typeof value !== "object") return { type: "literal", value };

  const entries = [];
  for (const [key, entry] of Object.entries(value)) {
    const keyDescriptor = describeValue(key, slots, { kind: "key" });
    entries.push({ key: keyDescriptor, value: describeValue(entry, slots) });
  }
  return { type: "object", entries };
}

function rebuildValue(template, resolved) {
  switch (template.type) {
    case "slot":
      return resolved[template.index];
    case "literal":
      return template.value;
    case "array":
      return template.items.map(entry => rebuildValue(entry, resolved));
    case "object": {
      const output = {};
      for (const entry of template.entries) {
        const key = rebuildValue(entry.key, resolved);
        if (Object.hasOwn(output, key)) {
          const error = new Error("PrivacyAI blocked a structured value because key transformation caused a collision.");
          error.code = "PRIVACYAI_TRANSFORM_KEY_COLLISION";
          throw error;
        }
        Object.defineProperty(output, key, {
          value: rebuildValue(entry.value, resolved),
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return output;
    }
    default:
      throw new TypeError("PrivacyAI encountered an invalid structured-value template.");
  }
}

function assertSafeClassifierWindow(maxChars, maxTokens, countTokens) {
  if (maxChars <= MIN_SAFE_CHUNK_CHARS + BATCH_OVERHEAD_CHARS) {
    throw contextWindowError(maxChars, maxTokens);
  }
  const probe = `${unitHeader({ slotIndex: 0, chunkIndex: 0 })}${"!".repeat(MIN_SAFE_CHUNK_CHARS)}`;
  if (countTokens(probe) > maxTokens) throw contextWindowError(maxChars, maxTokens);
}

function buildUnits(slots, maxChars, maxTokens, countTokens) {
  const units = [];
  slots.forEach((slot, slotIndex) => {
    splitText(slot.value, slotIndex, maxChars, maxTokens, countTokens).forEach((text, chunkIndex) => {
      const unit = { slotIndex, chunkIndex, text };
      unit.encodedChars = encodedUnitLength(unit);
      unit.estimatedTokens = countTokens(`${unitHeader(unit)}${unit.text}`);
      if (unit.encodedChars > maxChars || unit.estimatedTokens > maxTokens) {
        throw contextWindowError(maxChars, maxTokens);
      }
      units.push(unit);
    });
  });
  return units;
}

function buildBatches(units, maxContextChars, maxContextTokens) {
  const batches = [];
  let current = [];
  let currentLength = 0;
  let currentTokens = 0;
  for (const unit of units) {
    if (current.length > 0 && (
      currentLength + unit.encodedChars > maxContextChars ||
      currentTokens + unit.estimatedTokens > maxContextTokens
    )) {
      batches.push(current);
      current = [];
      currentLength = 0;
      currentTokens = 0;
    }
    current.push(unit);
    currentLength += unit.encodedChars;
    currentTokens += unit.estimatedTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function encodeBatch(batch) {
  return batch.map(unit => `${unitHeader(unit)}${unit.text}`).join("");
}

function encodedUnitLength(unit) {
  return unitHeader(unit).length + unit.text.length;
}

function unitHeader(unit) {
  return `\n__PRIVACYAI_SLOT_${unit.slotIndex}_${unit.chunkIndex}__\n`;
}

function splitText(text, slotIndex, maxChars, maxTokens, countTokens) {
  const chunks = [];
  let start = 0;
  let chunkIndex = 0;
  while (start < text.length || (text.length === 0 && chunkIndex === 0)) {
    const header = unitHeader({ slotIndex, chunkIndex });
    const hardCharEnd = Math.min(text.length, start + Math.max(1, maxChars - header.length));
    let end = largestFittingEnd(text, start, hardCharEnd, header, maxTokens, countTokens);
    if (end <= start && text.length > 0) throw contextWindowError(maxChars, maxTokens);
    if (end < text.length) {
      const bounded = preferredBoundary(text, start, end, Math.max(1, end - start));
      if (bounded - start >= MIN_SAFE_CHUNK_CHARS) end = bounded;
    }
    end = avoidBrokenSurrogate(text, start, end);
    if (end < text.length && end - start < MIN_SAFE_CHUNK_CHARS) {
      throw contextWindowError(maxChars, maxTokens);
    }
    const chunk = text.slice(start, end);
    if (header.length + chunk.length > maxChars || countTokens(`${header}${chunk}`) > maxTokens) {
      throw contextWindowError(maxChars, maxTokens);
    }
    chunks.push(chunk);
    chunkIndex += 1;
    if (end >= text.length) break;
    // A non-final chunk is at least two maximum private spans wide, so keeping
    // one full span as overlap guarantees boundary coverage and advances by at
    // least MAX_PRIVATE_SPAN_CHARS UTF-16 units per classifier call.
    start = end - MAX_PRIVATE_SPAN_CHARS;
  }
  return chunks;
}

function largestFittingEnd(text, start, hardEnd, header, maxTokens, countTokens) {
  let low = start;
  let high = hardEnd;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (countTokens(`${header}${text.slice(start, middle)}`) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return low;
}

function avoidBrokenSurrogate(text, start, end) {
  if (end <= start || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return end - 1;
  }
  return end;
}

function preferredBoundary(text, start, hardEnd, span) {
  const minimum = start + Math.floor(span * 0.65);
  const window = text.slice(minimum, hardEnd);
  const newline = window.lastIndexOf("\n");
  if (newline !== -1) return minimum + newline + 1;
  const whitespace = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
  return whitespace === -1 ? hardEnd : minimum + whitespace + 1;
}

function contextWindowError(maxChars, maxTokens) {
  const error = new Error(
    `PrivacyAI cannot safely overlap private spans inside a ${maxChars}-character/${maxTokens}-token classifier window.`
  );
  error.code = "PRIVACYAI_CONTEXT_TOO_LARGE";
  return error;
}

function filterClassifierMap(inputText, sessionMap) {
  const filtered = {};
  for (const [placeholder, original] of Object.entries(sessionMap)) {
    if (
      typeof original !== "string" ||
      original.length === 0 ||
      original.length > MAX_PRIVATE_SPAN_CHARS ||
      /\r|\n/.test(original)
    ) {
      const error = new Error(
        "PrivacyAI blocked a local classifier result that did not identify a bounded exact substring."
      );
      error.code = "PRIVACYAI_INVALID_CLASSIFIER_SPAN";
      throw error;
    }
    if (inputText.includes(original)) filtered[placeholder] = original;
  }
  return filtered;
}

function restoreClassifierMap(classifierMap, shield) {
  const entries = [];
  for (const [placeholder, original] of Object.entries(classifierMap)) {
    if (shield.containsToken(placeholder)) {
      const error = new Error(
        "PrivacyAI blocked a local classifier result that reused a reserved boundary token."
      );
      error.code = "PRIVACYAI_INVALID_SANITIZED_CONTEXT";
      throw error;
    }
    // Boundary tokens stand in for placeholders that are already protected by
    // the existing session map. A classifier may conservatively label one
    // complete synthetic token as private, but it is not a new private
    // original and must never become a placeholder -> placeholder alias.
    if (shield.isToken(original)) continue;
    if (shield.containsToken(original)) {
      const error = new Error(
        "PrivacyAI blocked a local classifier result that mixed a reserved boundary token with an exact private span."
      );
      error.code = "PRIVACYAI_INVALID_CLASSIFIER_SPAN";
      throw error;
    }
    entries.push([shield.restore(placeholder), shield.restore(original)]);
  }
  return Object.fromEntries(entries);
}

function mergeClassifierMap(classifierMap, state) {
  if (Object.keys(classifierMap).length === 0) return;
  const rebased = rebaseSessionAdditions(
    JSON.stringify(Object.keys(classifierMap)),
    classifierMap,
    state.completeMap
  );
  Object.assign(state.completeMap, rebased.sessionMap);
  Object.assign(state.additions, rebased.sessionMap);
}

function shieldKnownPlaceholders(text, placeholders) {
  let shielded = text;
  const replacements = [];
  const occupied = [text, ...placeholders]
    .map(value => String(value).toLocaleLowerCase("en-US"));
  const sorted = [...new Set(placeholders.filter(Boolean))].sort((a, b) => b.length - a.length);

  for (let index = 0; index < sorted.length; index += 1) {
    const placeholder = sorted[index];
    let token = `__PRIVACYAI_BOUNDARY_${index}__`;
    while (occupied.some(value => value.includes(token.toLocaleLowerCase("en-US")))) token += "_";
    occupied.push(token.toLocaleLowerCase("en-US"));
    shielded = shielded.split(placeholder).join(token);
    replacements.push([token, placeholder]);
  }

  const foldedTokens = replacements.map(([token]) => token.toLocaleLowerCase("en-US"));
  return {
    text: shielded,
    isToken(value) {
      if (typeof value !== "string") return false;
      return foldedTokens.includes(value.toLocaleLowerCase("en-US"));
    },
    containsToken(value) {
      if (typeof value !== "string") return false;
      const folded = value.toLocaleLowerCase("en-US");
      return foldedTokens.some(token => folded.includes(token));
    },
    restore(value) {
      if (typeof value !== "string") return value;
      let restored = value;
      for (const [token, placeholder] of replacements) {
        restored = restored.split(token).join(placeholder);
      }
      return restored;
    }
  };
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
