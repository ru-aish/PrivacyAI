import {
  assertImmutableToolString,
  immutableToolStructureFingerprint
} from "./immutable-tool-structure.js";

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
const DEFAULT_MAX_DEPTH = 64;

/**
 * Collect only explicitly allowed prose annotations from a JSON-like tool
 * schema. Every identifier, protocol constant, instance value, extension
 * keyword, and unknown future field remains immutable by default.
 */
export function collectToolSchemaAnnotations(schema, path, sessionMap = {}, options = {}) {
  const policy = normalizePolicy(options);
  assertSchema(schema, policy);

  const trace = {
    path,
    schemaLocation: safeLocation(path),
    schemaKind: String(options.schemaKind || "tool_schema"),
    immutableFingerprintBefore: null,
    immutableNodeCount: 0,
    immutableKeyCount: 0,
    sanitizedAnnotationCount: 0,
    cacheHitCount: 0,
    structurePreserved: false
  };
  const slots = [];
  walkSchema(schema, path, sessionMap, slots, trace, policy, 0);
  trace.immutableFingerprintBefore = projectedFingerprint(schema);
  return { slots, trace };
}

export function finalizeToolSchemaAnnotations(schema, trace, resolvedSlots, options = {}) {
  const immutableFingerprintAfter = projectedFingerprint(schema);
  trace.sanitizedAnnotationCount = resolvedSlots.filter(({ entry, value }) =>
    entry.schemaTrace === trace && value !== entry.value
  ).length;
  trace.cacheHitCount = resolvedSlots.filter(({ entry, cacheHit }) =>
    entry.schemaTrace === trace && (cacheHit === true || entry.cacheHit === true)
  ).length;
  trace.structurePreserved = trace.immutableFingerprintBefore === immutableFingerprintAfter;
  if (!trace.structurePreserved) {
    throw typeof options.structureChangedError === "function"
      ? options.structureChangedError()
      : policyError(
          "PRIVACYAI_TOOL_SCHEMA_STRUCTURE_CHANGED",
          "PrivacyAI blocked a tool schema whose protocol structure changed during transformation."
        );
  }
  const { path: _path, ...safeTrace } = trace;
  return { ...safeTrace, immutableFingerprintAfter };
}

