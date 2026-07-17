import { createHash } from "node:crypto";

import { RegexDetector } from "@privacy-ai/sdk";

import { gatewayError } from "./gateway-error.js";

// JSON Schema is a protocol, not ordinary model-visible JSON. This policy is
// deliberately narrow: only prose annotations on actual schema objects may
// reach the text sanitizer. Instance-valued data, extension payloads, and all
// protocol identifiers remain immutable.
const ANNOTATION_KEYS = new Set(["description", "title", "$comment"]);
const SCHEMA_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas"
]);
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_VALUE_KEYS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties"
]);
const STRING_VALUE_KEYS = new Set([
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$ref",
  "$schema"
]);
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);
const IMMUTABLE_SECRET_TYPES = new Set([
  "API_KEY",
  "AWS_ACCESS_KEY",
  "CONNECTION_STRING_CREDENTIAL",
  "CREDIT_CARD",
  "EMAIL",
  "IP_ADDRESS",
  "MEDICAL_ID",
  "MRN",
  "PHONE",
  "SSN",
  "URL_CREDENTIAL",
  "URL_QUERY_SECRET"
]);
const IMMUTABLE_SECRET_DETECTOR = new RegexDetector();

/**
 * Collect sanitizer slots and immutable-structure diagnostics for one JSON
 * Schema. Everything outside the explicit annotation allowlist is immutable,
 * including unknown extension keywords. This makes future keywords safe by
 * default and prevents schema instance data from being mistaken for prose.
 */
export function collectCodexJsonSchema(schema, path, sessionMap = {}) {
  assertSchema(schema);

  const trace = {
    schemaLocation: safeLocation(path),
    schemaKind: path.includes("parameters") ? "tool_parameters" : "text_format",
    immutableFingerprintBefore: null,
    immutableNodeCount: 0,
    immutableKeyCount: 0,
    sanitizedAnnotationCount: 0,
    cacheHitCount: 0,
    structurePreserved: false
  };
  const slots = [];
  walkSchema(schema, path, sessionMap, slots, trace);
  trace.immutableFingerprintBefore = immutableFingerprint(schema);
  return { slots, trace };
}

export function finalizeCodexJsonSchemaTrace(schema, trace, resolvedSlots) {
  const immutableFingerprintAfter = immutableFingerprint(schema);
  trace.sanitizedAnnotationCount = resolvedSlots.filter(({ entry, value }) =>
    entry.schemaTrace === trace && value !== entry.value
  ).length;
  trace.cacheHitCount = resolvedSlots.filter(({ entry }) =>
    entry.schemaTrace === trace && entry.cacheHit === true
  ).length;
  trace.structurePreserved = trace.immutableFingerprintBefore === immutableFingerprintAfter;
  if (!trace.structurePreserved) {
    throw gatewayError(
      "PRIVACYAI_CODEX_SCHEMA_STRUCTURE_CHANGED",
      "PrivacyAI blocked a JSON Schema whose protocol structure changed during transformation."
    );
  }
  const { path: _internalPath, ...safeTrace } = trace;
  return { ...safeTrace, immutableFingerprintAfter };
}

function walkSchema(value, path, sessionMap, slots, trace) {
  assertSchema(value);
  if (typeof value === "boolean") {
    trace.immutableNodeCount += 1;
    return;
  }

  trace.immutableNodeCount += 1;
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertNoKnownProtectedOriginal(key, sessionMap);

    if (ANNOTATION_KEYS.has(key)) {
      if (typeof child !== "string") throw invalidSchema();
      slots.push({ path: [...path, key], value: child, schemaTrace: trace });
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key)) {
      walkSchemaMap(child, [...path, key], sessionMap, slots, trace);
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key)) {
      walkSchemaArray(child, [...path, key], sessionMap, slots, trace);
      continue;
    }
    if (SCHEMA_VALUE_KEYS.has(key)) {
      walkSchema(child, [...path, key], sessionMap, slots, trace);
      continue;
    }
    if (key === "items") {
      if (Array.isArray(child)) {
        walkSchemaArray(child, [...path, key], sessionMap, slots, trace);
      } else {
        walkSchema(child, [...path, key], sessionMap, slots, trace);
      }
      continue;
    }
    if (key === "dependencies") {
      walkDependencies(child, [...path, key], sessionMap, slots, trace);
      continue;
    }

    validateImmutableKeyword(key, child);
    walkImmutable(child, sessionMap, trace);
  }
}

function walkSchemaMap(value, path, sessionMap, slots, trace) {
  if (!isJsonObject(value)) throw invalidSchema();
  trace.immutableNodeCount += 1;
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertNoKnownProtectedOriginal(key, sessionMap);
    walkSchema(child, [...path, key], sessionMap, slots, trace);
  }
}

