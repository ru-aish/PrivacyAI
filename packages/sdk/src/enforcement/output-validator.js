import { collectProtectedSpans } from "../policy/protected-spans.js";

export function validateSanitizedOutput({ originalText, sanitizedText, sessionMap, requiredKeeps = [], requiredRedacts = [] }) {
  const leaks = [];
  const missingContext = [];
  const mapErrors = [];

  const lowerSanitized = sanitizedText.toLowerCase();

  // 1. No sessionMap original value remains in sanitizedText
  for (const [dummy, original] of Object.entries(sessionMap)) {
    if (dummy === original) continue;
    if (lowerSanitized.includes(original.toLowerCase())) {
      leaks.push({
        type: "session-map-leak",
        value: original,
        dummy
      });
    }
  }

  // 2. Check explicitly required redacts
  for (const val of requiredRedacts) {
    if (lowerSanitized.includes(val.toLowerCase())) {
      leaks.push({
        type: "required-redact-leak",
        value: val
      });
    }
  }

  // 3. Check explicitly required keeps
  for (const val of requiredKeeps) {
    if (!lowerSanitized.includes(val.toLowerCase())) {
      missingContext.push({
        type: "required-keep-missing",
        value: val
      });
    }
  }

  return {
    ok: leaks.length === 0 && missingContext.length === 0 && mapErrors.length === 0,
    leaks,
    missingContext,
    mapErrors
  };
}
