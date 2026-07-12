import { sanitizeModelVisibleValue } from "./context-gateway.js";
import {
  findUnresolvedPlaceholders,
  restoreValue,
  valuesEqual
} from "./transform.js";

const FAILURE_EVENT_NAMES = new Set([
  "PostToolUseFailure",
  "ToolError",
  "ToolFailure",
  "PostToolBatch"
]);

export async function processHookEvent(event, options = {}) {
  if (!event || typeof event !== "object") {
    throw new TypeError("Hook input must be a JSON object.");
  }

  const flavor = options.flavor || "claude";
  const sessionMap = options.sessionMap || {};
  const eventName = event.hook_event_name;

  if (eventName === "PreToolUse") {
    return processPreToolUse(event, sessionMap, flavor, options);
  }

  if (eventName === "PostToolUse") {
    return processPostToolUse(event, sessionMap, flavor, options);
  }

  if (FAILURE_EVENT_NAMES.has(eventName)) {
    return processFailureEvent(event, sessionMap, flavor, options);
  }

  return null;
}

function processPreToolUse(event, sessionMap, flavor, options) {
  if (resolveToolPolicy(flavor, options.toolPolicy) === "isolate") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `PrivacyAI runs ${flavor} in prompt-only isolation because this host cannot guarantee ` +
          "sanitization for every failed, cancelled, deferred, or implicitly loaded tool result."
      }
    };
  }

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

function resolveToolPolicy(flavor, requestedPolicy) {
  if (requestedPolicy !== undefined) {
    if (!new Set(["gateway", "isolate"]).has(requestedPolicy)) {
      throw new TypeError(`Unsupported PrivacyAI tool policy: ${requestedPolicy}`);
    }
    return requestedPolicy;
  }
  return flavor === "codex" || flavor === "agy" ? "isolate" : "gateway";
}

async function processPostToolUse(event, sessionMap, flavor, options) {
  if (!("tool_response" in event)) return null;

  const sanitized = await sanitizeModelVisibleValue(event.tool_response, {
    sanitizer: options.sanitizer,
    sessionMap,
    maxContextChars: options.maxContextChars
  });
  await persistAdditions(sanitized.sessionMapAdditions, options);
  if (!sanitized.changed) return null;

  if (flavor === "claude") {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: sanitized.value
      }
    };
  }

  if (flavor === "codex") {
    return {
      continue: false,
      stopReason: "PrivacyAI replaced sensitive tool output before model ingestion.",
      reason: outputAsText(sanitized.value)
    };
  }

  throw new Error(`Unsupported agent hook flavor: ${flavor}`);
}

async function processFailureEvent(event, sessionMap, flavor, options) {
  const modelVisibleValue = event.hook_event_name === "PostToolBatch"
    ? modelVisibleBatchResults(event)
    : modelVisibleFailureFields(event);
  if (modelVisibleValue === null) return null;

  const sanitized = await sanitizeModelVisibleValue(modelVisibleValue, {
    sanitizer: options.sanitizer,
    sessionMap,
    maxContextChars: options.maxContextChars
  });
  await persistAdditions(sanitized.sessionMapAdditions, options);
  if (!sanitized.changed) return null;

  // Current Claude and Codex failure/batch hook APIs do not expose a reliable,
  // shape-preserving replacement field. Stopping the turn is the only safe
  // choice once private content is found.
  return {
    continue: false,
    stopReason:
      `PrivacyAI stopped this ${flavor} turn because a failed, cancelled, or batched tool result contained private data.`
  };
}

function modelVisibleBatchResults(event) {
  if (!Array.isArray(event.tool_calls)) return null;
  return event.tool_calls.map(call => {
    if (!call || typeof call !== "object") return call;
    const {
      tool_input: _toolInput,
      input: _input,
      arguments: _arguments,
      ...resultFields
    } = call;
    return resultFields;
  });
}

function modelVisibleFailureFields(event) {
  const {
    hook_event_name: _eventName,
    session_id: _sessionId,
    transcript_path: _transcriptPath,
    cwd: _cwd,
    permission_mode: _permissionMode,
    tool_input: _toolInput,
    input: _input,
    arguments: _arguments,
    ...resultFields
  } = event;
  return Object.keys(resultFields).length > 0 ? resultFields : null;
}

async function persistAdditions(additions, options) {
  if (Object.keys(additions).length === 0) return;
  if (typeof options.onSessionMapAdditions !== "function") {
    throw new Error("Context privacy gateway discovered private values but no session vault writer was configured.");
  }
  await options.onSessionMapAdditions(additions);
}

function outputAsText(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
