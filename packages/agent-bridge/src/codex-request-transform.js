import { createHash } from "node:crypto";

import {
  assertNoProtectedOriginals,
  restoreValue,
  sanitizeStructuredValue
} from "@privacy-ai/sdk";

const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "stream_options",
  "include",
  "service_tier",
  "prompt_cache_key",
  "text",
  "client_metadata",
  "previous_response_id",
  "generate"
]);

const CODEX_REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "authorization",
  "chatgpt-account-id",
  "content-type",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "originator",
  "session-id",
  "thread-id",
  "user-agent",
  "version",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-openai-fedramp",
  "x-openai-internal-codex-responses-lite",
  "x-openai-subagent"
]);

const RESERVED_METADATA_FIELDS = new Set([
  "x-codex-installation-id",
  "session_id",
  "thread_id",
  "turn_id",
  "parent_thread_id",
  "forked_from_thread_id",
  "x-codex-window-id",
  "x-openai-subagent",
  "x-codex-parent-thread-id",
  "x-codex-turn-state"
]);

export async function sanitizeCodexRequestBody(body, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw gatewayError("PRIVACYAI_CODEX_INVALID_REQUEST", "Codex provider request body must be a JSON object.");
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD",
        `PrivacyAI blocked an unsupported Codex provider field: ${key}`
      );
    }
  }
  if (!Array.isArray(body.input)) {
    throw gatewayError("PRIVACYAI_CODEX_INVALID_REQUEST", "Codex provider request input must be an array.");
  }
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Codex request transformation requires a sanitizer function.");
  }
  validateCodexControlFields(body);

  const transformed = deepClone(body);
  transformed.client_metadata = sanitizeClientMetadata(transformed.client_metadata);
  if (typeof transformed.prompt_cache_key === "string" && transformed.prompt_cache_key) {
    transformed.prompt_cache_key = hashCacheKey(transformed.prompt_cache_key);
  }

  const slots = [];
  if (typeof transformed.instructions === "string") {
    slots.push(slot(transformed, ["instructions"]));
  }
  collectResponseItems(transformed.input, slots, ["input"]);
  if (transformed.tools != null) collectToolDefinitions(transformed.tools, slots, ["tools"]);
  if (transformed.text?.format?.schema != null) {
    const schemaPath = ["text", "format", "schema"];
    collectAllStringValues(transformed.text.format.schema, slots, schemaPath);
    collectJsonSchemaKeys(transformed.text.format.schema, slots, schemaPath);
  }

  let sessionMapAdditions = {};
  const resolved = new Array(slots.length);
  const uncached = [];
  const cacheWrites = [];
  const cacheScope = sessionMapCacheScope(options.sessionMap);
  for (let index = 0; index < slots.length; index += 1) {
    const cacheKey = modelVisibleCacheKey(slots[index].value, cacheScope);
    if (options.cache?.has(cacheKey)) {
      resolved[index] = deepClone(options.cache.get(cacheKey));
    } else {
      uncached.push({ index, cacheKey, value: slots[index].value });
    }
  }

  if (uncached.length > 0) {
    const result = await sanitizeStructuredValue(uncached.map(entry => entry.value), {
      sanitizer: options.sanitizer,
      sessionMap: options.sessionMap,
      maxContextChars: options.maxContextChars
    });
    if (!Array.isArray(result.value) || result.value.length !== uncached.length) {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_SANITIZED_REQUEST",
        "PrivacyAI blocked the Codex request because sanitization changed its model-visible shape."
      );
    }
    result.value.forEach((value, offset) => {
      const entry = uncached[offset];
      resolved[entry.index] = value;
      cacheWrites.push([entry.cacheKey, deepClone(value)]);
    });
    sessionMapAdditions = result.sessionMapAdditions;
  }

  const keyRenames = [];
  resolved.forEach((value, index) => {
    const entry = slots[index];
    if (entry.keyRename) {
      keyRenames.push({ ...entry, value });
      return;
    }
    setAtPath(transformed, entry.path, entry.jsonString ? JSON.stringify(value) : value);
  });
  keyRenames
    .sort((left, right) => right.parentPath.length - left.parentPath.length)
    .forEach(entry => renameKeyAtPath(transformed, entry.parentPath, entry.oldKey, entry.value));

  const completeMap = { ...(options.sessionMap || {}), ...sessionMapAdditions };
  assertNoProtectedOriginals(JSON.stringify(transformed), completeMap);

  return {
    body: transformed,
    sessionMapAdditions,
    cacheWrites,
    sessionKey: codexSessionKey(body, options.fallbackSessionId, options.headers)
  };
}

