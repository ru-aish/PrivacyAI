import { normalizeSessionMap } from "@privacy-ai/sdk";
import {
  collectAgyToolSchema,
  finalizeAgyToolSchemaTrace
} from "./agy-tool-schema-policy.js";
import { sanitizeModelVisibleArtifacts } from "./model-visible-artifacts.js";
import { deterministicProviderIdentifier } from "./privacy-identity.js";

const OUTER_FIELDS = new Set([
  "project",
  "requestId",
  "request",
  "model",
  "userAgent",
  "requestType"
]);

const REQUEST_FIELDS = new Set([
  "contents",
  "systemInstruction",
  "tools",
  "toolConfig",
  "labels",
  "generationConfig",
  "safetySettings",
  "sessionId"
]);

const PART_FIELDS = new Set([
  "text",
  "functionCall",
  "functionResponse",
  "inlineData",
  "fileData",
  "thought",
  "thoughtSignature"
]);

const FUNCTION_CALL_FIELDS = new Set(["id", "name", "args"]);
const FUNCTION_RESPONSE_FIELDS = new Set(["id", "name", "response", "parts"]);
const INLINE_DATA_FIELDS = new Set(["mimeType", "data"]);
const FILE_DATA_FIELDS = new Set(["mimeType", "fileUri"]);
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp"
]);
const DEFAULT_MAX_IMAGES_PER_REQUEST = 8;
const MAX_ALIASES_PER_ORIGINAL = 8;
const FUNCTION_DECLARATION_FIELDS = new Set([
  "name",
  "description",
  "parameters",
  "parametersJsonSchema",
  "response",
  "responseJsonSchema"
]);

