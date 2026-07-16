import { createHash } from "node:crypto";

import { normalizeSessionMap } from "@privacy-ai/sdk";
import { sanitizeModelVisibleArtifacts } from "./model-visible-artifacts.js";

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
  "thoughtSignature"
]);

const FUNCTION_CALL_FIELDS = new Set(["id", "name", "args"]);
const FUNCTION_RESPONSE_FIELDS = new Set(["id", "name", "response"]);
const FUNCTION_DECLARATION_FIELDS = new Set([
  "name",
  "description",
  "parameters",
  "parametersJsonSchema",
  "response",
  "responseJsonSchema"
]);

export async function sanitizeAgyRequestBody(body, options = {}) {
  validateAgyRequestBody(body);
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("AGY request transformation requires a sanitizer function.");
  }

  const transformed = structuredClone(body);
  const slots = collectAgyArtifacts(transformed);
  let artifactResult;
  try {
    artifactResult = await sanitizeModelVisibleArtifacts(
      slots.map(entry => ({
        value: entry.value,
        slotKey: entry.slotKey,
        artifactType: entry.artifactType,
        artifactKey: entry.artifactKey
      })),
      {
        sanitizer: options.sanitizer,
        sessionMap: options.sessionMap,
        cache: options.cache,
        policyFingerprint: options.policyFingerprint,
        maxContextChars: options.maxContextChars,
        artifactTypePrefix: "agy",
        signal: options.signal,
        onBatchComplete: options.onBatchComplete,
        onArtifactComplete: options.onArtifactComplete,
        normalizeArtifactResult: normalizeAgyArtifactResult,
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

  artifactResult.values.forEach((value, index) => setAtPath(transformed, slots[index].path, value));
  validateAgyRequestBody(transformed);

  return {
    body: transformed,
    sessionKey: agySessionKey(body, options.fallbackSessionId),
    sessionMapAdditions: artifactResult.sessionMapAdditions,
    cacheWrites: artifactResult.cacheWrites,
    itemRecords: artifactResult.itemRecords,
    policyFingerprint: artifactResult.policyFingerprint
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

export function validateAgyRequestBody(body) {
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

  validateContents(request.contents, "request.contents");
  if (request.systemInstruction != null) {
    validateContent(request.systemInstruction, "request.systemInstruction", { systemInstruction: true });
  }
  if (request.tools != null) validateTools(request.tools);
  if (request.toolConfig != null) validateJsonControl(request.toolConfig, "request.toolConfig");
  if (request.labels != null) validateLabels(request.labels);
  if (request.generationConfig != null) validateJsonControl(request.generationConfig, "request.generationConfig");
  if (request.safetySettings != null) validateJsonControl(request.safetySettings, "request.safetySettings");
  return body;
}

function collectAgyArtifacts(body) {
  const request = body.request;
  const slots = [];

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

  collectToolArtifacts(request.tools, slots);

  if (request.generationConfig?.responseSchema != null) {
    slots.push({
      path: ["request", "generationConfig", "responseSchema"],
      value: request.generationConfig.responseSchema,
      slotKey: "generationConfig/responseSchema",
      artifactKey: "generationConfig/responseSchema",
      artifactType: "json_schema"
    });
  }

  return slots;
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
        artifactType: "tool_call"
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

function collectToolArtifacts(tools, slots) {
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
        slots.push({
          path: [...basePath, key],
          value: declaration[key],
          slotKey: `${slotPrefix}/${key}`,
          artifactKey: "tool_definitions",
          artifactType: "tool_definition"
        });
      }
    }
  }
}

export function normalizeAgySessionMap(body, sessionMap = {}) {
  const normalized = normalizeSessionMap(sessionMap);
  const toolNames = collectAgyToolNames(body);
  if (toolNames.size === 0) return normalized;

  const output = {};
  const occupied = new Set(toolNames);
  const toolMappings = [];
  for (const [placeholder, original] of Object.entries(normalized)) {
    if (toolNames.has(original)) {
      toolMappings.push([placeholder, original]);
      continue;
    }
    output[placeholder] = original;
    occupied.add(placeholder);
  }

  for (const [placeholder, original] of toolMappings) {
    const alias = isAgyFunctionName(placeholder) && !occupied.has(placeholder)
      ? placeholder
      : allocateAgyToolAlias(original, occupied);
    output[alias] = original;
    occupied.add(alias);
  }
  return output;
}

function normalizeAgyArtifactResult(result) {
  if (result.artifactType !== "tool_name") {
    return {
      value: result.value,
      sessionMapAdditions: result.sessionMapAdditions
    };
  }

  const sourceNames = new Set(result.sourceValues);
  const occupied = new Set([
    ...sourceNames,
    ...Object.keys(result.existingSessionMap || {})
  ]);
  const aliasesByOriginal = new Map();
  const additions = {};
  const value = result.value.map((sanitizedName, index) => {
    const original = result.sourceValues[index];
    if (sanitizedName === original) return original;

    let alias = aliasesByOriginal.get(original);
    if (!alias) {
      const existingAlias = Object.entries(result.existingSessionMap || {})
        .find(([, mappedOriginal]) => mappedOriginal === original)?.[0];
      alias = isAgyFunctionName(existingAlias) && !sourceNames.has(existingAlias)
        ? existingAlias
        : allocateAgyToolAlias(original, occupied);
      aliasesByOriginal.set(original, alias);
      occupied.add(alias);
      additions[alias] = original;
    }
    return alias;
  });

  return { value, sessionMapAdditions: additions };
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

function allocateAgyToolAlias(original, occupied) {
  const digest = createHash("sha256").update(String(original)).digest("hex");
  for (let length = 12; length <= digest.length; length += 4) {
    const candidate = `privacyai_tool_${digest.slice(0, length)}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw agyError(
    "PRIVACYAI_AGY_TOOL_ALIAS_COLLISION",
    "PrivacyAI could not allocate a unique private AGY tool alias."
  );
}

function isAgyFunctionName(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function contentArtifactType(content) {
  const parts = content.parts || [];
  if (parts.some(part => part.functionResponse)) return "tool_output";
  if (parts.some(part => part.functionCall)) return "tool_call_history";
  return content.role === "model" ? "assistant_message" : "message_text";
}

function validateContents(contents, label) {
  if (!Array.isArray(contents) || contents.length === 0) {
    throw agyError("PRIVACYAI_AGY_INVALID_REQUEST", `${label} must be a non-empty array.`);
  }
  contents.forEach((content, index) => validateContent(content, `${label}[${index}]`));
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
  const payloads = ["text", "functionCall", "functionResponse"].filter(key => part[key] != null);
  if (payloads.length !== 1) {
    throw agyError(
      "PRIVACYAI_AGY_INVALID_PART",
      `${label} must contain exactly one supported model-visible payload.`
    );
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
  if (part.functionCall != null) validateFunctionCall(part.functionCall, `${label}.functionCall`);
  if (part.functionResponse != null) validateFunctionResponse(part.functionResponse, `${label}.functionResponse`);
}

function validateFunctionCall(value, label) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, FUNCTION_CALL_FIELDS, label);
  if (value.id != null) assertOpaqueString(value.id, `${label}.id`, 1024);
  assertAgyFunctionName(value.name, `${label}.name`);
  assertPlainObject(value.args, `${label}.args`);
}

function validateFunctionResponse(value, label) {
  assertPlainObject(value, label);
  assertOnlyKeys(value, FUNCTION_RESPONSE_FIELDS, label);
  if (value.id != null) assertOpaqueString(value.id, `${label}.id`, 1024);
  assertAgyFunctionName(value.name, `${label}.name`);
  if (value.response == null || typeof value.response !== "object") {
    throw agyError("PRIVACYAI_AGY_INVALID_FUNCTION_RESPONSE", `${label}.response must be structured data.`);
  }
}

function validateTools(tools) {
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
      assertAgyFunctionName(declaration.name, `${declarationLabel}.name`);
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

function setAtPath(root, path, value) {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], root);
  parent[path.at(-1)] = value;
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

function assertAgyFunctionName(value, label) {
  if (!isAgyFunctionName(value)) {
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
