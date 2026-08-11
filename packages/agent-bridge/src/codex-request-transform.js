import { createHash } from "node:crypto";

import {
  assertNoProtectedOriginalsInValue,
  parsePrivacyPlaceholder,
  normalizeSessionMap,
  rebaseSessionAdditions,
  restoreText,
  restoreValue,
  sanitizeKnownValue
} from "@privacy-ai/sdk";
import { gatewayError } from "./gateway-error.js";
import {
  collectCodexJsonSchema,
  finalizeCodexJsonSchemaTrace
} from "./codex-json-schema-policy.js";
import { sanitizeModelVisibleArtifacts } from "./model-visible-artifacts.js";
import { deterministicProviderIdentifier } from "./privacy-identity.js";
import { assertImmutableToolString } from "./immutable-tool-structure.js";

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

const PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;
const PROVIDER_IDENTIFIER_ALIAS_MAX_LENGTH = 64;
const DEFAULT_MAX_IMAGES_PER_REQUEST = 8;
const SAFE_TOOL_ARGUMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UNSAFE_TOOL_ARGUMENT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const LEGACY_CODEX_PROTOCOL_KEYS = new Map([
  ["wait", new Set(["cell_id", "yield_time_ms", "max_tokens"])]
]);

export async function sanitizeCodexRequestBody(body, options = {}) {
  throwIfAborted(options.signal);
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
    transformed.prompt_cache_key = hashCacheKey(
      transformed.prompt_cache_key,
      options.identityRoot
    );
  }

  const validatedProtocolStrings = collectValidatedCodexProtocolStrings(transformed);
  const initialSessionMap = pruneCodexArgumentKeyMappings(
    transformed,
    options.sessionMap || {}
  );
  const immutableSessionMap = filterCodexClassifierProtocolCollisions(
    initialSessionMap,
    validatedProtocolStrings
  );
  const { slots, schemaTraces } = collectModelVisibleSlots(transformed, immutableSessionMap);
  const imageSlots = collectImageSlots(transformed.input, ["input"]);
  const maxImages = Number(options.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST);
  if (!Number.isSafeInteger(maxImages) || maxImages <= 0) {
    throw new TypeError("maxImagesPerRequest must be a positive safe integer.");
  }
  if (imageSlots.length > maxImages) {
    throw gatewayError(
      "PRIVACYAI_CODEX_TOO_MANY_IMAGES",
      `PrivacyAI blocked a Codex request with more than ${maxImages} images.`
    );
  }

  const policyFingerprint = String(options.policyFingerprint || "privacyai-agent-strict-v2");
  const imageSessionMap = { ...initialSessionMap };
  const imageSessionMapAdditions = {};

  if (imageSlots.length > 0) {
    const sanitizeImage = typeof options.imageSanitizer === "function"
      ? options.imageSanitizer
      : options.imageSanitizer?.sanitize?.bind(options.imageSanitizer);
    if (typeof sanitizeImage !== "function") {
      throw gatewayError(
        "PRIVACYAI_CODEX_IMAGE_SANITIZER_REQUIRED",
        "PrivacyAI blocked image content because no local image sanitizer is available."
      );
    }
    for (let imageIndex = 0; imageIndex < imageSlots.length; imageIndex += 1) {
      throwIfAborted(options.signal);
      const entry = imageSlots[imageIndex];
      const result = await sanitizeImage(entry.value, {
        sanitizer: options.sanitizer,
        identity: options.identity,
        sessionMap: imageSessionMap,
        maxContextChars: options.maxContextChars,
        maxContextTokens: options.maxContextTokens,
        tokenCounter: options.tokenCounter,
        signal: options.signal,
        onBatchComplete: options.onBatchComplete
      });
      if (!result || typeof result.imageUrl !== "string") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_SANITIZED_IMAGE",
          "PrivacyAI blocked the Codex request because image sanitization returned an invalid result."
        );
      }
      mergeDetectedMappings(imageSessionMap, imageSessionMapAdditions, result.sessionMapAdditions);
      setAtPath(transformed, entry.path, result.imageUrl);
      if (typeof options.onArtifactComplete === "function") {
        await options.onArtifactComplete({
          artifactIndex: imageIndex,
          artifactCount: imageSlots.length,
          artifactKey: slotIdentity(entry),
          artifactType: "image",
          slotCount: 1
        });
      }
    }
  }

  const artifactResult = await sanitizeModelVisibleArtifacts(slots.map(entry => ({
    value: entry.value,
    slotKey: slotIdentity(entry),
    artifactType: artifactTypeForSlot(entry),
    artifactKey: artifactIdentityForSlot(entry),
    mutable: entry.mutable,
    sanitizeObjectKeys: entry.sanitizeObjectKeys,
    objectKeyPolicyKey: entry.objectKeyPolicyKey,
    label: entry.label
  })), {
    sanitizer: options.sanitizer,
    identity: options.identity,
    identityRoot: options.identityRoot,
    sessionMap: imageSessionMap,
    cache: createProtocolKeyVerificationCache(options.cache, transformed),
    policyFingerprint,
    maxContextChars: options.maxContextChars,
    maxContextTokens: options.maxContextTokens,
    tokenCounter: options.tokenCounter,
    normalizeClassifierResult: createProtocolKeyClassifierNormalizer(transformed),
    artifactTypePrefix: "codex",
    signal: options.signal,
    onBatchComplete: options.onBatchComplete,
    onArtifactComplete: options.onArtifactComplete,
    invalidShapeError: () => gatewayError(
      "PRIVACYAI_CODEX_INVALID_SANITIZED_REQUEST",
      "PrivacyAI blocked the Codex request because sanitization changed its model-visible shape."
    )
  });
  const completeMap = artifactResult.sessionMap;
  const sessionMapAdditions = {
    ...imageSessionMapAdditions,
    ...artifactResult.sessionMapAdditions
  };
  const resolved = artifactResult.values;

  const providerIdentifierMappings = buildProviderIdentifierMappings(
    slots,
    completeMap,
    sessionMapAdditions,
    initialSessionMap,
    options.identity
  );

  slots.forEach((entry, index) => {
    resolved[index] = entry.providerIdentifier
      ? sanitizeProviderIdentifier(entry.value, providerIdentifierMappings)
      : sanitizeKnownValue(entry.value, completeMap);
  });

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

  const finalizedSchemaTraces = schemaTraces.map(trace => finalizeCodexJsonSchemaTrace(
    getAtPath(transformed, trace.path),
    trace,
    resolved.map((value, index) => ({
      entry: slots[index],
      value,
      cacheHit: artifactResult.cacheHitSlotKeys.has(slotIdentity(slots[index]))
    }))
  ));
  if (typeof options.onSchemaTrace === "function") {
    for (const trace of finalizedSchemaTraces) await options.onSchemaTrace(trace);
  }

  assertNoProtectedOriginalsInValue(resolved, completeMap);

  return {
    body: transformed,
    sessionMapAdditions,
    cacheWrites: artifactResult.cacheWrites,
    itemRecords: artifactResult.itemRecords,
    schemaTraces: finalizedSchemaTraces,
    policyFingerprint,
    metrics: artifactResult.metrics,
    sessionKey: codexSessionKey(body, options.fallbackSessionId, options.headers)
  };
}