export async function sanitizeAgyRequestBody(body, options = {}) {
  validateAgyRequestBody(body, { functionNameMode: "native" });
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("AGY request transformation requires a sanitizer function.");
  }

  const transformed = structuredClone(body);
  const imageSlots = collectAgyImageSlots(transformed);
  const maxImages = Number(options.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST);
  if (!Number.isSafeInteger(maxImages) || maxImages <= 0) {
    throw new TypeError("maxImagesPerRequest must be a positive safe integer.");
  }
  if (imageSlots.length > maxImages) {
    throw agyError(
      "PRIVACYAI_AGY_TOO_MANY_IMAGES",
      `PrivacyAI blocked an AGY request with more than ${maxImages} images.`
    );
  }

  const completeSessionMap = normalizeSessionMap(options.sessionMap);
  const sessionMapAdditions = {};
  if (imageSlots.length > 0) {
    const sanitizeImage = typeof options.imageSanitizer === "function"
      ? options.imageSanitizer
      : options.imageSanitizer?.sanitize?.bind(options.imageSanitizer);
    if (typeof sanitizeImage !== "function") {
      throw agyError(
        "PRIVACYAI_AGY_IMAGE_SANITIZER_REQUIRED",
        "PrivacyAI blocked AGY image content because no local image sanitizer is available."
      );
    }

    try {
      for (let imageIndex = 0; imageIndex < imageSlots.length; imageIndex += 1) {
        throwIfAborted(options.signal);
        const entry = imageSlots[imageIndex];
        const result = await sanitizeImage(entry.value, {
          sanitizer: options.sanitizer,
          identity: options.identity,
          sessionMap: completeSessionMap,
          maxContextChars: options.maxContextChars,
          maxContextTokens: options.maxContextTokens,
          tokenCounter: options.tokenCounter,
          signal: options.signal,
          onBatchComplete: options.onBatchComplete
        });
        if (!result || !isInlineImage(result.inlineData)) {
          throw agyError(
            "PRIVACYAI_AGY_INVALID_SANITIZED_IMAGE",
            "PrivacyAI blocked the AGY request because image sanitization returned an invalid result."
          );
        }
        mergeAgySessionAdditions(
          completeSessionMap,
          sessionMapAdditions,
          result.sessionMapAdditions
        );
        setAtPath(transformed, entry.path, result.inlineData);
        if (typeof options.onArtifactComplete === "function") {
          await options.onArtifactComplete({
            artifactIndex: imageIndex,
            artifactCount: imageSlots.length,
            artifactKey: entry.slotKey,
            artifactType: "image",
            slotCount: 1
          });
        }
      }
    } catch (error) {
      if (error?.code || error?.name === "AbortError") throw error;
      throw agyError(
        "PRIVACYAI_AGY_IMAGE_SANITIZER_FAILURE",
        "PrivacyAI's local image sanitizer failed while inspecting AGY context.",
        error
      );
    }
  }

  const { slots, schemaTraces } = collectAgyArtifacts(transformed, completeSessionMap);
  let artifactResult;
  try {
    artifactResult = await sanitizeModelVisibleArtifacts(
      slots.map(entry => ({
        value: entry.value,
        slotKey: entry.slotKey,
        artifactType: entry.artifactType,
        artifactKey: entry.artifactKey,
        sanitizeObjectKeys: entry.sanitizeObjectKeys
      })),
      {
        sanitizer: options.sanitizer,
        identity: options.identity,
        identityRoot: options.identityRoot,
        sessionMap: completeSessionMap,
        cache: options.cache,
        policyFingerprint: options.policyFingerprint,
        maxContextChars: options.maxContextChars,
        maxContextTokens: options.maxContextTokens,
        tokenCounter: options.tokenCounter,
        artifactTypePrefix: "agy",
        signal: options.signal,
        onBatchComplete: options.onBatchComplete,
        onArtifactComplete: options.onArtifactComplete,
        invalidShapeError: () => agyError(
          "PRIVACYAI_AGY_INVALID_SANITIZED_REQUEST",
          "PrivacyAI blocked the AGY request because sanitization changed its model-visible shape."
        )
      }
    );
  } catch (error) {
    if (error?.code || error?.name === "AbortError") throw error;
    throw agyError(
      "PRIVACYAI_AGY_SANITIZER_FAILURE",
      "PrivacyAI's local sanitizer failed while inspecting AGY context.",
      error
    );
  }

  mergeAgySessionAdditions(
    completeSessionMap,
    sessionMapAdditions,
    artifactResult.sessionMapAdditions
  );
  const protectedToolOriginals = removeLegacyAgyToolMappings(
    slots,
    completeSessionMap,
    sessionMapAdditions
  );
  const providerToolNames = resolveAgyProviderToolNames(
    slots,
    completeSessionMap,
    protectedToolOriginals,
    options.identity
  );
  mergeAgySessionAdditions(
    completeSessionMap,
    sessionMapAdditions,
    providerToolNames.sessionMapAdditions
  );
  rewriteAllowedAgyFunctionNames(
    transformed.request.toolConfig,
    providerToolNames.values
  );
  artifactResult.values.forEach((value, index) => {
    const resolved = slots[index].artifactType === "tool_name"
      ? providerToolNames.values.get(slots[index].value)
      : value;
    setAtPath(transformed, slots[index].path, resolved);
  });

  const finalizedSchemaTraces = schemaTraces.map(trace => finalizeAgyToolSchemaTrace(
    getAtPath(transformed, trace.path),
    trace,
    artifactResult.values.map((value, index) => ({
      entry: slots[index],
      value,
      cacheHit: artifactResult.cacheHitSlotKeys.has(slots[index].slotKey)
    }))
  ));
  if (typeof options.onSchemaTrace === "function") {
    for (const trace of finalizedSchemaTraces) await options.onSchemaTrace(trace);
  }
  validateAgyRequestBody(transformed, { functionNameMode: "provider" });

  return {
    body: transformed,
    sessionKey: agySessionKey(body, options.fallbackSessionId),
    sessionMapAdditions,
    cacheWrites: artifactResult.cacheWrites,
    itemRecords: artifactResult.itemRecords,
    policyFingerprint: artifactResult.policyFingerprint,
    metrics: artifactResult.metrics,
    schemaTraces: finalizedSchemaTraces
  };
}