export function codexSessionContext(body, fallbackSessionId, headers = {}) {
  const metadata = body?.client_metadata || {};
  const bodyTurnMetadata = parseTurnMetadata(metadata?.["x-codex-turn-metadata"]) || {};
  const headerTurnMetadata = parseTurnMetadata(headerValue(headers, "x-codex-turn-metadata")) || {};
  const raw = [
    metadata.thread_id,
    bodyTurnMetadata.thread_id,
    headerTurnMetadata.thread_id,
    metadata.session_id,
    bodyTurnMetadata.session_id,
    headerTurnMetadata.session_id,
    fallbackSessionId
  ].find(value => isSafeMetadataToken(value, 256));
  if (!raw) {
    throw gatewayError(
      "PRIVACYAI_CODEX_SESSION_ID_REQUIRED",
      "PrivacyAI blocked a Codex provider request without stable thread or session metadata."
    );
  }

  const parentIds = [
    metadata.parent_thread_id,
    metadata.forked_from_thread_id,
    bodyTurnMetadata.parent_thread_id,
    bodyTurnMetadata.forked_from_thread_id,
    headerTurnMetadata.parent_thread_id,
    headerTurnMetadata.forked_from_thread_id,
    headerValue(headers, "x-codex-parent-thread-id")
  ].filter(value => isSafeMetadataToken(value, 256) && value !== raw);
  return {
    sessionKey: `codex-provider:${raw}`,
    parentSessionKeys: [...new Set(parentIds)].map(value => `codex-provider:${value}`)
  };
}

export function codexSessionKey(body, fallbackSessionId, headers = {}) {
  return codexSessionContext(body, fallbackSessionId, headers).sessionKey;
}

export function sanitizeCodexMetadataHeaders(headers = {}) {
  const next = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName).toLowerCase();
    if (!CODEX_REQUEST_HEADER_ALLOWLIST.has(name) || rawValue == null) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
    if (name === "x-codex-turn-metadata") {
      const sanitized = sanitizeTurnMetadataValue(value);
      if (sanitized != null) next[name] = sanitized;
      continue;
    }
    if (!isSafeForwardedHeaderValue(name, value)) continue;
    next[name] = value;
  }
  return next;
}

export function restoreCodexJsonResponse(value, sessionMap = {}) {
  if (!value || typeof value !== "object") return value;
  const cloned = deepClone(value);
  if (cloned.item) restoreResponseItem(cloned.item, sessionMap);
  if (typeof cloned.delta === "string") cloned.delta = restoreValue(cloned.delta, sessionMap);
  if (typeof cloned.text === "string") cloned.text = restoreValue(cloned.text, sessionMap);
  if (cloned.response?.error?.message && typeof cloned.response.error.message === "string") {
    cloned.response.error.message = restoreValue(cloned.response.error.message, sessionMap);
  }
  if (cloned.error?.message && typeof cloned.error.message === "string") {
    cloned.error.message = restoreValue(cloned.error.message, sessionMap);
  }
  return cloned;
}

export function restoreCodexCompactResponse(value, sessionMap = {}) {
  assertPlainObject(value, "compact response");
  assertOnlyKeys(value, new Set(["output"]), "compact response");
  if (!Array.isArray(value.output)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_COMPACT_RESPONSE",
      "PrivacyAI blocked a Codex compact response without an output array."
    );
  }

  const cloned = deepClone(value);
  cloned.output.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string") {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_COMPACT_RESPONSE",
        `PrivacyAI blocked malformed Codex compact output at index ${index}.`
      );
    }
    restoreResponseItem(item, sessionMap);
  });
  return cloned;
}

export function restoreResponseItem(item, sessionMap = {}) {
  if (!item || typeof item !== "object") return item;
  switch (item.type) {
    case "message":
      restoreContentItems(item.content, sessionMap);
      break;
    case "agent_message":
      item.author = restoreMaybeString(item.author, sessionMap);
      item.recipient = restoreMaybeString(item.recipient, sessionMap);
      restoreContentItems(item.content, sessionMap);
      break;
    case "reasoning":
      restoreReasoningEntries(item.summary, sessionMap);
      restoreReasoningEntries(item.content, sessionMap);
      break;
    case "local_shell_call":
      validateStatus(item.status, "local shell response status", true);
      assertPlainObject(item.action, "local shell response action");
      assertOnlyKeys(
        item.action,
        new Set(["type", "command", "timeout_ms", "working_directory", "env", "user"]),
        "local shell response action"
      );
      if (
        item.action.type !== "exec" ||
        !Array.isArray(item.action.command) ||
        item.action.command.some(value => typeof value !== "string")
      ) {
        throw gatewayError(
          "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM",
          "PrivacyAI blocked a malformed Codex local-shell response."
        );
      }
      if (
        item.action.timeout_ms != null &&
        (!Number.isSafeInteger(item.action.timeout_ms) || item.action.timeout_ms < 0)
      ) {
        throw gatewayError(
          "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM",
          "PrivacyAI blocked an invalid Codex local-shell response timeout."
        );
      }
      for (const key of ["working_directory", "user"]) {
        if (item.action[key] != null && typeof item.action[key] !== "string") {
          throw gatewayError(
            "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM",
            `PrivacyAI blocked a non-string Codex local-shell response ${key}.`
          );
        }
      }
      if (item.action.env != null) {
        assertPlainObject(item.action.env, "local shell response environment");
        if (Object.values(item.action.env).some(value => typeof value !== "string")) {
          throw gatewayError(
            "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM",
            "PrivacyAI blocked non-string Codex local-shell response environment data."
          );
        }
      }
      item.action = restoreValue(item.action, sessionMap);
      break;
    case "function_call":
      item.name = restoreMaybeString(item.name, sessionMap);
      item.namespace = restoreMaybeString(item.namespace, sessionMap);
      item.arguments = restoreJsonString(item.arguments, sessionMap);
      break;
    case "custom_tool_call":
      item.name = restoreMaybeString(item.name, sessionMap);
      item.namespace = restoreMaybeString(item.namespace, sessionMap);
      item.input = restoreMaybeString(item.input, sessionMap);
      break;
    case "tool_search_call":
      item.arguments = restoreValue(item.arguments, sessionMap);
      break;
    case "function_call_output":
    case "custom_tool_call_output":
      item.output = restoreOutputPayload(item.output, sessionMap);
      break;
    case "tool_search_output":
    case "additional_tools":
      item.tools = restoreValue(item.tools, sessionMap);
      break;
    case "web_search_call":
    case "image_generation_call":
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM",
        `PrivacyAI blocked provider-hosted Codex response item type: ${item.type}`
      );
    case "compaction":
    case "context_compaction":
    case "compaction_trigger":
      break;
    case "ghost_snapshot":
    case "other":
    case "unknown":
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM",
        `PrivacyAI blocked unsupported Codex response item type: ${item.type}`
      );
    default:
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM",
        `PrivacyAI blocked unknown Codex response item type: ${safeResponseItemType(item.type)}`
      );
  }
  return item;
}