function walkSchemaArray(value, path, sessionMap, slots, trace) {
  if (!Array.isArray(value)) throw invalidSchema();
  trace.immutableNodeCount += 1;
  value.forEach((child, index) => walkSchema(child, [...path, index], sessionMap, slots, trace));
}

function walkDependencies(value, path, sessionMap, slots, trace) {
  if (!isJsonObject(value)) throw invalidSchema();
  trace.immutableNodeCount += 1;
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertNoKnownProtectedOriginal(key, sessionMap);
    if (Array.isArray(child)) {
      validateStringArray(child);
      walkImmutable(child, sessionMap, trace);
    } else {
      walkSchema(child, [...path, key], sessionMap, slots, trace);
    }
  }
}

function walkImmutable(value, sessionMap, trace) {
  if (typeof value === "string") {
    trace.immutableNodeCount += 1;
    assertNoKnownProtectedOriginal(value, sessionMap);
    return;
  }
  if (value === null || typeof value !== "object") {
    trace.immutableNodeCount += 1;
    return;
  }
  if (Array.isArray(value)) {
    trace.immutableNodeCount += 1;
    value.forEach(entry => walkImmutable(entry, sessionMap, trace));
    return;
  }
  if (!isJsonObject(value)) throw invalidSchema();

  trace.immutableNodeCount += 1;
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertNoKnownProtectedOriginal(key, sessionMap);
    walkImmutable(child, sessionMap, trace);
  }
}

function validateImmutableKeyword(key, value) {
  if (STRING_VALUE_KEYS.has(key) && typeof value !== "string") throw invalidSchema();
  if (key === "required") validateStringArray(value);
  if (key === "dependentRequired") {
    if (!isJsonObject(value)) throw invalidSchema();
    for (const entries of Object.values(value)) validateStringArray(entries);
  }
  if (key === "type") {
    const types = Array.isArray(value) ? value : [value];
    if (
      types.length === 0 ||
      types.some(type => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))
    ) {
      throw invalidSchema();
    }
  }
  if (key === "enum" && !Array.isArray(value)) throw invalidSchema();
}

function validateStringArray(value) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) throw invalidSchema();
}

function assertSchema(value) {
  if (!(typeof value === "boolean" || isJsonObject(value))) throw invalidSchema();
}

function invalidSchema() {
  return gatewayError(
    "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
    "PrivacyAI blocked an invalid Codex JSON Schema."
  );
}

function assertNoKnownProtectedOriginal(value, sessionMap) {
  const normalized = value.toLocaleLowerCase("en-US");
  for (const original of Object.values(sessionMap || {})) {
    if (
      typeof original === "string" &&
      original.length > 0 &&
      normalized.includes(original.toLocaleLowerCase("en-US"))
    ) {
      throw immutableProtectedValueError();
    }
  }
  if (
    IMMUTABLE_SECRET_DETECTOR
      .detect(value)
      .some(detection => IMMUTABLE_SECRET_TYPES.has(detection.type))
  ) {
    throw immutableProtectedValueError();
  }
}

function immutableProtectedValueError() {
  return gatewayError(
    "PRIVACYAI_CODEX_SCHEMA_IMMUTABLE_PROTECTED_VALUE",
    "PrivacyAI blocked a protected value in an immutable JSON Schema field."
  );
}

function immutableFingerprint(schema) {
  return createHash("sha256").update(stableJson(projectSchema(schema))).digest("hex");
}

function projectSchema(value) {
  if (typeof value === "boolean") return value;
  const projection = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (ANNOTATION_KEYS.has(key) && typeof child === "string") {
      projection[key] = "[annotation]";
    } else if (SCHEMA_MAP_KEYS.has(key)) {
      projection[key] = projectSchemaMap(child);
    } else if (SCHEMA_ARRAY_KEYS.has(key)) {
      projection[key] = child.map(projectSchema);
    } else if (SCHEMA_VALUE_KEYS.has(key)) {
      projection[key] = projectSchema(child);
    } else if (key === "items") {
      projection[key] = Array.isArray(child) ? child.map(projectSchema) : projectSchema(child);
    } else if (key === "dependencies") {
      projection[key] = projectDependencies(child);
    } else {
      projection[key] = immutableProjection(child);
    }
  }
  return projection;
}

function projectSchemaMap(value) {
  const projection = Object.create(null);
  for (const [key, child] of Object.entries(value)) projection[key] = projectSchema(child);
  return projection;
}

function projectDependencies(value) {
  const projection = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    projection[key] = Array.isArray(child) ? immutableProjection(child) : projectSchema(child);
  }
  return projection;
}

function immutableProjection(value) {
  if (Array.isArray(value)) return value.map(immutableProjection);
  if (!value || typeof value !== "object") return value;
  const projection = Object.create(null);
  for (const [key, child] of Object.entries(value)) projection[key] = immutableProjection(child);
  return projection;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function isJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeLocation(path) {
  return path
    .map(part => String(part).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
}
