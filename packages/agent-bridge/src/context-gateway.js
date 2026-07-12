import { rebaseSessionAdditions } from "./prompt-flow.js";
import { sanitizeKnownText } from "./transform.js";

/**
 * Sanitize a value immediately before it becomes model-visible.
 *
 * Hook protocols transport JSON, so structured values are serialized once,
 * sanitized as one atomic document (including object keys), validated, and
 * parsed back into their original shape. This also gives every newly
 * discovered value one stable placeholder throughout the result.
 */
export async function sanitizeModelVisibleValue(value, options = {}) {
  const sessionMap = normalizeSessionMap(options.sessionMap);
  const encoded = encodeValue(value);
  if (!encoded) {
    return { value, sessionMapAdditions: {}, changed: false };
  }
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Context privacy gateway requires a sanitizer function.");
  }

  // Already-known originals never need to be shown to the classifier again.
  const knownSafeText = sanitizeKnownText(encoded.text, sessionMap);
  const maxContextChars = Number(options.maxContextChars || 200000);
  if (knownSafeText.length > maxContextChars) {
    const error = new Error(
      `PrivacyAI blocked model-visible context larger than ${maxContextChars} characters because it cannot be classified safely in one atomic pass.`
    );
    error.code = "PRIVACYAI_CONTEXT_TOO_LARGE";
    throw error;
  }

  // Existing placeholders can themselves look like secrets (for example,
  // contact1@example.com). Shield them while the classifier looks only for new
  // private values, then restore their stable session identity.
  const shield = shieldKnownPlaceholders(knownSafeText, Object.keys(sessionMap));
  const result = await options.sanitizer(shield.text);
  if (!result || typeof result.sanitizedPrompt !== "string") {
    throw new TypeError("Context privacy sanitizer did not return sanitizedPrompt.");
  }

  const restoredClassifierPrompt = shield.restore(result.sanitizedPrompt);
  const restoredClassifierMap = Object.fromEntries(
    Object.entries(result.sessionMap || {}).map(([dummy, original]) => [
      shield.restore(dummy),
      shield.restore(original)
    ])
  );
  const rebased = rebaseSessionAdditions(
    restoredClassifierPrompt,
    restoredClassifierMap,
    sessionMap
  );
  const completeMap = { ...sessionMap, ...rebased.sessionMap };
  assertNoProtectedOriginals(rebased.sanitizedPrompt, completeMap);

  return {
    value: encoded.decode(rebased.sanitizedPrompt),
    sessionMapAdditions: rebased.sessionMap,
    changed: encoded.text !== rebased.sanitizedPrompt
  };
}

export function assertNoProtectedOriginals(serializedPayload, sessionMap = {}) {
  if (typeof serializedPayload !== "string") {
    throw new TypeError("Provider-bound payload must be serialized text.");
  }

  let leakCount = 0;
  const normalizedPayload = serializedPayload.toLocaleLowerCase("en-US");
  for (const original of Object.values(normalizeSessionMap(sessionMap))) {
    if (normalizedPayload.includes(original.toLocaleLowerCase("en-US"))) leakCount += 1;
  }

  if (leakCount > 0) {
    const error = new Error(
      `PrivacyAI blocked provider-bound context because ${leakCount} protected value(s) remained.`
    );
    error.code = "PRIVACYAI_PROVIDER_PAYLOAD_LEAK";
    error.leakCount = leakCount;
    throw error;
  }
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

function encodeValue(value) {
  if (typeof value === "string") {
    return { text: value, decode: text => text };
  }

  if (value === undefined || value === null || typeof value === "boolean") return null;
  const text = JSON.stringify(value);
  if (typeof text !== "string") return null;

  return {
    text,
    decode(sanitizedText) {
      try {
        return JSON.parse(sanitizedText);
      } catch {
        const error = new Error(
          "PrivacyAI blocked model-visible structured context because local sanitization changed its JSON shape."
        );
        error.code = "PRIVACYAI_INVALID_SANITIZED_CONTEXT";
        throw error;
      }
    }
  };
}

function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([dummy, original]) =>
        typeof dummy === "string" &&
        typeof original === "string" &&
        dummy.length > 0 &&
        original.length > 0 &&
        dummy !== original
    )
  );
}