function validateCodexControlFields(body) {
  assertProtocolToken(body.model, "model", 160);
  if (body.instructions != null && typeof body.instructions !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_CONTROL",
      "PrivacyAI blocked non-string Codex instructions."
    );
  }
  if (body.tools != null && !Array.isArray(body.tools)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_CONTROL",
      "PrivacyAI blocked a non-array Codex tools field."
    );
  }
  if (body.tool_choice != null && body.tool_choice !== "auto") {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_TOOL_CHOICE",
      "PrivacyAI supports only Codex tool_choice=auto through the provider gateway."
    );
  }
  for (const key of ["parallel_tool_calls", "store", "stream", "generate"]) {
    if (body[key] != null && typeof body[key] !== "boolean") {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_REQUEST_CONTROL",
        `PrivacyAI blocked a non-boolean Codex ${key} field.`
      );
    }
  }
  validateReasoningControl(body.reasoning);
  validateStreamOptions(body.stream_options);
  validateInclude(body.include);
  if (body.service_tier != null && !new Set(["priority", "flex"]).has(body.service_tier)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_SERVICE_TIER",
      "PrivacyAI blocked an unsupported Codex service tier."
    );
  }
  if (body.prompt_cache_key != null) {
    if (typeof body.prompt_cache_key !== "string" || body.prompt_cache_key.length > 4096) {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_REQUEST_CONTROL",
        "PrivacyAI blocked an invalid Codex prompt cache key."
      );
    }
  }
  if (body.previous_response_id != null) {
    assertProtocolToken(body.previous_response_id, "previous_response_id", 256);
  }
  validateTextControl(body.text);
}

function validateReasoningControl(reasoning) {
  if (reasoning == null) return;
  assertPlainObject(reasoning, "reasoning");
  assertOnlyKeys(reasoning, new Set(["effort", "summary", "context"]), "reasoning");
  if (
    reasoning.effort != null &&
    !new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).has(
      reasoning.effort
    )
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_REASONING",
      "PrivacyAI blocked an unsupported Codex reasoning effort."
    );
  }
  if (
    reasoning.summary != null &&
    !new Set(["auto", "concise", "detailed", "none"]).has(reasoning.summary)
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_REASONING",
      "PrivacyAI blocked an unsupported Codex reasoning summary mode."
    );
  }
  if (
    reasoning.context != null &&
    !new Set(["auto", "current_turn", "all_turns"]).has(reasoning.context)
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_REASONING",
      "PrivacyAI blocked an unsupported Codex reasoning context mode."
    );
  }
}

function validateStreamOptions(value) {
  if (value == null) return;
  assertPlainObject(value, "stream_options");
  assertOnlyKeys(value, new Set(["reasoning_summary_delivery"]), "stream_options");
  if (value.reasoning_summary_delivery !== "sequential_cutoff") {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_STREAM_OPTIONS",
      "PrivacyAI blocked unsupported Codex stream options."
    );
  }
}

function validateInclude(value) {
  if (value == null) return;
  if (
    !Array.isArray(value) ||
    value.some(entry => entry !== "reasoning.encrypted_content") ||
    new Set(value).size !== value.length
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_INCLUDE",
      "PrivacyAI blocked unsupported Codex include fields."
    );
  }
}

function validateTextControl(value) {
  if (value == null) return;
  assertPlainObject(value, "text");
  assertOnlyKeys(value, new Set(["verbosity", "format"]), "text");
  if (value.verbosity != null && !new Set(["low", "medium", "high"]).has(value.verbosity)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_TEXT_CONTROL",
      "PrivacyAI blocked an unsupported Codex text verbosity."
    );
  }
  if (value.format == null) return;
  assertPlainObject(value.format, "text.format");
  assertOnlyKeys(value.format, new Set(["type", "strict", "schema", "name"]), "text.format");
  if (
    value.format.type !== "json_schema" ||
    typeof value.format.strict !== "boolean" ||
    value.format.name !== "codex_output_schema" ||
    !(
      typeof value.format.schema === "boolean" ||
      (value.format.schema && typeof value.format.schema === "object" && !Array.isArray(value.format.schema))
    )
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_TEXT_CONTROL",
      "PrivacyAI blocked an unsupported Codex structured-output control."
    );
  }
}