export function agySessionKey(body, fallbackSessionId) {
  const sessionId = body?.request?.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) return `agy:${sessionId}`;
  if (fallbackSessionId) return `agy:${String(fallbackSessionId)}`;
  throw agyError(
    "PRIVACYAI_AGY_MISSING_SESSION",
    "PrivacyAI blocked an AGY model request without a session identity."
  );
}

export function validateAgyRequestBody(body, options = {}) {
  assertPlainObject(body, "request envelope");
  assertOnlyKeys(body, OUTER_FIELDS, "request envelope");
  assertOpaqueString(body.project, "project", 512);
  assertOpaqueString(body.requestId, "request id", 2048);
  assertOpaqueString(body.model, "model", 256);
  assertOpaqueString(body.userAgent, "user agent", 512);
  assertOpaqueString(body.requestType, "request type", 128);

  const request = body.request;
  assertPlainObject(request, "generation request");
  assertOnlyKeys(request, REQUEST_FIELDS, "generation request");
  assertOpaqueString(request.sessionId, "session id", 512);

  validateContents(request.contents, "request.contents", options);
  if (request.systemInstruction != null) {
    validateContent(request.systemInstruction, "request.systemInstruction", {
      ...options,
      systemInstruction: true
    });
  }
  if (request.tools != null) validateTools(request.tools, options);
  if (request.toolConfig != null) validateJsonControl(request.toolConfig, "request.toolConfig");
  if (request.labels != null) validateLabels(request.labels);
  if (request.generationConfig != null) validateJsonControl(request.generationConfig, "request.generationConfig");
  if (request.safetySettings != null) validateJsonControl(request.safetySettings, "request.safetySettings");
  return body;
}

function collectAgyImageSlots(body) {
  const slots = [];
  body.request.contents.forEach((content, contentIndex) => {
    content.parts.forEach((part, partIndex) => {
      const partPath = ["request", "contents", contentIndex, "parts", partIndex];
      const slotPrefix = `contents/${contentIndex}/parts/${partIndex}`;
      if (part.inlineData != null) {
        slots.push({
          path: [...partPath, "inlineData"],
          value: part.inlineData,
          slotKey: `${slotPrefix}/inlineData`
        });
      }
      for (let nestedIndex = 0; nestedIndex < (part.functionResponse?.parts?.length || 0); nestedIndex += 1) {
        const nested = part.functionResponse.parts[nestedIndex];
        if (nested.inlineData == null) continue;
        slots.push({
          path: [...partPath, "functionResponse", "parts", nestedIndex, "inlineData"],
          value: nested.inlineData,
          slotKey: `${slotPrefix}/functionResponse/parts/${nestedIndex}/inlineData`
        });
      }
    });
  });
  return slots;
}

function collectAgyArtifacts(body, sessionMap = {}) {
  const request = body.request;
  const slots = [];
  const schemaTraces = [];

  request.contents.forEach((content, index) => {
    collectContentArtifacts(
      content,
      ["request", "contents", index],
      `contents/${index}`,
      slots,
      contentArtifactType(content)
    );
  });

  if (request.systemInstruction != null) {
    collectContentArtifacts(
      request.systemInstruction,
      ["request", "systemInstruction"],
      "systemInstruction",
      slots,
      "instructions"
    );
  }

  collectToolArtifacts(request.tools, slots, sessionMap, schemaTraces);

  if (request.generationConfig?.responseSchema != null) {
    collectAgySchemaSlots(
      request.generationConfig.responseSchema,
      ["request", "generationConfig", "responseSchema"],
      sessionMap,
      schemaTraces,
      slots,
      "generation_response_schema"
    );
  }

  return { slots, schemaTraces };
}

