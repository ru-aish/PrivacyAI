import {
  collectToolSchemaAnnotations,
  finalizeToolSchemaAnnotations
} from "./tool-schema-policy.js";

const AGY_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
  "ARRAY",
  "BOOLEAN",
  "INTEGER",
  "NULL",
  "NUMBER",
  "OBJECT",
  "STRING",
  "TYPE_UNSPECIFIED"
]);

export function collectAgyToolSchema(schema, path, sessionMap = {}, schemaKind = "tool_schema") {
  return collectToolSchemaAnnotations(schema, path, sessionMap, {
    schemaKind,
    allowedTypes: AGY_SCHEMA_TYPES,
    invalidSchemaError,
    protectedValueError: immutableProtectedValueError,
    annotationSlot: ({ path: slotPath, value, trace }) => ({
      path: slotPath,
      value,
      slotKey: safeLocation(slotPath),
      artifactKey: "tool_schema_annotations",
      artifactType: "tool_definition",
      schemaTrace: trace
    })
  });
}

export function finalizeAgyToolSchemaTrace(schema, trace, resolvedSlots) {
  return finalizeToolSchemaAnnotations(schema, trace, resolvedSlots, {
    structureChangedError: () => policyError(
      "PRIVACYAI_AGY_TOOL_STRUCTURE_CHANGED",
      "PrivacyAI blocked an AGY tool schema whose protocol structure changed during transformation."
    )
  });
}

function immutableProtectedValueError() {
  return policyError(
    "PRIVACYAI_AGY_TOOL_STRUCTURE_IMMUTABLE_PROTECTED_VALUE",
    "PrivacyAI blocked protected data in an immutable AGY tool-schema field."
  );
}

function invalidSchemaError() {
  return policyError(
    "PRIVACYAI_AGY_INVALID_TOOLS",
    "PrivacyAI blocked an invalid AGY tool schema."
  );
}

function safeLocation(path) {
  return path
    .map(value => String(value).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
}

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