function collectResponseItems(items, slots, basePath) {
  items.forEach((item, index) => collectResponseItem(item, slots, [...basePath, index]));
}

function collectResponseItem(item, slots, path) {
  if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.type !== "string") {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked an invalid Codex response item.");
  }
  switch (item.type) {
    case "message":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "role", "content", "phase", "internal_chat_message_metadata_passthrough"]),
        "message"
      );
      if (!new Set(["user", "assistant", "developer", "system"]).has(item.role)) {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked an unsupported Codex message role.");
      }
      if (item.phase != null && !new Set(["commentary", "final_answer"]).has(item.phase)) {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked an unsupported Codex message phase.");
      }
      collectContentItems(item.content, slots, [...path, "content"]);
      return;
    case "agent_message":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "author", "recipient", "content", "internal_chat_message_metadata_passthrough"]),
        "agent_message"
      );
      collectRequiredString(item, "author", slots, path);
      collectRequiredString(item, "recipient", slots, path);
      collectAgentContentItems(item.content, slots, [...path, "content"]);
      return;
    case "reasoning":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "summary", "content", "encrypted_content", "internal_chat_message_metadata_passthrough"]),
        "reasoning"
      );
      collectReasoningEntries(item.summary, slots, [...path, "summary"], new Set(["summary_text"]));
      collectReasoningEntries(item.content, slots, [...path, "content"], new Set(["reasoning_text", "text"]));
      validateOpaqueProviderValue(item.encrypted_content, "reasoning encrypted content");
      return;
    case "local_shell_call":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "call_id", "status", "action", "internal_chat_message_metadata_passthrough"]),
        "local_shell_call"
      );
      validateStatus(item.status, "local shell status", true);
      collectLocalShellAction(item.action, slots, [...path, "action"]);
      return;
    case "function_call":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "name", "namespace", "arguments", "call_id", "internal_chat_message_metadata_passthrough"]),
        "function_call"
      );
      collectRequiredString(item, "name", slots, path);
      collectOptionalString(item, "namespace", slots, path);
      requireProtocolIdentity(item.call_id, "function call id");
      collectJsonStringField(item, "arguments", slots, path);
      return;
    case "custom_tool_call":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "status", "call_id", "name", "namespace", "input", "internal_chat_message_metadata_passthrough"]),
        "custom_tool_call"
      );
      validateStatus(item.status, "custom tool status", false);
      requireProtocolIdentity(item.call_id, "custom tool call id");
      collectRequiredString(item, "name", slots, path);
      collectOptionalString(item, "namespace", slots, path);
      collectRequiredString(item, "input", slots, path);
      return;
    case "tool_search_call":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "call_id", "status", "execution", "arguments", "internal_chat_message_metadata_passthrough"]),
        "tool_search_call"
      );
      validateStatus(item.status, "tool search status", false);
      if (item.execution !== "client") {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked non-client Codex tool search.");
      }
      collectToolSearchArguments(item.arguments, slots, [...path, "arguments"]);
      return;
    case "function_call_output":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "call_id", "output", "internal_chat_message_metadata_passthrough"]),
        "function_call_output"
      );
      requireProtocolIdentity(item.call_id, "function output call id");
      collectOutputPayload(item.output, slots, [...path, "output"]);
      return;
    case "custom_tool_call_output":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "call_id", "name", "output", "internal_chat_message_metadata_passthrough"]),
        "custom_tool_call_output"
      );
      requireProtocolIdentity(item.call_id, "custom output call id");
      collectOptionalString(item, "name", slots, path);
      collectOutputPayload(item.output, slots, [...path, "output"]);
      return;
    case "tool_search_output":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "call_id", "status", "execution", "tools", "internal_chat_message_metadata_passthrough"]),
        "tool_search_output"
      );
      validateStatus(item.status, "tool search output status", true);
      if (item.execution !== "client") {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked non-client Codex tool-search output.");
      }
      collectToolDefinitions(item.tools, slots, [...path, "tools"]);
      return;
    case "additional_tools":
      validateResponseItemShape(item, new Set(["type", "id", "role", "tools"]), "additional_tools");
      if (item.role !== "assistant") {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked unsupported additional-tools role.");
      }
      collectToolDefinitions(item.tools, slots, [...path, "tools"]);
      return;
    case "web_search_call":
    case "image_generation_call":
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_PROVIDER_TOOL",
        `PrivacyAI blocked provider-hosted Codex history item type: ${item.type}`
      );
    case "compaction":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "encrypted_content", "internal_chat_message_metadata_passthrough"]),
        "compaction"
      );
      validateOpaqueProviderValue(item.encrypted_content, "compaction content", true);
      return;
    case "context_compaction":
      validateResponseItemShape(
        item,
        new Set(["type", "id", "encrypted_content", "internal_chat_message_metadata_passthrough"]),
        "context_compaction"
      );
      validateOpaqueProviderValue(item.encrypted_content, "context compaction content");
      return;
    case "compaction_trigger":
      assertOnlyKeys(item, new Set(["type"]), "compaction_trigger");
      return;
    default:
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_INPUT",
        `PrivacyAI blocked unsupported Codex response item type: ${safeResponseItemType(item.type)}`
      );
  }
}