/**
 * Build persistent verification records for a request whose complete
 * model-visible content has already been classified as one atomic startup
 * manifest. This warms the exact per-item gateway cache before the user's real
 * Codex process starts, without asking the local model to classify the same
 * rendered prompt a second time.
 */
export function buildCodexRequestVerificationSeed(body, sessionMap = {}, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw gatewayError("PRIVACYAI_CODEX_INVALID_REQUEST", "Codex provider request body must be a JSON object.");
  }
  if (!Array.isArray(body.input)) {
    throw gatewayError("PRIVACYAI_CODEX_INVALID_REQUEST", "Codex provider request input must be an array.");
  }

  const transformed = deepClone(body);
  const recoverableProtocolKeys = collectLegacyCodexProtocolKeys(transformed);
  const validatedProtocolStrings = collectValidatedCodexProtocolStrings(transformed);
  const completeMap = pruneCodexArgumentKeyMappings(transformed, sessionMap);
  const immutableSessionMap = filterCodexClassifierProtocolCollisions(
    completeMap,
    validatedProtocolStrings
  );
  const { slots } = collectModelVisibleSlots(transformed, immutableSessionMap);
  const policyFingerprint = String(options.policyFingerprint || "privacyai-agent-strict-v2");
  const cacheWrites = [];
  const itemRecords = [];

  for (const entry of slots) {
    const artifactType = artifactTypeForSlot(entry);
    const contentHash = modelVisibleContentHash(entry.value);
    const cacheKey = modelVisibleCacheKey(
      entry.value,
      artifactType,
      policyFingerprint,
      entry.objectKeyPolicyKey ||
        (entry.sanitizeObjectKeys === false ? "values-only" : "keys-and-values"),
      options.identityRoot
    );
    cacheWrites.push([cacheKey, {
      cacheKey,
      contentHash,
      artifactType,
      policyFingerprint,
      sessionMapAdditions: filterRecoverableProtocolMappings(
        relevantSessionMap(
          entry.value,
          completeMap,
          entry.sanitizeObjectKeys
        ),
        recoverableProtocolKeys
      ),
      identityKeyId: options.identityRoot?.keyId || ""
    }]);
    itemRecords.push({
      slotKey: slotIdentity(entry),
      cacheKey,
      contentHash,
      artifactType
    });
  }

  return { cacheWrites, itemRecords, policyFingerprint };
}

function collectImageSlots(items, basePath) {
  const output = [];
  items.forEach((item, index) => {
    const itemPath = [...basePath, index];
    if (item.type === "message") {
      collectImageContentItems(item.content, [...itemPath, "content"], output);
      return;
    }
    if (new Set(["function_call_output", "custom_tool_call_output"]).has(item.type)) {
      collectImageOutputPayload(item.output, [...itemPath, "output"], output);
    }
  });
  return output;
}