function collectContentArtifacts(content, basePath, artifactKey, slots, textArtifactType) {
  content.parts.forEach((part, partIndex) => {
    const partPath = [...basePath, "parts", partIndex];
    const slotPrefix = `${artifactKey}/parts/${partIndex}`;

    if (typeof part.text === "string") {
      slots.push({
        path: [...partPath, "text"],
        value: part.text,
        slotKey: `${slotPrefix}/text`,
        artifactKey,
        artifactType: textArtifactType
      });
      return;
    }

    if (part.inlineData != null || part.fileData != null) return;

    if (part.functionCall != null) {
      slots.push({
        path: [...partPath, "functionCall", "name"],
        value: part.functionCall.name,
        slotKey: `${slotPrefix}/functionCall/name`,
        artifactKey: "tool_names",
        artifactType: "tool_name"
      });
      slots.push({
        path: [...partPath, "functionCall", "args"],
        value: part.functionCall.args,
        slotKey: `${slotPrefix}/functionCall/args`,
        artifactKey,
        artifactType: "tool_call",
        sanitizeObjectKeys: false
      });
      return;
    }

    slots.push({
      path: [...partPath, "functionResponse", "name"],
      value: part.functionResponse.name,
      slotKey: `${slotPrefix}/functionResponse/name`,
      artifactKey: "tool_names",
      artifactType: "tool_name"
    });
    slots.push({
      path: [...partPath, "functionResponse", "response"],
      value: part.functionResponse.response,
      slotKey: `${slotPrefix}/functionResponse/response`,
      artifactKey,
      artifactType: "tool_output"
    });
  });
}

function collectToolArtifacts(tools, slots, sessionMap, schemaTraces) {
  for (let toolIndex = 0; toolIndex < (tools?.length || 0); toolIndex += 1) {
    const declarations = tools[toolIndex].functionDeclarations;
    for (let declarationIndex = 0; declarationIndex < declarations.length; declarationIndex += 1) {
      const declaration = declarations[declarationIndex];
      const basePath = ["request", "tools", toolIndex, "functionDeclarations", declarationIndex];
      const slotPrefix = `tools/${toolIndex}/declarations/${declarationIndex}`;

      slots.push({
        path: [...basePath, "name"],
        value: declaration.name,
        slotKey: `${slotPrefix}/name`,
        artifactKey: "tool_names",
        artifactType: "tool_name"
      });

      if (declaration.description != null) {
        slots.push({
          path: [...basePath, "description"],
          value: declaration.description,
          slotKey: `${slotPrefix}/description`,
          artifactKey: "tool_definitions",
          artifactType: "tool_definition"
        });
      }

      for (const key of ["parameters", "parametersJsonSchema", "response", "responseJsonSchema"]) {
        if (declaration[key] == null) continue;
        collectAgySchemaSlots(
          declaration[key],
          [...basePath, key],
          sessionMap,
          schemaTraces,
          slots,
          `tool_${key}`
        );
      }
    }
  }
}

function collectAgySchemaSlots(value, path, sessionMap, schemaTraces, slots, schemaKind) {
  const collected = collectAgyToolSchema(value, path, sessionMap, schemaKind);
  slots.push(...collected.slots);
  schemaTraces.push(collected.trace);
}

export function normalizeAgySessionMap(body, sessionMap = {}, identity) {
  const normalized = normalizeSessionMap(sessionMap);
  const toolNames = collectAgyToolNames(body);
  if (toolNames.size === 0) return normalized;

  const output = {};
  const occupied = new Set([...toolNames, ...Object.keys(normalized)]);
  const legacyToolMappings = [];
  for (const [placeholder, original] of Object.entries(normalized)) {
    if (toolNames.has(original) && isLegacyToolPlaceholder(placeholder)) {
      legacyToolMappings.push([placeholder, original]);
      continue;
    }
    // A single original may intentionally have both a text/image placeholder
    // and a provider-safe function alias. Preserve both; only old TOOL-style
    // bracket placeholders are migrated because Google cannot accept them as
    // function names.
    output[placeholder] = original;
  }

  for (const [, original] of legacyToolMappings) {
    const existingAlias = Object.entries(output)
      .find(([alias, mappedOriginal]) =>
        mappedOriginal === original && isProviderFunctionName(alias)
      )?.[0];
    if (existingAlias) continue;
    const alias = allocateAgyToolAlias(original, occupied, identity);
    output[alias] = original;
    occupied.add(alias);
  }
  return output;
}