function collectContentItems(content, slots, path) {
  if (!Array.isArray(content)) {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "Codex message content must be an array.");
  }
  content.forEach((entry, index) => {
    const entryPath = [...path, index];
    assertPlainObject(entry, "message content");
    if (new Set(["input_image", "output_image", "input_file", "computer_screenshot"]).has(entry.type)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_MEDIA",
        `PrivacyAI does not yet support Codex media content type: ${entry.type}`
      );
    }
    if (!new Set(["input_text", "output_text"]).has(entry.type)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_CONTENT",
        `PrivacyAI blocked unsupported Codex content type: ${safeResponseItemType(entry.type)}`
      );
    }
    assertOnlyKeys(entry, new Set(["type", "text"]), "message content");
    if (typeof entry.text !== "string") {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_CONTENT",
        "PrivacyAI blocked a Codex text content item without string text."
      );
    }
    slots.push({ path: [...entryPath, "text"], value: entry.text });
  });
}

function collectAgentContentItems(content, slots, path) {
  if (!Array.isArray(content)) {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "Codex agent-message content must be an array.");
  }
  content.forEach((entry, index) => {
    const entryPath = [...path, index];
    assertPlainObject(entry, "agent-message content");
    if (entry.type === "input_text") {
      assertOnlyKeys(entry, new Set(["type", "text"]), "agent-message text");
      if (typeof entry.text !== "string") {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_CONTENT", "PrivacyAI blocked malformed agent text.");
      }
      slots.push({ path: [...entryPath, "text"], value: entry.text });
      return;
    }
    if (entry.type === "encrypted_content") {
      assertOnlyKeys(entry, new Set(["type", "encrypted_content"]), "agent encrypted content");
      validateOpaqueProviderValue(entry.encrypted_content, "agent encrypted content", true);
      return;
    }
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_CONTENT",
      `PrivacyAI blocked unsupported agent-message content: ${safeResponseItemType(entry.type)}`
    );
  });
}

function collectReasoningEntries(entries, slots, path, allowedTypes) {
  if (entries == null) return;
  if (!Array.isArray(entries)) {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked malformed reasoning content.");
  }
  entries.forEach((entry, index) => {
    assertPlainObject(entry, "reasoning content");
    assertOnlyKeys(entry, new Set(["type", "text"]), "reasoning content");
    if (!allowedTypes.has(entry.type) || typeof entry.text !== "string") {
      throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked unsupported reasoning content.");
    }
    slots.push({ path: [...path, index, "text"], value: entry.text });
  });
}

function collectLocalShellAction(action, slots, path) {
  assertPlainObject(action, "local shell action");
  assertOnlyKeys(
    action,
    new Set(["type", "command", "timeout_ms", "working_directory", "env", "user"]),
    "local shell action"
  );
  if (action.type !== "exec" || !Array.isArray(action.command) || action.command.some(value => typeof value !== "string")) {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked malformed local shell action.");
  }
  action.command.forEach((value, index) => slots.push({ path: [...path, "command", index], value }));
  if (action.timeout_ms != null && (!Number.isSafeInteger(action.timeout_ms) || action.timeout_ms < 0)) {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked invalid local shell timeout.");
  }
  collectOptionalString(action, "working_directory", slots, path);
  collectOptionalString(action, "user", slots, path);
  if (action.env != null) {
    assertPlainObject(action.env, "local shell environment");
    for (const [key, value] of Object.entries(action.env)) {
      if (typeof value !== "string") {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked non-string shell environment data.");
      }
      slots.push({ keyRename: true, parentPath: [...path, "env"], oldKey: key, value: key });
      slots.push({ path: [...path, "env", key], value });
    }
  }
}

function collectToolSearchArguments(value, slots, path) {
  assertPlainObject(value, "tool-search arguments");
  assertOnlyKeys(value, new Set(["query", "limit"]), "tool-search arguments");
  if (typeof value.query !== "string") {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked tool search without a string query.");
  }
  slots.push({ path: [...path, "query"], value: value.query });
  if (value.limit != null && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)) {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked invalid tool-search limit.");
  }
}

function collectToolOutputContentItems(content, slots, path) {
  if (!Array.isArray(content)) {
    throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked non-array tool output content.");
  }
  content.forEach((entry, index) => {
    const entryPath = [...path, index];
    assertPlainObject(entry, "tool output content");
    if (entry.type === "input_text") {
      assertOnlyKeys(entry, new Set(["type", "text"]), "tool output text");
      if (typeof entry.text !== "string") {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_CONTENT", "PrivacyAI blocked malformed tool output text.");
      }
      slots.push({ path: [...entryPath, "text"], value: entry.text });
      return;
    }
    if (entry.type === "encrypted_content") {
      assertOnlyKeys(entry, new Set(["type", "encrypted_content"]), "encrypted tool output");
      validateOpaqueProviderValue(entry.encrypted_content, "encrypted tool output", true);
      return;
    }
    if (entry.type === "input_image") {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_MEDIA",
        "PrivacyAI does not yet support image tool output content."
      );
    }
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_CONTENT",
      `PrivacyAI blocked unsupported tool output content: ${safeResponseItemType(entry.type)}`
    );
  });
}