function collectImageContentItems(content, path, output) {
  if (!Array.isArray(content)) return;
  content.forEach((entry, index) => {
    if (entry?.type === "input_image" && typeof entry.image_url === "string") {
      output.push({ path: [...path, index, "image_url"], value: entry.image_url, media: true });
    }
  });
}

function collectImageOutputPayload(outputValue, path, output) {
  if (Array.isArray(outputValue)) {
    collectImageContentItems(outputValue, path, output);
    return;
  }
  if (Array.isArray(outputValue?.content_items)) {
    collectImageContentItems(outputValue.content_items, [...path, "content_items"], output);
  }
}

function collectModelVisibleSlots(transformed, sessionMap = {}, options = {}) {
  const slots = [];
  const schemaTraces = [];
  const context = { sessionMap, schemaTraces, onImmutableString: options.onImmutableString };
  if (typeof transformed.instructions === "string") {
    slots.push(slot(transformed, ["instructions"]));
  }
  collectResponseItems(transformed.input, slots, ["input"], context);
  if (transformed.tools != null) collectToolDefinitions(transformed.tools, slots, ["tools"], context);
  if (transformed.text?.format?.schema != null) {
    const schemaPath = ["text", "format", "schema"];
    collectSchemaSlots(
      transformed.text.format.schema,
      slots,
      schemaPath,
      sessionMap,
      schemaTraces,
      options.onImmutableString
    );
  }
  return { slots, schemaTraces };
}

function collectValidatedCodexProtocolStrings(body) {
  const protocolStrings = new Set();
  collectModelVisibleSlots(body, {}, {
    onImmutableString(value) {
      protocolStrings.add(value.toLocaleLowerCase("en-US"));
    }
  });
  return protocolStrings;
}

function filterCodexClassifierProtocolCollisions(sessionMap, protocolStrings) {
  if (!(protocolStrings instanceof Set) || protocolStrings.size === 0) {
    return { ...(sessionMap || {}) };
  }
  return Object.fromEntries(Object.entries(sessionMap || {}).filter(([placeholder, original]) =>
    parsePrivacyPlaceholder(placeholder)?.category !== "SENSITIVE" ||
    !mappingCollidesWithCodexProtocol(original, protocolStrings)
  ));
}

function mappingCollidesWithCodexProtocol(original, protocolStrings) {
  if (typeof original !== "string" || original.length === 0) return false;
  const folded = original.toLocaleLowerCase("en-US");
  for (const value of protocolStrings) {
    if (value.includes(folded)) return true;
  }
  return false;
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

/**
 * Older gateways could persist false-positive mappings for immutable Codex
 * protocol keys such as wait.cell_id. Migrate only allowlisted stock-Codex
 * fields that are both present in the matching tool schema and observed in a
 * historical call. Arbitrary application schema identifiers remain protected.
 */
export function pruneCodexArgumentKeyMappings(body, sessionMap = {}) {
  const normalized = normalizeSessionMap(sessionMap);
  const recoverable = collectLegacyCodexProtocolKeys(body);
  if (recoverable.size === 0) return normalized;
  return filterRecoverableProtocolMappings(normalized, recoverable);
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
      validateWebSearchCallItem(item);
      break;
    case "image_generation_call":
      validateImageGenerationCallItem(item);
      break;
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

function collectResponseItems(items, slots, basePath, context = {}) {
  items.forEach((item, index) => collectResponseItem(item, slots, [...basePath, index], context));
}

function collectResponseItem(item, slots, path, context = {}) {
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
      collectRequiredProviderIdentifier(item, "name", slots, path);
      collectOptionalProviderIdentifier(item, "namespace", slots, path);
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
      collectRequiredProviderIdentifier(item, "name", slots, path);
      collectOptionalProviderIdentifier(item, "namespace", slots, path);
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
      collectOptionalProviderIdentifier(item, "name", slots, path);
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
      collectToolDefinitions(item.tools, slots, [...path, "tools"], context);
      return;
    case "additional_tools":
      validateResponseItemShape(item, new Set(["type", "id", "role", "tools"]), "additional_tools");
      if (!new Set(["assistant", "developer", "user"]).has(item.role)) {
        throw gatewayError("PRIVACYAI_CODEX_UNSUPPORTED_INPUT", "PrivacyAI blocked unsupported additional-tools role.");
      }
      collectToolDefinitions(item.tools, slots, [...path, "tools"], context);
      return;
    case "web_search_call":
      validateWebSearchCallItem(item);
      return;
    case "image_generation_call":
      validateImageGenerationCallItem(item);
      return;
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
    if (entry.type === "input_image") {
      assertOnlyKeys(entry, new Set(["type", "image_url", "detail"]), "message image content");
      if (typeof entry.image_url !== "string") {
        throw gatewayError("PRIVACYAI_CODEX_INVALID_IMAGE", "PrivacyAI blocked an image without a string data URL.");
      }
      if (entry.detail != null && !new Set(["auto", "low", "high"]).has(entry.detail)) {
        throw gatewayError("PRIVACYAI_CODEX_INVALID_IMAGE", "PrivacyAI blocked an image with unsupported detail.");
      }
      return;
    }
    if (new Set(["output_image", "input_file", "computer_screenshot"]).has(entry.type)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_UNSUPPORTED_MEDIA",
        `PrivacyAI does not support Codex media content type: ${entry.type}`
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
      assertOnlyKeys(entry, new Set(["type", "image_url", "detail"]), "tool output image");
      if (typeof entry.image_url !== "string") {
        throw gatewayError("PRIVACYAI_CODEX_INVALID_IMAGE", "PrivacyAI blocked a tool image without a string data URL.");
      }
      if (entry.detail != null && !new Set(["auto", "low", "high"]).has(entry.detail)) {
        throw gatewayError("PRIVACYAI_CODEX_INVALID_IMAGE", "PrivacyAI blocked a tool image with unsupported detail.");
      }
      return;
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

function collectToolDefinitions(value, slots, path, context = {}) {
  if (value == null) return;
  if (!Array.isArray(value)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
      "PrivacyAI blocked a non-array Codex tool definition list."
    );
  }
  value.forEach((tool, index) => collectToolDefinition(tool, slots, [...path, index], { ...context }));
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
      collectRequiredProviderIdentifier(tool, "name", slots, path);
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
      collectSchemaSlots(
        tool.parameters,
        slots,
        [...path, "parameters"],
        options.sessionMap,
        options.schemaTraces,
        options.onImmutableString
      );
      return;
    case "namespace":
      if (options.nested) {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a nested Codex tool namespace."
        );
      }
      assertOnlyKeys(tool, new Set(["type", "name", "description", "tools"]), "tool namespace");
      collectRequiredProviderIdentifier(tool, "name", slots, path);
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
        collectToolDefinition(child, slots, [...path, "tools", index], { ...options, nested: true });
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
      collectSchemaSlots(
        tool.parameters,
        slots,
        [...path, "parameters"],
        options.sessionMap,
        options.schemaTraces,
        options.onImmutableString
      );
      return;
    case "custom":
      if (options.nested) {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI blocked a nested Codex custom tool."
        );
      }
      assertOnlyKeys(tool, new Set(["type", "name", "description", "format"]), "custom tool");
      collectRequiredProviderIdentifier(tool, "name", slots, path);
      collectRequiredString(tool, "description", slots, path);
      assertPlainObject(tool.format, "custom tool format");
      assertOnlyKeys(tool.format, new Set(["type", "syntax", "definition"]), "custom tool format");
      if (tool.format.type !== "grammar" || tool.format.syntax !== "lark") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
          "PrivacyAI supports only Codex Lark grammar custom tools."
        );
      }
      validateImmutableCodexToolStructure(
        tool.format.definition,
        options.sessionMap,
        "custom Lark grammar"
      );
      options.onImmutableString?.(tool.format.definition);
      return;
    case "web_search":
      validateWebSearchToolDefinition(tool);
      return;
    case "image_generation":
      validateImageGenerationToolDefinition(tool);
      return;
    default:
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
        `PrivacyAI blocked unsupported Codex tool type: ${safeResponseItemType(tool.type)}`
      );
  }
}

