import {
  assertNoProtectedOriginals,
  normalizeSessionMap,
  rebaseSessionAdditions,
  sanitizeKnownText
} from "./session-map.js";

/**
 * Sanitize a string or JSON-compatible value as one atomic document.
 * Existing placeholders are shielded from the classifier and newly generated
 * placeholders are rebased against the active session map.
 */
export async function sanitizeStructuredValue(value, options = {}) {
  const sessionMap = normalizeSessionMap(options.sessionMap);
  const encoded = encodeValue(value);
  if (!encoded) {
    return { value, sessionMapAdditions: {}, changed: false };
  }
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Structured privacy sanitization requires a sanitizer function.");
  }

  const knownSafeText = sanitizeKnownText(encoded.text, sessionMap);
  const maxContextChars = Number(options.maxContextChars ?? 200000);
  if (!Number.isSafeInteger(maxContextChars) || maxContextChars <= 0) {
    throw new TypeError("maxContextChars must be a positive safe integer.");
  }
  if (knownSafeText.length > maxContextChars) {
    const error = new Error(
      `PrivacyAI blocked model-visible context larger than ${maxContextChars} characters because it cannot be classified safely in one atomic pass.`
    );
    error.code = "PRIVACYAI_CONTEXT_TOO_LARGE";
    throw error;
  }

  const shield = shieldKnownPlaceholders(knownSafeText, Object.keys(sessionMap));
  const result = await options.sanitizer(shield.text);
  if (!result || typeof result.sanitizedPrompt !== "string") {
    throw new TypeError("Context privacy sanitizer did not return sanitizedPrompt.");
  }

  // Keep existing-placeholder shield tokens in the text while rebasing newly
  // generated placeholders. Otherwise a collision replacement would rename
  // both the new placeholder and the already-established session placeholder.
  const restoredClassifierMap = Object.fromEntries(
    Object.entries(result.sessionMap || {}).map(([placeholder, original]) => [
      shield.restore(placeholder),
      shield.restore(original)
    ])
  );
  const rebased = rebaseSessionAdditions(
    result.sanitizedPrompt,
    restoredClassifierMap,
    sessionMap
  );
  const finalText = shield.restore(rebased.sanitizedText);
  const completeMap = { ...sessionMap, ...rebased.sessionMap };
  assertNoProtectedOriginals(finalText, completeMap);

  return {
    value: encoded.decode(finalText),
    sessionMapAdditions: rebased.sessionMap,
    changed: encoded.text !== finalText
  };
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