function collectOutputPayload(output, slots, path) {
  if (typeof output === "string") {
    slots.push({ path, value: output });
    return;
  }
  if (Array.isArray(output)) {
    collectToolOutputContentItems(output, slots, path);
    return;
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    assertOnlyKeys(output, new Set(["content", "content_items"]), "tool output payload");
    const hasContent = typeof output.content === "string";
    const hasItems = Array.isArray(output.content_items);
    if (hasContent === hasItems) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_INPUT",
        "PrivacyAI blocked an ambiguous structured tool output payload."
      );
    }
    if (hasContent) slots.push({ path: [...path, "content"], value: output.content });
    else collectToolOutputContentItems(output.content_items, slots, [...path, "content_items"]);
    return;
  }
  throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked an invalid tool output payload.");
}

function collectToolDefinitions(value, slots, path) {
  if (value == null) return;
  if (!Array.isArray(value)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
      "PrivacyAI blocked a non-array Codex tool definition list."
    );
  }
  value.forEach((tool, index) => collectToolDefinition(tool, slots, [...path, index]));
}

function collectToolDefinition(tool, slots, path, options = {}) {
  assertPlainObject(tool, "tool definition");
  if (typeof tool.type !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
      "PrivacyAI blocked a Codex tool without a string type."
    );
  }

  switch (tool.type) {
    case "function":
      assertOnlyKeys(
        tool,
        new Set(["type", "name", "description", "strict", "defer_loading", "parameters"]),
        "function tool"
      );
      collectRequiredString(tool, "name", slots, path);
      collectRequiredString(tool, "description", slots, path);
      if (typeof tool.strict !== "boolean") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a function tool without a boolean strict field."
        );
      }
      if (tool.defer_loading != null && typeof tool.defer_loading !== "boolean") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a function tool with invalid defer_loading."
        );
      }
      collectJsonSchema(tool.parameters, slots, [...path, "parameters"]);
      return;
    case "namespace":
      if (options.nested) {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a nested Codex tool namespace."
        );
      }
      assertOnlyKeys(tool, new Set(["type", "name", "description", "tools"]), "tool namespace");
      collectRequiredString(tool, "name", slots, path);
      collectRequiredString(tool, "description", slots, path);
      if (!Array.isArray(tool.tools)) {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a namespace without a tool array."
        );
      }
      tool.tools.forEach((child, index) => {
        if (child?.type !== "function") {
          throw gatewayError(
            "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
            "PrivacyAI supports only function tools inside Codex namespaces."
          );
        }
        collectToolDefinition(child, slots, [...path, "tools", index], { nested: true });
      });
      return;
    case "tool_search":
      if (options.nested) {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a nested Codex tool-search definition."
        );
      }
      assertOnlyKeys(
        tool,
        new Set(["type", "execution", "description", "parameters"]),
        "tool_search definition"
      );
      if (tool.execution !== "client") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI supports only client-executed Codex tool search."
        );
      }
      collectRequiredString(tool, "description", slots, path);
      collectJsonSchema(tool.parameters, slots, [...path, "parameters"]);
      return;
    case "custom":
      if (options.nested) {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a nested Codex custom tool."
        );
      }
      assertOnlyKeys(tool, new Set(["type", "name", "description", "format"]), "custom tool");
      collectRequiredString(tool, "name", slots, path);
      collectRequiredString(tool, "description", slots, path);
      assertPlainObject(tool.format, "custom tool format");
      assertOnlyKeys(tool.format, new Set(["type", "syntax", "definition"]), "custom tool format");
      if (tool.format.type !== "grammar" || tool.format.syntax !== "lark") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI supports only Codex Lark grammar custom tools."
        );
      }
      collectRequiredString(tool.format, "definition", slots, [...path, "format"]);
      return;
    case "web_search":
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_PROVIDER_TOOL",
        "PrivacyAI blocked a provider-hosted Codex web-search tool."
      );
    default:
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
        `PrivacyAI blocked unsupported Codex tool type: ${safeResponseItemType(tool.type)}`
      );
  }
}

function collectJsonSchema(value, slots, path) {
  if (!(
    typeof value === "boolean" ||
    (value && typeof value === "object" && !Array.isArray(value))
  )) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
      "PrivacyAI blocked an invalid Codex JSON Schema."
    );
  }
  collectAllStringValues(value, slots, path);
  collectJsonSchemaKeys(value, slots, path);
}

function collectJsonSchemaKeys(value, slots, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectJsonSchemaKeys(entry, slots, [...path, index]));
    return;
  }
  if (!value || typeof value !== "object") return;

  const userKeyMaps = new Set([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependentRequired"
  ]);
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    if (userKeyMaps.has(key) && entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const [userKey, child] of Object.entries(entry)) {
        slots.push({
          keyRename: true,
          parentPath: entryPath,
          oldKey: userKey,
          value: userKey
        });
        collectJsonSchemaKeys(child, slots, [...entryPath, userKey]);
      }
      continue;
    }
    collectJsonSchemaKeys(entry, slots, entryPath);
  }
}

function collectAllStringValues(value, slots, path, excludedKeys = new Set()) {
  if (typeof value === "string") {
    slots.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectAllStringValues(entry, slots, [...path, index], excludedKeys));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (excludedKeys.has(key)) continue;
    collectAllStringValues(entry, slots, [...path, key], excludedKeys);
  }
}