function removeLegacyAgyToolMappings(slots, completeMap, aggregateAdditions) {
  const toolOriginals = new Set(
    slots.filter(slot => slot.artifactType === "tool_name").map(slot => slot.value)
  );
  const protectedOriginals = new Set();
  for (const [placeholder, original] of Object.entries(completeMap || {})) {
    if (!toolOriginals.has(original) || !isLegacyToolPlaceholder(placeholder)) continue;
    protectedOriginals.add(original);
    delete completeMap[placeholder];
    delete aggregateAdditions[placeholder];
  }
  return protectedOriginals;
}

function resolveAgyProviderToolNames(
  slots,
  sessionMap,
  additionallyProtected = new Set(),
  identity
) {
  const originals = [...new Set(
    slots.filter(slot => slot.artifactType === "tool_name").map(slot => slot.value)
  )];
  const occupied = new Set([
    ...originals,
    ...Object.keys(sessionMap || {})
  ]);
  const protectedOriginals = new Set([
    ...Object.values(sessionMap || {}),
    ...additionallyProtected
  ]);
  const values = new Map();
  const sessionMapAdditions = {};

  for (const original of originals) {
    if (isProviderFunctionName(original) && !protectedOriginals.has(original)) {
      values.set(original, original);
      continue;
    }
    const existingAlias = Object.entries(sessionMap || {})
      .find(([candidate, mappedOriginal]) =>
        mappedOriginal === original &&
        isProviderFunctionName(candidate) &&
        !originals.includes(candidate)
      )?.[0];
    const alias = existingAlias || allocateAgyToolAlias(original, occupied, identity);
    values.set(original, alias);
    occupied.add(alias);
    if (!Object.hasOwn(sessionMap || {}, alias)) sessionMapAdditions[alias] = original;
  }

  return { values, sessionMapAdditions };
}

function rewriteAllowedAgyFunctionNames(toolConfig, providerToolNames) {
  const functionCallingConfig = toolConfig?.functionCallingConfig;
  const allowed = functionCallingConfig?.allowedFunctionNames;
  if (allowed == null) return;
  if (!Array.isArray(allowed) || allowed.some(name => typeof name !== "string" || name.length === 0)) {
    throw agyError(
      "PRIVACYAI_AGY_INVALID_TOOL_CONFIG",
      "PrivacyAI requires AGY allowed function names to be non-empty strings."
    );
  }
  functionCallingConfig.allowedFunctionNames = allowed.map(name =>
    providerToolNames.get(name) || name
  );
}