function validateWebSearchToolDefinition(tool) {
  assertOnlyKeys(
    tool,
    new Set([
      "type",
      "external_web_access",
      "search_content_types",
      "search_context_size",
      "filters",
      "user_location"
    ]),
    "web search tool"
  );
  if (tool.external_web_access != null && typeof tool.external_web_access !== "boolean") {
    throw invalidProviderToolDefinition("web search external_web_access");
  }
  if (tool.search_content_types != null) {
    if (
      !Array.isArray(tool.search_content_types) ||
      tool.search_content_types.some(value => !new Set(["text", "image"]).has(value)) ||
      new Set(tool.search_content_types).size !== tool.search_content_types.length
    ) {
      throw invalidProviderToolDefinition("web search content types");
    }
  }
  if (
    tool.search_context_size != null &&
    !new Set(["low", "medium", "high"]).has(tool.search_context_size)
  ) {
    throw invalidProviderToolDefinition("web search context size");
  }
  if (tool.filters != null) {
    assertOnlyKeys(tool.filters, new Set(["allowed_domains"]), "web search filters");
    if (
      !Array.isArray(tool.filters.allowed_domains) ||
      tool.filters.allowed_domains.some(value => typeof value !== "string" || value.length === 0 || value.length > 2048)
    ) {
      throw invalidProviderToolDefinition("web search allowed domains");
    }
  }
  if (tool.user_location != null) {
    assertOnlyKeys(
      tool.user_location,
      new Set(["type", "city", "country", "region", "timezone"]),
      "web search user location"
    );
    if (tool.user_location.type !== "approximate") {
      throw invalidProviderToolDefinition("web search user location type");
    }
    for (const key of ["city", "country", "region", "timezone"]) {
      if (
        tool.user_location[key] != null &&
        (typeof tool.user_location[key] !== "string" || tool.user_location[key].length > 512)
      ) {
        throw invalidProviderToolDefinition(`web search user location ${key}`);
      }
    }
  }
}