function sanitizeClientMetadata(metadata) {
  if (metadata == null) return metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw gatewayError("PRIVACYAI_CODEX_INVALID_METADATA", "Codex client_metadata must be an object.");
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "x-codex-turn-metadata") {
      const turnMetadata = sanitizeTurnMetadataValue(value);
      if (turnMetadata != null) sanitized[key] = turnMetadata;
      continue;
    }
    if (RESERVED_METADATA_FIELDS.has(key) && isSafeClientMetadataValue(key, value)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function isSafeClientMetadataValue(key, value) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) return false;
  if (key === "x-codex-turn-state") return value.length <= 8192;
  return value.length <= 256 && /^[A-Za-z0-9._:+\/-]+$/.test(value);
}

function isSafeForwardedHeaderValue(name, value) {
  if (value.length === 0 || value.length > 8192 || /[\r\n\0]/.test(value)) return false;

  if (name === "content-type") {
    return /^application\/json(?:\s*;\s*charset=[A-Za-z0-9._-]+)?$/i.test(value);
  }
  if (name === "accept") {
    return value
      .split(",")
      .map(entry => entry.trim().split(";", 1)[0].toLowerCase())
      .every(entry => new Set(["text/event-stream", "application/json", "*/*"]).has(entry));
  }
  if (name === "user-agent") {
    return value.length <= 512 && !value.includes("@") && /^[\x20-\x7E]+$/.test(value);
  }
  if (new Set([
    "originator",
    "session-id",
    "thread-id",
    "version",
    "x-client-request-id",
    "x-codex-beta-features",
    "x-codex-installation-id",
    "x-codex-parent-thread-id",
    "x-codex-window-id",
    "x-openai-subagent"
  ]).has(name)) {
    return /^[A-Za-z0-9._:+,\/-]{1,1024}$/.test(value);
  }
  if (new Set([
    "openai-beta",
    "x-openai-fedramp",
    "x-openai-internal-codex-responses-lite"
  ]).has(name)) {
    return /^[A-Za-z0-9._:+,=\/-]{1,1024}$/.test(value);
  }

  // Authentication, account/workspace routing, and sticky turn-state values are
  // opaque provider-issued tokens. They are forwarded only under exact names.
  return true;
}

function sanitizeTurnMetadataValue(value) {
  const parsed = parseTurnMetadata(value);
  if (!parsed) return null;
  const allowed = {};
  for (const key of [
    "installation_id",
    "session_id",
    "thread_id",
    "turn_id",
    "window_id",
    "forked_from_thread_id",
    "parent_thread_id"
  ]) {
    if (isSafeMetadataToken(parsed[key], 256)) allowed[key] = parsed[key];
  }
  for (const key of ["request_kind", "subagent_kind"]) {
    if (isSafeMetadataToken(parsed[key], 128)) allowed[key] = parsed[key];
  }
  if (
    Number.isSafeInteger(parsed.turn_started_at_unix_ms) &&
    parsed.turn_started_at_unix_ms >= 0
  ) {
    allowed.turn_started_at_unix_ms = parsed.turn_started_at_unix_ms;
  }
  return JSON.stringify(allowed);
}

function isSafeMetadataToken(value, maxLength) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._:+\/-]+$/.test(value)
  );
}

function headerValue(headers, expectedName) {
  for (const [name, rawValue] of Object.entries(headers || {})) {
    if (String(name).toLowerCase() !== expectedName) continue;
    if (Array.isArray(rawValue)) return rawValue.join(", ");
    return rawValue == null ? null : String(rawValue);
  }
  return null;
}

function parseTurnMetadata(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      `PrivacyAI blocked malformed Codex ${label}.`
    );
  }
}

function assertOnlyKeys(value, allowed, label) {
  assertPlainObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD",
        `PrivacyAI blocked an unsupported field in Codex ${label}: ${safeResponseItemType(key)}`
      );
    }
  }
}

function assertProtocolToken(value, label, maxLength = 256) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !/^[A-Za-z0-9._:+\/-]+$/.test(value)
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_PROTOCOL_TOKEN",
      `PrivacyAI blocked an invalid Codex ${label}.`
    );
  }
}

function validateResponseItemShape(item, allowed, label) {
  assertOnlyKeys(item, allowed, label);
  if (item.id != null) assertProtocolToken(item.id, `${label} id`, 512);
  if (item.call_id != null) assertProtocolToken(item.call_id, `${label} call id`, 512);
  sanitizeInternalMessageMetadata(item);
}

function sanitizeInternalMessageMetadata(item) {
  const key = "internal_chat_message_metadata_passthrough";
  if (item[key] == null) return;
  assertPlainObject(item[key], "internal chat metadata");
  assertOnlyKeys(item[key], new Set(["turn_id"]), "internal chat metadata");
  if (item[key].turn_id == null) {
    delete item[key];
    return;
  }
  assertProtocolToken(item[key].turn_id, "internal turn id", 256);
}

function collectRequiredString(object, key, slots, path) {
  if (typeof object?.[key] !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      `PrivacyAI blocked Codex data without a string ${key}.`
    );
  }
  slots.push({ path: [...path, key], value: object[key] });
}