function collectAgyToolNames(body) {
  const names = new Set();
  for (const tool of body?.request?.tools || []) {
    for (const declaration of tool?.functionDeclarations || []) {
      if (typeof declaration?.name === "string") names.add(declaration.name);
    }
  }
  for (const content of body?.request?.contents || []) {
    for (const part of content?.parts || []) {
      const name = part?.functionCall?.name ?? part?.functionResponse?.name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

function allocateAgyToolAlias(original, occupied, identity) {
  try {
    return deterministicProviderIdentifier(identity, "agy", original, occupied);
  } catch (error) {
    if (error?.code !== "PRIVACYAI_IDENTITY_COLLISION") throw error;
    throw agyError(
      "PRIVACYAI_AGY_TOOL_ALIAS_COLLISION",
      "PrivacyAI could not allocate a unique private AGY tool alias.",
      error
    );
  }
}

function isLegacyToolPlaceholder(value) {
  return typeof value === "string" && /^\[(?:TOOL|TOOL_NAME|FUNCTION|FUNCTION_NAME)_\d+\]$/i.test(value);
}

function isProviderFunctionName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function isNativeFunctionName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:/-]{0,255}$/.test(value);
}

function contentArtifactType(content) {
  const parts = content.parts || [];
  if (parts.some(part => part.functionResponse)) return "tool_output";
  if (parts.some(part => part.functionCall)) return "tool_call_history";
  return content.role === "model" ? "assistant_message" : "message_text";
}

function validateContents(contents, label, options = {}) {
  if (!Array.isArray(contents) || contents.length === 0) {
    throw agyError("PRIVACYAI_AGY_INVALID_REQUEST", `${label} must be a non-empty array.`);
  }
  contents.forEach((content, index) => validateContent(content, `${label}[${index}]`, options));
}

function validateContent(content, label, options = {}) {
  assertPlainObject(content, label);
  assertOnlyKeys(content, new Set(["role", "parts"]), label);
  assertOpaqueString(content.role, `${label}.role`, 32);
  const allowedRoles = options.systemInstruction
    ? new Set(["system", "user", "model"])
    : new Set(["user", "model"]);
  if (!allowedRoles.has(content.role)) {
    throw agyError("PRIVACYAI_AGY_UNSUPPORTED_ROLE", `PrivacyAI blocked unsupported AGY role: ${safeToken(content.role)}`);
  }
  if (!Array.isArray(content.parts) || content.parts.length === 0) {
    throw agyError("PRIVACYAI_AGY_INVALID_CONTENT", `${label}.parts must be a non-empty array.`);
  }
  content.parts.forEach((part, index) => validatePart(part, `${label}.parts[${index}]`, options));
}

function validatePart(part, label, options = {}) {
  assertPlainObject(part, label);
  assertOnlyKeys(part, PART_FIELDS, label);
  const payloads = ["text", "functionCall", "functionResponse", "inlineData", "fileData"]
    .filter(key => part[key] != null);
  if (payloads.length !== 1) {
    throw agyError(
      "PRIVACYAI_AGY_INVALID_PART",
      `${label} must contain exactly one supported model-visible payload.`
    );
  }
  if (Object.hasOwn(part, "thought") && typeof part.thought !== "boolean") {
    throw agyError("PRIVACYAI_AGY_INVALID_PART", `${label}.thought must be a boolean.`);
  }
  if (part.thoughtSignature != null) {
    assertOpaqueString(part.thoughtSignature, `${label}.thoughtSignature`, 16 * 1024 * 1024);
  }
  if (part.text != null) {
    if (typeof part.text !== "string") {
      throw agyError("PRIVACYAI_AGY_INVALID_PART", `${label}.text must be a string.`);
    }
    return;
  }
  if (options.systemInstruction) {
    throw agyError(
      "PRIVACYAI_AGY_UNSUPPORTED_SYSTEM_PART",
      "PrivacyAI supports only text parts in AGY system instructions."
    );
  }
  if (part.inlineData != null) {
    validateInlineImage(part.inlineData, `${label}.inlineData`);
    return;
  }
  if (part.fileData != null) {
    rejectRemoteImage(part.fileData, `${label}.fileData`);
    return;
  }
  if (part.functionCall != null) validateFunctionCall(part.functionCall, `${label}.functionCall`, options);
  if (part.functionResponse != null) validateFunctionResponse(part.functionResponse, `${label}.functionResponse`, options);
}

function validateInlineImage(value, label) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, INLINE_DATA_FIELDS, label);
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(value.mimeType)) {
    throw agyError(
      "PRIVACYAI_AGY_UNSUPPORTED_MEDIA_TYPE",
      `${label}.mimeType must be PNG, JPEG, or WebP.`
    );
  }
  if (typeof value.data !== "string" || value.data.length === 0) {
    throw agyError(
      "PRIVACYAI_AGY_INVALID_IMAGE",
      `${label}.data must be non-empty base64 image data.`
    );
  }
}