function validateImageGenerationToolDefinition(tool) {
  assertOnlyKeys(
    tool,
    new Set([
      "type",
      "output_format",
      "background",
      "input_fidelity",
      "model",
      "moderation",
      "output_compression",
      "partial_images",
      "quality",
      "size"
    ]),
    "image generation tool"
  );
  for (const [key, allowed] of [
    ["output_format", new Set(["png", "jpeg", "webp"])],
    ["background", new Set(["auto", "opaque", "transparent"])],
    ["input_fidelity", new Set(["low", "high"])],
    ["moderation", new Set(["auto"])],
    ["quality", new Set(["auto", "low", "medium", "high"])],
    ["size", new Set(["auto", "1024x1024", "1024x1536", "1536x1024"])]
  ]) {
    if (tool[key] != null && !allowed.has(tool[key])) {
      throw invalidProviderToolDefinition(`image generation ${key}`);
    }
  }
  if (tool.model != null) assertProtocolToken(tool.model, "image generation model", 160);
  if (
    tool.output_compression != null &&
    (!Number.isSafeInteger(tool.output_compression) || tool.output_compression < 0 || tool.output_compression > 100)
  ) {
    throw invalidProviderToolDefinition("image generation output compression");
  }
  if (
    tool.partial_images != null &&
    (!Number.isSafeInteger(tool.partial_images) || tool.partial_images < 0 || tool.partial_images > 3)
  ) {
    throw invalidProviderToolDefinition("image generation partial images");
  }
}

function invalidProviderToolDefinition(label) {
  return gatewayError(
    "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
    `PrivacyAI blocked an invalid Codex ${label}.`
  );
}

function collectSchemaSlots(
  value,
  slots,
  path,
  sessionMap,
  schemaTraces,
  onImmutableString
) {
  const collected = collectCodexJsonSchema(value, path, sessionMap, { onImmutableString });
  collected.trace.path = path;
  slots.push(...collected.slots);
  schemaTraces?.push(collected.trace);
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

function validateImmutableCodexToolStructure(value, sessionMap, label) {
  assertImmutableToolString(value, sessionMap, {
    protectedValueError: () => gatewayError(
      "PRIVACYAI_CODEX_TOOL_STRUCTURE_IMMUTABLE_PROTECTED_VALUE",
      `PrivacyAI blocked protected data in immutable Codex ${label}.`
    ),
    invalidValueError: () => gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
      `PrivacyAI blocked an invalid immutable Codex ${label}.`
    )
  });
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

function collectRequiredProviderIdentifier(object, key, slots, path) {
  if (typeof object?.[key] !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      `PrivacyAI blocked Codex data without a string ${key}.`
    );
  }
  assertProviderIdentifier(object[key], key);
  slots.push({ path: [...path, key], value: object[key], providerIdentifier: true });
}

function collectOptionalProviderIdentifier(object, key, slots, path) {
  if (object?.[key] == null) return;
  if (typeof object[key] !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      `PrivacyAI blocked Codex data with a non-string ${key}.`
    );
  }
  assertProviderIdentifier(object[key], key);
  slots.push({ path: [...path, key], value: object[key], providerIdentifier: true });
}

function assertProviderIdentifier(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !PROVIDER_IDENTIFIER_PATTERN.test(value)
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_TOOL_IDENTIFIER",
      `PrivacyAI blocked an invalid Codex provider identifier in ${label}.`
    );
  }
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

function validateWebSearchCallItem(item) {
  validateResponseItemShape(
    item,
    new Set(["type", "id", "status", "action", "internal_chat_message_metadata_passthrough"]),
    "web search call"
  );
  if (!new Set(["completed", "searching", "in_progress", "incomplete", "failed"]).has(item.status)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      "PrivacyAI blocked an unsupported Codex web search status."
    );
  }
  if (item.action == null) return;
  assertOnlyKeys(
    item.action,
    new Set(["type", "query", "queries", "url", "pattern", "sources"]),
    "web search action"
  );
  if (!new Set(["search", "open_page", "find_in_page"]).has(item.action.type)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      "PrivacyAI blocked an unsupported Codex web search action."
    );
  }
  for (const key of ["query", "url", "pattern"]) {
    if (item.action[key] != null && typeof item.action[key] !== "string") {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
        `PrivacyAI blocked a non-string Codex web search ${key}.`
      );
    }
  }
  if (
    item.action.queries != null &&
    (!Array.isArray(item.action.queries) || item.action.queries.some(value => typeof value !== "string"))
  ) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      "PrivacyAI blocked malformed Codex web search queries."
    );
  }
  if (item.action.sources != null) {
    if (!Array.isArray(item.action.sources)) {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
        "PrivacyAI blocked malformed Codex web search sources."
      );
    }
    for (const source of item.action.sources) {
      assertOnlyKeys(source, new Set(["type", "url", "name"]), "web search source");
      if (!new Set(["url", "api"]).has(source.type)) {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
          "PrivacyAI blocked an unsupported Codex web search source."
        );
      }
      if (source.url != null && typeof source.url !== "string") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
          "PrivacyAI blocked a non-string Codex web search source URL."
        );
      }
      if (source.name != null && typeof source.name !== "string") {
        throw gatewayError(
          "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
          "PrivacyAI blocked a non-string Codex web search source name."
        );
      }
    }
  }
}

