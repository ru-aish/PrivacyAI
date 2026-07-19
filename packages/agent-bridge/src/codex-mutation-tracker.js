import {
  commitHookFileMutation,
  stageHookFileMutation
} from "./hook-file-mutation.js";

/** Stage complete, locally restored Codex tool calls before execution. */
export async function stageCompletedCodexToolCalls(
  items,
  sessionKey,
  sessionMap,
  context
) {
  if (!context.cwd || !sessionKey || !Array.isArray(items)) return;
  for (const item of items) {
    const event = codexToolMutationEvent(item, sessionKey, context.cwd);
    if (!event) continue;
    try {
      await stageHookFileMutation(event, trackerOptions(context, sessionMap));
    } catch {
      // Provenance is an optimization and never weakens response restoration.
    }
  }
}

/** Commit staged calls only when matching tool-output history returns. */
export async function commitCodexMutationHistory(
  body,
  sessionKey,
  sessionMap,
  context
) {
  if (!context.cwd || !Array.isArray(body?.input)) return;
  const calls = new Map();
  const completed = new Set();

  for (const item of body.input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (typeof item.call_id === "string" && item.call_id) {
        calls.set(item.call_id, item);
      }
      continue;
    }
    if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
    ) {
      if (typeof item.call_id === "string" && item.call_id) {
        completed.add(item.call_id);
      }
    }
  }

  for (const callId of completed) {
    const event = codexToolMutationEvent(
      calls.get(callId),
      sessionKey,
      context.cwd
    );
    if (!event) continue;
    try {
      await commitHookFileMutation(event, trackerOptions(context, sessionMap));
    } catch {
      // A failed proof remains a cache miss; request sanitization still proceeds.
    }
  }
}

function trackerOptions(context, sessionMap) {
  return {
    store: context.verificationStore,
    sessionMap,
    policyFingerprint: context.policyFingerprint,
    cwd: context.cwd
  };
}

function codexToolMutationEvent(item, sessionKey, cwd) {
  if (!item || typeof item !== "object") return null;
  const callId = typeof item.call_id === "string" && item.call_id
    ? item.call_id
    : typeof item.id === "string" && item.id
      ? item.id
      : null;
  if (!callId || typeof item.name !== "string" || !item.name) return null;

  const toolInput = codexToolInput(item);
  if (!toolInput) return null;
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionKey,
    tool_use_id: callId,
    tool_name: item.name,
    cwd,
    tool_input: toolInput
  };
}

function codexToolInput(item) {
  if (item.type === "function_call") {
    if (typeof item.arguments !== "string") return null;
    try {
      const parsed = JSON.parse(item.arguments);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }
  if (item.type !== "custom_tool_call" || typeof item.input !== "string") {
    return null;
  }
  return item.name.toLocaleLowerCase("en-US") === "apply_patch"
    ? { patch: item.input }
    : { input: item.input };
}
