import { gatewayError } from "./gateway-error.js";
import {
  collectToolSchemaAnnotations,
  finalizeToolSchemaAnnotations
} from "./tool-schema-policy.js";

const CODEX_JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string"
]);

export function collectCodexJsonSchema(schema, path, sessionMap = {}) {
  return collectToolSchemaAnnotations(schema, path, sessionMap, {
    schemaKind: path.includes("parameters") ? "tool_parameters" : "text_format",
    allowedTypes: CODEX_JSON_SCHEMA_TYPES,
    invalidSchemaError,
    protectedValueError: immutableProtectedValueError,
    annotationSlot: ({ path: slotPath, value, trace }) => ({
      path: slotPath,
      value,
      schemaTrace: trace
    })
  });
}

export function finalizeCodexJsonSchemaTrace(schema, trace, resolvedSlots) {
  return finalizeToolSchemaAnnotations(schema, trace, resolvedSlots, {
    structureChangedError: () => gatewayError(
      "PRIVACYAI_CODEX_SCHEMA_STRUCTURE_CHANGED",
      "PrivacyAI blocked a JSON Schema whose protocol structure changed during transformation."
    )
  });
}

function invalidSchemaError() {
  return gatewayError(
    "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION",
    "PrivacyAI blocked an invalid Codex JSON Schema."
  );
}

function immutableProtectedValueError() {
  return gatewayError(
    "PRIVACYAI_CODEX_SCHEMA_IMMUTABLE_PROTECTED_VALUE",
    "PrivacyAI blocked a protected value in an immutable JSON Schema field."
  );
}
