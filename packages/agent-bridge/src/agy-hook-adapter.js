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

  return {
    decision: "deny",
    reason:
      "PrivacyAI runs AGY in prompt-only isolation because AGY cannot sanitize newly discovered " +
      "private data in tool results, errors, or resources."
  };
}