function rejectRemoteImage(value, label) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, FILE_DATA_FIELDS, label);
  if (typeof value.mimeType !== "string" || typeof value.fileUri !== "string") {
    throw agyError("PRIVACYAI_AGY_INVALID_IMAGE", `${label} must contain MIME and URI strings.`);
  }
  throw agyError(
    "PRIVACYAI_AGY_UNSUPPORTED_IMAGE_URL",
    "PrivacyAI accepts only local inline AGY images; remote file URIs are blocked."
  );
}

function validateFunctionCall(value, label, options = {}) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, FUNCTION_CALL_FIELDS, label);
  if (value.id != null) assertOpaqueString(value.id, `${label}.id`, 1024);
  assertAgyFunctionName(value.name, `${label}.name`, options);
  assertPlainObject(value.args, `${label}.args`);
}

function validateFunctionResponse(value, label, options = {}) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, FUNCTION_RESPONSE_FIELDS, label);
  if (value.id != null) assertOpaqueString(value.id, `${label}.id`, 1024);
  assertAgyFunctionName(value.name, `${label}.name`, options);
  if (value.response == null || typeof value.response !== "object") {
    throw agyError("PRIVACYAI_AGY_INVALID_FUNCTION_RESPONSE", `${label}.response must be structured data.`);
  }
  if (value.parts != null) {
    if (!Array.isArray(value.parts) || value.parts.length === 0) {
      throw agyError("PRIVACYAI_AGY_INVALID_IMAGE", `${label}.parts must be a non-empty image-parts array.`);
    }
    value.parts.forEach((part, index) => {
      const partLabel = `${label}.parts[${index}]`;
      assertPlainObject(part, partLabel);
      assertOnlyKeys(part, new Set(["inlineData", "fileData"]), partLabel);
      const payloads = ["inlineData", "fileData"].filter(key => part[key] != null);
      if (payloads.length !== 1) {
        throw agyError(
          "PRIVACYAI_AGY_INVALID_IMAGE",
          `${partLabel} must contain exactly one supported image payload.`
        );
      }
      if (part.inlineData != null) validateInlineImage(part.inlineData, `${partLabel}.inlineData`);
      else rejectRemoteImage(part.fileData, `${partLabel}.fileData`);
    });
  }
}

function validateTools(tools, options = {}) {
  if (!Array.isArray(tools)) {
    throw agyError("PRIVACYAI_AGY_INVALID_TOOLS", "request.tools must be an array.");
  }
  tools.forEach((tool, toolIndex) => {
    const label = `request.tools[${toolIndex}]`;
    assertPlainObject(tool, label);
    assertOnlyKeys(tool, new Set(["functionDeclarations"]), label);
    if (!Array.isArray(tool.functionDeclarations) || tool.functionDeclarations.length === 0) {
      throw agyError("PRIVACYAI_AGY_INVALID_TOOLS", `${label}.functionDeclarations must be non-empty.`);
    }
    tool.functionDeclarations.forEach((declaration, declarationIndex) => {
      const declarationLabel = `${label}.functionDeclarations[${declarationIndex}]`;
      assertPlainObject(declaration, declarationLabel);
      assertOnlyKeys(declaration, FUNCTION_DECLARATION_FIELDS, declarationLabel);
      assertAgyFunctionName(declaration.name, `${declarationLabel}.name`, options);
      if (declaration.description != null && typeof declaration.description !== "string") {
        throw agyError("PRIVACYAI_AGY_INVALID_TOOLS", `${declarationLabel}.description must be a string.`);
      }
      for (const key of ["parameters", "parametersJsonSchema", "response", "responseJsonSchema"]) {
        if (declaration[key] != null) validateJsonControl(declaration[key], `${declarationLabel}.${key}`);
      }
    });
  });
}

function validateLabels(labels) {
  assertPlainObject(labels, "request.labels");
  for (const [key, value] of Object.entries(labels)) {
    assertOpaqueString(key, "request label name", 256);
    assertOpaqueString(value, `request.labels.${safeToken(key)}`, 2048);
  }
}