function validateImageGenerationCallItem(item) {
  validateResponseItemShape(
    item,
    new Set(["type", "id", "status", "result", "internal_chat_message_metadata_passthrough"]),
    "image generation call"
  );
  if (!new Set(["completed", "generating", "in_progress", "incomplete", "failed"]).has(item.status)) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      "PrivacyAI blocked an unsupported Codex image generation status."
    );
  }
  if (item.result != null && typeof item.result !== "string") {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_REQUEST_SHAPE",
      "PrivacyAI blocked a non-string Codex image generation result."
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

function collectLegacyCodexProtocolKeys(body) {
  const declaredByTool = new Map();
  collectLegacyToolSchemaKeys(body?.tools, declaredByTool);
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.type === "additional_tools" || item?.type === "tool_search_output") {
        collectLegacyToolSchemaKeys(item.tools, declaredByTool);
      }
    }
  }

  const observedByTool = new Map();
  for (const item of body?.input || []) {
    if (item?.type !== "function_call" || typeof item.name !== "string" || typeof item.arguments !== "string") {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(item.arguments);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const observed = observedByTool.get(item.name) || new Set();
    for (const key of Object.keys(parsed)) observed.add(key);
    observedByTool.set(item.name, observed);
  }

  const output = new Set();
  for (const [toolName, allowlist] of LEGACY_CODEX_PROTOCOL_KEYS) {
    const declared = declaredByTool.get(toolName);
    const observed = observedByTool.get(toolName);
    if (!declared || !observed) continue;
    for (const key of allowlist) {
      if (declared.has(key) && observed.has(key)) output.add(key.toLocaleLowerCase("en-US"));
    }
  }
  return output;
}

function collectLegacyToolSchemaKeys(tools, output) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (tool?.type === "namespace") {
      collectLegacyToolSchemaKeys(tool.tools, output);
      continue;
    }
    if (tool?.type !== "function" || typeof tool.name !== "string") continue;
    const allowlist = LEGACY_CODEX_PROTOCOL_KEYS.get(tool.name);
    if (!allowlist) continue;
    const properties = tool.parameters?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
    const declared = output.get(tool.name) || new Set();
    for (const key of Object.keys(properties)) {
      if (allowlist.has(key)) declared.add(key);
    }
    output.set(tool.name, declared);
  }
}

function collectRecoverableToolSchemaKeys(body) {
  const candidates = new Map();
  collectToolListSchemaKeys(body?.tools, candidates);
  if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (item?.type === "additional_tools" || item?.type === "tool_search_output") {
        collectToolListSchemaKeys(item.tools, candidates);
      }
    }
  }
  return new Set([...candidates.entries()]
    .filter(([, original]) => isRecoverableProtocolArgumentKey(original))
    .map(([folded]) => folded));
}

function collectToolListSchemaKeys(tools, output) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (tool?.type === "function" || tool?.type === "tool_search") {
      collectSchemaPropertyKeys(tool.parameters, output);
    } else if (tool?.type === "namespace") {
      collectToolListSchemaKeys(tool.tools, output);
    }
  }
}

function collectSchemaPropertyKeys(schema, output) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const key of Object.keys(schema.properties)) {
      const folded = key.toLocaleLowerCase("en-US");
      if (!output.has(folded)) output.set(folded, key);
    }
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      value.forEach(entry => collectSchemaPropertyKeys(entry, output));
    } else {
      collectSchemaPropertyKeys(value, output);
    }
  }
}

function filterRecoverableProtocolMappings(sessionMap, recoverable) {
  if (!(recoverable instanceof Set) || recoverable.size === 0) {
    return { ...(sessionMap || {}) };
  }
  return Object.fromEntries(Object.entries(sessionMap || {}).filter(([, original]) =>
    typeof original !== "string" ||
    !recoverable.has(original.toLocaleLowerCase("en-US"))
  ));
}

function createProtocolKeyVerificationCache(cache, body) {
  if (!cache || typeof cache.get !== "function") return cache;
  const recoverable = collectLegacyCodexProtocolKeys(body);
  if (recoverable.size === 0) return cache;
  return {
    get(cacheKey, policyFingerprint) {
      const verification = cache.get(cacheKey, policyFingerprint);
      if (!verification?.sessionMapAdditions) return verification;
      return {
        ...verification,
        sessionMapAdditions: filterRecoverableProtocolMappings(
          verification.sessionMapAdditions,
          recoverable
        )
      };
    }
  };
}

function createProtocolKeyClassifierNormalizer(body) {
  const recoverable = collectRecoverableToolSchemaKeys(body);
  if (recoverable.size === 0) return undefined;

  return ({ sanitizedPrompt, sessionMap }) => {
    const accepted = {};
    const rejected = {};
    for (const [placeholder, original] of Object.entries(sessionMap || {})) {
      if (
        typeof original === "string" &&
        recoverable.has(original.toLocaleLowerCase("en-US"))
      ) {
        rejected[placeholder] = original;
      } else {
        accepted[placeholder] = original;
      }
    }
    return {
      sanitizedPrompt: Object.keys(rejected).length > 0
        ? restoreText(sanitizedPrompt, rejected)
        : sanitizedPrompt,
      sessionMap: accepted
    };
  };
}

