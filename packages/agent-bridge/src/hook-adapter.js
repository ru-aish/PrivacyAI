import {
  findUnresolvedPlaceholders,
  restoreValue,
  sanitizeKnownValue,
  valuesEqual
} from "./transform.js";

export function processHookEvent(event, options = {}) {
  if (!event || typeof event !== "object") {
    throw new TypeError("Hook input must be a JSON object.");
  }

  const flavor = options.flavor || "claude";
  const sessionMap = options.sessionMap || {};
  const eventName = event.hook_event_name;

  if (eventName === "PreToolUse") {
    return processPreToolUse(event, sessionMap);
  }

  if (eventName === "PostToolUse") {
    return processPostToolUse(event, sessionMap, flavor);
  }

  if (eventName === "PostToolBatch") {
    return processPostToolBatch(event, sessionMap, flavor);
  }

  return null;
}

function processPreToolUse(event, sessionMap) {
  const originalInput = event.tool_input;
  if (!originalInput || typeof originalInput !== "object") return null;

  const restoredInput = restoreValue(originalInput, sessionMap);
  const unresolved = findUnresolvedPlaceholders(restoredInput);

  if (unresolved.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `PrivacyAI blocked this tool call because ${unresolved.length} placeholder(s) could not be resolved locally.`
      }
    };
  }

  if (valuesEqual(originalInput, restoredInput)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "PrivacyAI restored local values before tool execution.",
      updatedInput: restoredInput
    }
  };
}

function processPostToolUse(event, sessionMap, flavor) {
  if (!("tool_response" in event)) return null;

  const sanitizedOutput = sanitizeKnownValue(event.tool_response, sessionMap);
  if (valuesEqual(event.tool_response, sanitizedOutput)) return null;

  if (flavor === "claude") {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: sanitizedOutput
      }
    };
  }

  if (flavor === "codex") {
    return {
      continue: false,
      stopReason: "PrivacyAI replaced sensitive tool output before model ingestion.",
      reason: outputAsText(sanitizedOutput)
    };
  }

  throw new Error(`Unsupported agent hook flavor: ${flavor}`);
}

function processPostToolBatch(event, sessionMap, flavor) {
  if (flavor !== "claude" || !Array.isArray(event.tool_calls)) return null;

  const modelVisibleResults = event.tool_calls.map(call => {
    if (!call || typeof call !== "object") return call;
    const { tool_input: _toolInput, ...resultFields } = call;
    return resultFields;
  });
  const sanitizedResults = sanitizeKnownValue(modelVisibleResults, sessionMap);
  if (valuesEqual(modelVisibleResults, sanitizedResults)) return null;

  return {
    continue: false,
    stopReason:
      "PrivacyAI stopped this turn because a failed or batched tool result still contained local private values."
  };
}

function outputAsText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
