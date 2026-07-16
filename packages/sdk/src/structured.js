import {
  assertNoProtectedOriginalsInValue,
  normalizeSessionMap,
  rebaseSessionAdditions,
  sanitizeKnownText
} from "./session-map.js";

const DEFAULT_MAX_CONTEXT_CHARS = 200000;
const MAX_PRIVATE_SPAN_CHARS = 512;
const MAX_CHUNK_OVERLAP = 1024;
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

  const slots = [];
  const template = describeValue(value, slots);
  if (slots.length === 0) {
    return { value, sessionMapAdditions: {}, changed: false };
  }
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Structured privacy sanitization requires a sanitizer function.");
  }
  if (maxContextChars <= MAX_PRIVATE_SPAN_CHARS * 2 + BATCH_OVERHEAD_CHARS) {
    const error = new Error(
      `PrivacyAI cannot safely overlap private spans inside a ${maxContextChars}-character classifier window.`
    );
    error.code = "PRIVACYAI_CONTEXT_TOO_LARGE";
    throw error;
  }

  const state = {
    completeMap: { ...initialMap },
    additions: {}
  };
  const units = buildUnits(slots, maxContextChars - BATCH_OVERHEAD_CHARS);
  const batches = buildBatches(units, maxContextChars);

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    throwIfAborted(options.signal);
    const batch = batches[batchIndex];
    const rawBatchText = encodeBatch(batch);
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

    const restoredMap = Object.fromEntries(
      Object.entries(normalizeSessionMap(result.sessionMap)).map(([placeholder, original]) => [
        shield.restore(placeholder),
        shield.restore(original)
      ])
    );
    const relevantMap = filterClassifierMap(knownSafeText, restoredMap);
    const expected = sanitizeKnownText(shield.text, normalizeSessionMap(result.sessionMap));
    if (result.sanitizedPrompt !== expected) {
      const error = new Error(
        "PrivacyAI blocked structured context because the local sanitizer changed text outside exact private spans."
      );
      error.code = "PRIVACYAI_INVALID_SANITIZED_CONTEXT";
      throw error;
    }
    mergeClassifierMap(relevantMap, state);
    if (typeof options.onBatchComplete === "function") {
      await options.onBatchComplete({
        batchIndex,
        batchCount: batches.length,
        unitCount: batch.length,
        inputChars: rawBatchText.length
      });
    }
  }

  const resolved = slots.map(slot => sanitizeKnownText(slot.value, state.completeMap));
  const sanitizedValue = rebuildValue(template, resolved);
  assertNoProtectedOriginalsInValue(sanitizedValue, state.completeMap);

  return {
    value: sanitizedValue,
    sessionMapAdditions: state.additions,
    changed: !valuesEqual(value, sanitizedValue)
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
    // Object keys are model-visible data too. Always classify them; otherwise
    // identifier-shaped credentials can bypass scanning simply by appearing as
    // a key rather than a value.
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

function buildUnits(slots, maxChunkChars) {
  const units = [];
  slots.forEach((slot, slotIndex) => {
    splitText(slot.value, maxChunkChars).forEach((text, chunkIndex) => {
      units.push({ slotIndex, chunkIndex, text });
    });
  });
  return units;
}

function buildBatches(units, maxContextChars) {
  const batches = [];
  let current = [];
  let currentLength = 0;
  for (const unit of units) {
    const encodedLength = encodedUnitLength(unit);
    if (current.length > 0 && currentLength + encodedLength > maxContextChars) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(unit);
    currentLength += encodedLength;
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

function splitText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  // A private span accepted at MAX_PRIVATE_SPAN_CHARS must be wholly present
  // in at least one adjacent chunk. The minimum configured window guarantees
  // maxChars is large enough for this overlap.
  const overlap = Math.min(
    MAX_CHUNK_OVERLAP,
    MAX_PRIVATE_SPAN_CHARS,
    Math.floor(maxChars / 2)
  );
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) end = preferredBoundary(text, start, end, maxChars);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function preferredBoundary(text, start, hardEnd, maxChars) {
  const minimum = start + Math.floor(maxChars * 0.65);
  const window = text.slice(minimum, hardEnd);
  const newline = window.lastIndexOf("\n");
  if (newline !== -1) return minimum + newline + 1;
  const whitespace = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
  return whitespace === -1 ? hardEnd : minimum + whitespace + 1;
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
  const occupied = new Set([text, ...placeholders]);
  const sorted = [...new Set(placeholders.filter(Boolean))].sort((a, b) => b.length - a.length);

  for (let index = 0; index < sorted.length; index += 1) {
    const placeholder = sorted[index];
    let token = `__PRIVACYAI_BOUNDARY_${index}__`;
    while ([...occupied].some(value => value.includes(token))) token += "_";
    occupied.add(token);
    shielded = shielded.split(placeholder).join(token);
    replacements.push([token, placeholder]);
  }

  return {
    text: shielded,
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
