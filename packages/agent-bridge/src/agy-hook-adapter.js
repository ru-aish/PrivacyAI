import {
  findUnresolvedPlaceholders,
  sanitizeKnownValue,
  valuesEqual
} from "./transform.js";

export function processAgyHookEvent(event, sessionMap = {}) {
  if (!event || typeof event !== "object") {
    throw new TypeError("AGY hook input must be a JSON object.");
  }

  const toolCall = event.toolCall;
  if (!toolCall || typeof toolCall !== "object") {
    return {};
  }

  const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const unresolved = findUnresolvedPlaceholders(args);
  if (unresolved.length > 0) {
    return {
      decision: "deny",
      reason:
        `PrivacyAI blocked this AGY tool call because ${unresolved.length} private ` +
        "placeholder(s) cannot be restored by the current AGY hook API."
    };
  }

  const sanitized = sanitizeKnownValue(args, sessionMap);
  if (!valuesEqual(args, sanitized)) {
    return {
      decision: "deny",
      reason:
        "PrivacyAI blocked this AGY tool call because it contained a known local private value."
    };
  }

  if (Object.keys(sessionMap).length > 0) {
    return {
      decision: "deny",
      reason:
        "PrivacyAI isolated tools for this AGY turn because the prompt contains private data " +
        "and the current AGY hook API cannot sanitize tool results."
    };
  }

  return {
    decision: "allow",
    reason: "PrivacyAI found no protected session values in this AGY turn."
  };
}