function validateJsonControl(value, label, depth = 0) {
  if (depth > 32) {
    throw agyError("PRIVACYAI_AGY_NESTING_LIMIT", `${label} exceeds the supported nesting depth.`);
  }
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw agyError("PRIVACYAI_AGY_INVALID_CONTROL", `${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonControl(entry, `${label}[${index}]`, depth + 1));
    return;
  }
  assertPlainObject(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (!key || /[\0\r\n]/.test(key)) {
      throw agyError("PRIVACYAI_AGY_INVALID_CONTROL", `${label} contains an invalid object key.`);
    }
    validateJsonControl(entry, `${label}.${safeToken(key)}`, depth + 1);
  }
}

function getAtPath(root, path) {
  return path.reduce((value, key) => value[key], root);
}

function setAtPath(root, path, value) {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], root);
  parent[path.at(-1)] = value;
}

function mergeAgySessionAdditions(completeMap, aggregateAdditions, additions) {
  const normalized = normalizeSessionMap(additions);
  const aliasCounts = new Map();
  for (const original of Object.values(completeMap)) {
    aliasCounts.set(original, (aliasCounts.get(original) || 0) + 1);
  }

  for (const [placeholder, original] of Object.entries(normalized)) {
    if (Object.hasOwn(completeMap, placeholder)) {
      if (completeMap[placeholder] !== original) {
        throw agyError(
          "PRIVACYAI_AGY_SESSION_MAP_COLLISION",
          "PrivacyAI blocked an ambiguous AGY placeholder mapping."
        );
      }
      continue;
    }
    try {
      normalizeSessionMap({ ...completeMap, [placeholder]: original });
    } catch {
      throw agyError(
        "PRIVACYAI_AGY_SESSION_MAP_COLLISION",
        "PrivacyAI blocked an ambiguous AGY session mapping."
      );
    }
    const aliasCount = aliasCounts.get(original) || 0;
    if (aliasCount >= MAX_ALIASES_PER_ORIGINAL) {
      throw agyError(
        "PRIVACYAI_AGY_SESSION_MAP_COLLISION",
        "PrivacyAI blocked excessive AGY aliases for one private value."
      );
    }
    completeMap[placeholder] = original;
    aggregateAdditions[placeholder] = original;
    aliasCounts.set(original, aliasCount + 1);
  }
}

function isInlineImage(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    SUPPORTED_IMAGE_MIME_TYPES.has(value.mimeType) &&
    typeof value.data === "string" &&
    value.data.length > 0 &&
    Object.keys(value).every(key => INLINE_DATA_FIELDS.has(key))
  );
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PrivacyAI stopped the AGY request because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_AGY_REQUEST_ABORTED";
  throw error;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agyError("PRIVACYAI_AGY_INVALID_REQUEST", `${label} must be an object.`);
  }
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw agyError(
        "PRIVACYAI_AGY_UNSUPPORTED_FIELD",
        `PrivacyAI blocked an unsupported field in ${label}: ${safeToken(key)}`
      );
    }
  }
}

function assertAgyFunctionName(value, label, options = {}) {
  const isValid = options.functionNameMode === "native"
    ? isNativeFunctionName(value)
    : isProviderFunctionName(value);
  if (!isValid) {
    throw agyError(
      "PRIVACYAI_AGY_INVALID_FUNCTION_NAME",
      `PrivacyAI blocked invalid ${label}.`
    );
  }
}

function assertOpaqueString(value, label, maxLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw agyError("PRIVACYAI_AGY_INVALID_CONTROL", `PrivacyAI blocked invalid ${label}.`);
  }
}

function safeToken(value) {
  const text = String(value || "missing");
  return /^[A-Za-z0-9._:+\/-]{1,120}$/.test(text) ? text : "invalid";
}

function agyError(code, message, cause) {
  const error = cause == null ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}