function collectOptionalString(object, key, slots, path) {
  if (object?.[key] == null) return;
  if (typeof object[key] !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      `PrivacyAI blocked Codex data with a non-string ${key}.`
    );
  }
  slots.push({ path: [...path, key], value: object[key] });
}

function validateStatus(value, label, required) {
  if (value == null && !required) return;
  if (!new Set(["completed", "in_progress", "incomplete"]).has(value)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      `PrivacyAI blocked an unsupported Codex ${label}.`
    );
  }
}

function requireProtocolIdentity(value, label) {
  assertProtocolToken(value, label, 512);
}

function validateOpaqueProviderValue(value, label, required = false) {
  if (value == null && !required) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16 * 1024 * 1024 ||
    /[\r\n\0]/.test(value)
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      `PrivacyAI blocked malformed Codex ${label}.`
    );
  }
}

function restoreContentItems(content, sessionMap) {
  if (!Array.isArray(content)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_CONTENT",
      "PrivacyAI blocked non-array Codex response content."
    );
  }
  for (const entry of content) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_CONTENT",
        "PrivacyAI blocked malformed Codex response content."
      );
    }
    if (new Set(["input_image", "output_image", "input_file", "computer_screenshot"]).has(entry.type)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_CONTENT",
        `PrivacyAI blocked Codex media response content type: ${entry.type}`
      );
    }
    if (!new Set(["input_text", "output_text"]).has(entry.type) || typeof entry.text !== "string") {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_CONTENT",
        `PrivacyAI blocked unsupported Codex response content type: ${safeResponseItemType(entry.type)}`
      );
    }
    entry.text = restoreValue(entry.text, sessionMap);
  }
}

function restoreReasoningEntries(entries, sessionMap) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (typeof entry?.text === "string") entry.text = restoreValue(entry.text, sessionMap);
  }
}

function restoreOutputPayload(output, sessionMap) {
  if (typeof output === "string") return restoreValue(output, sessionMap);
  if (Array.isArray(output)) {
    restoreContentItems(output, sessionMap);
    return output;
  }
  if (output && typeof output === "object") {
    if (typeof output.content === "string") output.content = restoreValue(output.content, sessionMap);
    if (Array.isArray(output.content_items)) restoreContentItems(output.content_items, sessionMap);
  }
  return output;
}

function restoreMaybeString(value, sessionMap) {
  return typeof value === "string" ? restoreValue(value, sessionMap) : value;
}

function slot(root, path) {
  return { path, value: getAtPath(root, path) };
}

function collectStringField(object, key, slots, path) {
  if (typeof object?.[key] === "string") slots.push({ path: [...path, key], value: object[key] });
}

function collectJsonStringField(object, key, slots, path) {
  if (typeof object?.[key] !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_ARGUMENTS",
      "PrivacyAI blocked non-string JSON in Codex function-call arguments."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(object[key]);
  } catch {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_ARGUMENTS",
      "PrivacyAI blocked invalid JSON in Codex function-call arguments."
    );
  }
  slots.push({ path: [...path, key], value: parsed, jsonString: true });
}

function restoreJsonString(value, sessionMap) {
  if (typeof value !== "string") return value;
  try {
    return JSON.stringify(restoreValue(JSON.parse(value), sessionMap));
  } catch {
    const firstCode = value.length > 0 ? value.codePointAt(0) : -1;
    const lastCode = value.length > 0 ? value.codePointAt(value.length - 1) : -1;
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_ARGUMENTS",
      `PrivacyAI blocked invalid JSON in a Codex function-call response (length=${value.length}, first=${firstCode}, last=${lastCode}).`
    );
  }
}

function getAtPath(root, path) {
  return path.reduce((value, key) => value[key], root);
}

function setAtPath(root, path, value) {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], root);
  parent[path.at(-1)] = value;
}

function renameKeyAtPath(root, parentPath, oldKey, newKey) {
  if (typeof newKey !== "string" || newKey.length === 0) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_SCHEMA_KEY",
      "PrivacyAI blocked an invalid sanitized JSON Schema key."
    );
  }
  const parent = getAtPath(root, parentPath);
  if (!parent || typeof parent !== "object" || Array.isArray(parent) || !Object.hasOwn(parent, oldKey)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_SCHEMA_KEY",
      "PrivacyAI could not safely locate a JSON Schema key after sanitization."
    );
  }
  if (oldKey === newKey) return;
  if (Object.hasOwn(parent, newKey)) {
    throw gatewayError(
      "PRIVACYAI_TRANSFORM_KEY_COLLISION",
      "PrivacyAI blocked a JSON Schema key collision after sanitization."
    );
  }
  const value = parent[oldKey];
  delete parent[oldKey];
  Object.defineProperty(parent, newKey, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

function modelVisibleCacheKey(value, sessionMapScope) {
  return createHash("sha256")
    .update(String(sessionMapScope))
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function sessionMapCacheScope(sessionMap) {
  const entries = Object.entries(sessionMap || {}).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function hashCacheKey(value) {
  return `privacyai:${createHash("sha256").update(value).digest("hex")}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeResponseItemType(value) {
  const text = String(value || "missing");
  return /^[A-Za-z0-9._-]{1,120}$/.test(text) ? text : "invalid";
}

function gatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