function codexArgumentKeyPolicy(toolName) {
  const trusted = LEGACY_CODEX_PROTOCOL_KEYS.get(String(toolName || ""));
  return {
    sanitizeObjectKeys: ({ key }) =>
      !(trusted?.has(key) || isRecoverableProtocolArgumentKey(key)),
    objectKeyPolicyKey: trusted
      ? `codex-argument-keys-v2:${String(toolName)}`
      : "codex-argument-keys-v2:generic"
  };
}

function isRecoverableProtocolArgumentKey(value) {
  const text = String(value);
  const folded = text.toLocaleLowerCase("en-US");
  if (!SAFE_TOOL_ARGUMENT_KEY_PATTERN.test(text) || UNSAFE_TOOL_ARGUMENT_KEYS.has(folded)) {
    return false;
  }
  try {
    assertImmutableToolString(text, {}, {
      protectedValueError: () => new Error("protected"),
      invalidValueError: () => new Error("invalid")
    });
    return true;
  } catch {
    return false;
  }
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
  const keyPolicy = codexArgumentKeyPolicy(object.name);
  slots.push({
    path: [...path, key],
    value: parsed,
    jsonString: true,
    ...keyPolicy
  });
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

function modelVisibleCacheKey(
  value,
  artifactType,
  policyFingerprint,
  objectKeyPolicyKey = "keys-and-values",
  identityRoot
) {
  const material = {
    version: 1,
    policyFingerprint: String(policyFingerprint),
    artifactType: String(artifactType),
    objectKeyPolicyKey: String(objectKeyPolicyKey),
    value
  };
  if (identityRoot?.digest) {
    return identityRoot.digest("cache:codex-model-visible", material);
  }
  return createHash("sha256")
    .update(String(policyFingerprint))
    .update("\0")
    .update(String(artifactType))
    .update("\0")
    .update(String(objectKeyPolicyKey))
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function modelVisibleContentHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function artifactIdentityForSlot(entry) {
  const path = entry.path || entry.parentPath || [];
  if (path[0] === "instructions") return "instructions";
  if (path[0] === "input" && Number.isSafeInteger(path[1])) return `input/${path[1]}`;
  if (path[0] === "tools" && Number.isSafeInteger(path[1])) return `tools/${path[1]}`;
  if (path[0] === "text") return "text/format/schema";
  return path.slice(0, 2).map(value => String(value)).join("/") || "request";
}

function artifactTypeForSlot(entry) {
  const path = entry.path || entry.parentPath || [];
  if (path[0] === "instructions") return "instructions";
  if (path.includes("output") || path.includes("content_items")) return "tool_output";
  if (path.includes("tools")) return "tool_definition";
  if (path.includes("schema") || path.includes("parameters")) return "json_schema";
  if (path.includes("summary") || path.includes("reasoning")) return "reasoning";
  if (path.includes("command") || path.includes("env")) return "tool_call";
  return entry.keyRename ? "structured_key" : "message_text";
}

function slotIdentity(entry) {
  const path = entry.path || [...(entry.parentPath || []), entry.oldKey || "key"];
  return path.map(value => String(value).replaceAll("/", "~1")).join("/");
}

function buildProviderIdentifierMappings(
  slots,
  completeMap,
  additions,
  initialSessionMap,
  identity
) {
  const identifiers = slots
    .filter(entry => entry.providerIdentifier === true)
    .map(entry => entry.value);
  if (identifiers.length === 0) return [];

  const relevantByOriginal = new Map();
  for (const [placeholder, original] of Object.entries(completeMap)) {
    if (typeof original !== "string" || original.length === 0) continue;
    if (!identifiers.some(identifier => includesIgnoreCase(identifier, original))) continue;
    const key = original.toLocaleLowerCase("en-US");
    const group = relevantByOriginal.get(key) || { original, placeholders: [] };
    group.placeholders.push(placeholder);
    relevantByOriginal.set(key, group);
  }

  const reservedIdentifiers = new Set(
    identifiers.map(identifier => identifier.toLocaleLowerCase("en-US"))
  );
  const assignedAliases = new Map();
  const mappings = [];

  for (const group of relevantByOriginal.values()) {
    let alias = group.placeholders.find(placeholder =>
      providerIdentifierAliasAvailable(
        placeholder,
        group.original,
        reservedIdentifiers,
        completeMap,
        assignedAliases
      )
    );
    if (!alias) {
      alias = allocateProviderIdentifierAlias(
        group.original,
        reservedIdentifiers,
        completeMap,
        assignedAliases,
        identity
      );
    }

    assignedAliases.set(alias.toLocaleLowerCase("en-US"), group.original);
    if (!Object.hasOwn(completeMap, alias)) completeMap[alias] = group.original;
    if (!Object.hasOwn(initialSessionMap, alias)) additions[alias] = group.original;
    mappings.push({ original: group.original, alias });
  }

  return mappings.sort((left, right) => right.original.length - left.original.length);
}

function sanitizeProviderIdentifier(value, mappings) {
  const matches = [];
  for (const { original, alias } of mappings) {
    const pattern = new RegExp(escapeRegExp(original), "gi");
    for (const match of value.matchAll(pattern)) {
      matches.push({ start: match.index, end: match.index + match[0].length, alias });
    }
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);

  let cursor = 0;
  let sanitized = "";
  for (const match of matches) {
    if (match.start < cursor) continue;
    sanitized += value.slice(cursor, match.start) + match.alias;
    cursor = match.end;
  }
  sanitized += value.slice(cursor);
  assertProviderIdentifier(sanitized, "provider-bound tool name");
  return sanitized;
}

function allocateProviderIdentifierAlias(
  original,
  reservedIdentifiers,
  completeMap,
  assignedAliases,
  identity
) {
  const occupied = new Set(reservedIdentifiers);
  for (const [placeholder, mappedOriginal] of Object.entries(completeMap)) {
    if (mappedOriginal !== original) {
      occupied.add(placeholder.toLocaleLowerCase("en-US"));
    }
  }
  for (const [alias, mappedOriginal] of assignedAliases) {
    if (mappedOriginal !== original) occupied.add(alias);
  }

  let candidate;
  try {
    candidate = deterministicProviderIdentifier(identity, "codex", original, occupied);
  } catch (error) {
    if (error?.code !== "PRIVACYAI_IDENTITY_COLLISION") throw error;
    throw gatewayError(
      "PRIVACYAI_CODEX_IDENTIFIER_ALIAS_EXHAUSTED",
      "PrivacyAI could not allocate a safe provider identifier alias.",
      error
    );
  }
  if (providerIdentifierAliasAvailable(
    candidate,
    original,
    reservedIdentifiers,
    completeMap,
    assignedAliases
  )) {
    return candidate;
  }
  throw gatewayError(
    "PRIVACYAI_CODEX_IDENTIFIER_ALIAS_EXHAUSTED",
    "PrivacyAI could not allocate a safe provider identifier alias."
  );
}

function providerIdentifierAliasAvailable(
  candidate,
  original,
  reservedIdentifiers,
  completeMap,
  assignedAliases
) {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > PROVIDER_IDENTIFIER_ALIAS_MAX_LENGTH ||
    !PROVIDER_IDENTIFIER_PATTERN.test(candidate)
  ) {
    return false;
  }
  const normalizedCandidate = candidate.toLocaleLowerCase("en-US");
  if (normalizedCandidate === original.toLocaleLowerCase("en-US")) return false;
  if (reservedIdentifiers.has(normalizedCandidate)) return false;

  for (const [placeholder, mappedOriginal] of Object.entries(completeMap)) {
    if (
      placeholder.toLocaleLowerCase("en-US") === normalizedCandidate &&
      mappedOriginal !== original
    ) {
      return false;
    }
  }
  const assignedOriginal = assignedAliases.get(normalizedCandidate);
  return assignedOriginal == null || assignedOriginal === original;
}

function includesIgnoreCase(value, fragment) {
  return value.toLocaleLowerCase("en-US").includes(fragment.toLocaleLowerCase("en-US"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeDetectedMappings(completeMap, aggregateAdditions, additions) {
  const normalized = Object.fromEntries(Object.entries(additions || {}).filter(
    ([placeholder, original]) =>
      typeof placeholder === "string" && placeholder.length > 0 &&
      typeof original === "string" && original.length > 0 &&
      placeholder !== original
  ));
  if (Object.keys(normalized).length === 0) return;
  const rebased = rebaseSessionAdditions(
    JSON.stringify(Object.keys(normalized)),
    normalized,
    completeMap
  );
  Object.assign(completeMap, rebased.sessionMap);
  Object.assign(aggregateAdditions, rebased.sessionMap);
}

function relevantSessionMap(value, sessionMap, includeObjectKeys = true) {
  const strings = [];
  collectStrings(value, strings, includeObjectKeys);
  const normalizedStrings = strings.map(text => text.toLocaleLowerCase("en-US"));
  return Object.fromEntries(Object.entries(sessionMap || {}).filter(([, original]) => {
    if (typeof original !== "string" || original.length === 0) return false;
    const target = original.toLocaleLowerCase("en-US");
    return normalizedStrings.some(text => text.includes(target));
  }));
}

function collectStrings(value, output, includeObjectKeys = true, path = []) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectStrings(entry, output, includeObjectKeys, [...path, index])
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = [...path, key];
    const includeKey = typeof includeObjectKeys === "function"
      ? includeObjectKeys({ path: keyPath, key }) !== false
      : includeObjectKeys !== false;
    if (includeKey) output.push(key);
    collectStrings(entry, output, includeObjectKeys, keyPath);
  }
}

function hashCacheKey(value, identityRoot) {
  const digest = identityRoot?.digest
    ? identityRoot.digest("provider-cache-key:codex", String(value))
    : createHash("sha256").update(value).digest("hex");
  return `privacyai:${digest}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeResponseItemType(value) {
  const text = String(value || "missing");
  return /^[A-Za-z0-9._-]{1,120}$/.test(text) ? text : "invalid";
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error("PrivacyAI stopped the Codex request because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_REQUEST_ABORTED";
  throw error;
}