function walkSchema(value, path, sessionMap, slots, trace, policy, depth) {
  assertDepth(depth, policy);
  assertSchema(value, policy);
  if (typeof value === "boolean") {
    trace.immutableNodeCount += 1;
    return;
  }

  trace.immutableNodeCount += 1;
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertImmutable(key, sessionMap, policy);

    if (ANNOTATION_KEYS.has(key)) {
      if (typeof child !== "string") throw invalidSchema(policy);
      slots.push(policy.annotationSlot({
        path: [...path, key],
        value: child,
        trace,
        key
      }));
      continue;
    }
    if (SCHEMA_MAP_KEYS.has(key)) {
      walkSchemaMap(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
      continue;
    }
    if (SCHEMA_ARRAY_KEYS.has(key)) {
      walkSchemaArray(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
      continue;
    }
    if (SCHEMA_VALUE_KEYS.has(key)) {
      walkSchema(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
      continue;
    }
    if (key === "items") {
      if (Array.isArray(child)) {
        walkSchemaArray(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
      } else {
        walkSchema(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
      }
      continue;
    }
    if (key === "dependencies") {
      walkDependencies(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
      continue;
    }

    validateImmutableKeyword(key, child, policy);
    walkImmutable(child, sessionMap, trace, policy, depth + 1);
  }
}

function walkSchemaMap(value, path, sessionMap, slots, trace, policy, depth) {
  assertDepth(depth, policy);
  if (!isPlainObject(value)) throw invalidSchema(policy);
  trace.immutableNodeCount += 1;
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertImmutable(key, sessionMap, policy);
    walkSchema(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
  }
}

function walkSchemaArray(value, path, sessionMap, slots, trace, policy, depth) {
  assertDepth(depth, policy);
  if (!Array.isArray(value)) throw invalidSchema(policy);
  trace.immutableNodeCount += 1;
  value.forEach((child, index) =>
    walkSchema(child, [...path, index], sessionMap, slots, trace, policy, depth + 1)
  );
}

function walkDependencies(value, path, sessionMap, slots, trace, policy, depth) {
  assertDepth(depth, policy);
  if (!isPlainObject(value)) throw invalidSchema(policy);
  trace.immutableNodeCount += 1;
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertImmutable(key, sessionMap, policy);
    if (Array.isArray(child)) {
      validateStringArray(child, policy);
      walkImmutable(child, sessionMap, trace, policy, depth + 1);
    } else {
      walkSchema(child, [...path, key], sessionMap, slots, trace, policy, depth + 1);
    }
  }
}

function walkImmutable(value, sessionMap, trace, policy, depth) {
  assertDepth(depth, policy);
  trace.immutableNodeCount += 1;
  if (typeof value === "string") {
    assertImmutable(value, sessionMap, policy);
    return;
  }
  if (value == null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidSchema(policy);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(entry => walkImmutable(entry, sessionMap, trace, policy, depth + 1));
    return;
  }
  if (!isPlainObject(value)) throw invalidSchema(policy);
  for (const [key, child] of Object.entries(value)) {
    trace.immutableKeyCount += 1;
    assertImmutable(key, sessionMap, policy);
    walkImmutable(child, sessionMap, trace, policy, depth + 1);
  }
}

function validateImmutableKeyword(key, value, policy) {
  if (STRING_VALUE_KEYS.has(key) && typeof value !== "string") throw invalidSchema(policy);
  if (key === "required") validateStringArray(value, policy);
  if (key === "dependentRequired") {
    if (!isPlainObject(value)) throw invalidSchema(policy);
    Object.values(value).forEach(entries => validateStringArray(entries, policy));
  }
  if (key === "type") {
    const types = Array.isArray(value) ? value : [value];
    if (
      types.length === 0 ||
      types.some(type => typeof type !== "string" || !policy.allowedTypes.has(type))
    ) {
      throw invalidSchema(policy);
    }
  }
  if (key === "enum" && !Array.isArray(value)) throw invalidSchema(policy);
}

function validateStringArray(value, policy) {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
    throw invalidSchema(policy);
  }
}

function assertSchema(value, policy) {
  if (!(typeof value === "boolean" || isPlainObject(value))) throw invalidSchema(policy);
}

function assertImmutable(value, sessionMap, policy) {
  assertImmutableToolString(value, sessionMap, {
    protectedValueError: policy.protectedValueError,
    invalidValueError: policy.invalidSchemaError
  });
  policy.onImmutableString?.(value);
}

function assertDepth(depth, policy) {
  if (depth > policy.maxDepth) throw invalidSchema(policy);
}

function invalidSchema(policy) {
  return policy.invalidSchemaError();
}

function normalizePolicy(options) {
  const allowedTypes = options.allowedTypes instanceof Set
    ? options.allowedTypes
    : new Set(options.allowedTypes || []);
  if (allowedTypes.size === 0) throw new TypeError("Tool schema policy requires allowedTypes.");
  const maxDepth = Number(options.maxDepth ?? DEFAULT_MAX_DEPTH);
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new TypeError("Tool schema maxDepth must be a positive safe integer.");
  }
  return {
    allowedTypes,
    maxDepth,
    onImmutableString: typeof options.onImmutableString === "function"
      ? options.onImmutableString : null,
    annotationSlot: typeof options.annotationSlot === "function"
      ? options.annotationSlot
      : ({ path, value, trace }) => ({ path, value, schemaTrace: trace }),
    invalidSchemaError: typeof options.invalidSchemaError === "function"
      ? options.invalidSchemaError
      : () => policyError(
          "PRIVACYAI_INVALID_TOOL_SCHEMA",
          "PrivacyAI blocked an invalid tool schema."
        ),
    protectedValueError: typeof options.protectedValueError === "function"
      ? options.protectedValueError
      : () => policyError(
          "PRIVACYAI_TOOL_SCHEMA_IMMUTABLE_PROTECTED_VALUE",
          "PrivacyAI blocked protected data in immutable tool-schema structure."
        )
  };
}

function projectedFingerprint(schema) {
  return immutableToolStructureFingerprint(projectSchema(schema));
}

function projectSchema(value) {
  if (typeof value === "boolean") return value;
  const projection = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (ANNOTATION_KEYS.has(key) && typeof child === "string") projection[key] = "[annotation]";
    else if (SCHEMA_MAP_KEYS.has(key)) projection[key] = projectSchemaMap(child);
    else if (SCHEMA_ARRAY_KEYS.has(key)) projection[key] = child.map(projectSchema);
    else if (SCHEMA_VALUE_KEYS.has(key)) projection[key] = projectSchema(child);
    else if (key === "items") {
      projection[key] = Array.isArray(child) ? child.map(projectSchema) : projectSchema(child);
    } else if (key === "dependencies") projection[key] = projectDependencies(child);
    else projection[key] = immutableProjection(child);
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

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeLocation(path) {
  return path.map(escapePath).join("/");
}

function escapePath(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
