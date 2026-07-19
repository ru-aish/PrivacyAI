import { randomUUID } from "node:crypto";
import { normalizeSessionMap } from "@privacy-ai/sdk";

import { stableJson } from "../context-repository/domain.js";

export const LINEAGE_EVENT_TYPES = Object.freeze([
  "session_created",
  "value_protected",
  "value_derived",
  "placeholder_assigned",
  "transformation",
  "provider_request",
  "provider_response",
  "cache_hit",
  "cache_miss",
  "cache_write",
  "restoration",
  "reveal"
]);
export const LINEAGE_REASON_CODES = Object.freeze([
  "session_start",
  "session_resume",
  "session_fork",
  "policy_match",
  "detector_match",
  "derived_value",
  "transformation_output",
  "identity_assigned",
  "identity_reused",
  "policy_application",
  "sanitization",
  "redaction",
  "image_masking",
  "cache_lookup",
  "cache_write",
  "cache_refresh",
  "provider_dispatch",
  "provider_retry",
  "provider_completion",
  "provider_failure",
  "local_restoration",
  "response_restore",
  "explicit_reveal"
]);
const EVENT_TYPES = new Set(LINEAGE_EVENT_TYPES);
const REASON_CODES = new Set(LINEAGE_REASON_CODES);
const VALUE_ORIGIN_TYPES = new Set(["value_protected", "value_derived"]);
const INPUT_FIELDS = new Set([
  "schemaVersion",
  "eventId",
  "sessionId",
  "eventType",
  "occurredAt",
  "parentEventId",
  "parentValueId",
  "valueId",
  "placeholderId",
  "placeholder",
  "provider",
  "operation",
  "model",
  "artifactType",
  "phase",
  "policyRef",
  "transformation",
  "transformationRef",
  "requestRef",
  "responseRef",
  "restorationRef",
  "cacheRef",
  "reasonCode",
  "diagnosticCode",
  "metadata"
]);
const OPAQUE_ID = /^[a-z][a-z0-9_-]{0,31}:(?:[0-9a-f]{32,128}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{43,172})$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REASON_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const DIAGNOSTIC_CODE = /^PRIVACYAI_[A-Z0-9_]{1,96}$/;
const INTEGER_METADATA = new Set([
  "attempt",
  "retryCount",
  "durationMs",
  "itemCount",
  "byteLength",
  "restoredCount"
]);
const BOOLEAN_METADATA = new Set([
  "cacheHit",
  "streaming",
  "success",
  "partial"
]);
const PLACEHOLDER_SENTINEL = "__privacyai_lineage_placeholder_validation_original__";

export const LINEAGE_SCHEMA_VERSION = 1;
export { stableJson };

export function createLineageId(namespace) {
  if (typeof namespace !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(namespace)) {
    throw lineageInputError("Lineage identity namespace is invalid.");
  }
  return `${namespace}:${randomUUID()}`;
}

export function normalizeEvent(input = {}, options = {}) {
  assertPlainObject(input, "Lineage events must be plain objects.");
  rejectUnknownFields(input, INPUT_FIELDS, "Lineage event");

  if (input.schemaVersion != null && Number(input.schemaVersion) !== LINEAGE_SCHEMA_VERSION) {
    throw lineageInputError("Lineage event schemaVersion is unsupported.");
  }

  const eventType = requiredEventType(input.eventType);
  const event = {
    schemaVersion: LINEAGE_SCHEMA_VERSION,
    eventId: input.eventId == null
      ? createLineageId("event")
      : opaqueIdentity(input.eventId, "eventId"),
    sessionId: opaqueIdentity(input.sessionId, "sessionId"),
    eventType,
    occurredAt: timestamp(input.occurredAt, options.now),
    recordedAt: options.recordedAt == null
      ? null
      : requiredNonNegativeInteger(options.recordedAt, "recordedAt"),
    parentEventId: optionalOpaqueIdentity(input.parentEventId, "parentEventId"),
    parentValueId: optionalOpaqueIdentity(input.parentValueId, "parentValueId"),
    valueId: optionalOpaqueIdentity(input.valueId, "valueId"),
    placeholderId: optionalOpaqueIdentity(input.placeholderId, "placeholderId"),
    placeholder: normalizePublicPlaceholder(input.placeholder),
    provider: optionalToken(input.provider, "provider"),
    operation: optionalToken(input.operation, "operation"),
    model: optionalToken(input.model, "model"),
    artifactType: optionalToken(input.artifactType, "artifactType"),
    phase: optionalToken(input.phase, "phase"),
    policyRef: optionalOpaqueIdentity(input.policyRef, "policyRef"),
    transformation: optionalToken(input.transformation, "transformation"),
    transformationRef: optionalOpaqueIdentity(input.transformationRef, "transformationRef"),
    requestRef: optionalOpaqueIdentity(input.requestRef, "requestRef"),
    responseRef: optionalOpaqueIdentity(input.responseRef, "responseRef"),
    restorationRef: optionalOpaqueIdentity(input.restorationRef, "restorationRef"),
    cacheRef: optionalOpaqueIdentity(input.cacheRef, "cacheRef"),
    reasonCode: requiredReasonCode(input.reasonCode),
    diagnosticCode: optionalDiagnosticCode(input.diagnosticCode),
    metadata: normalizeMetadata(input.metadata)
  };

  validateEventShape(event);
  return freezeEvent(event);
}

export function parseStoredEvent(row) {
  try {
    const metadata = JSON.parse(row.metadata_json);
    const event = normalizeEvent({
      schemaVersion: Number(row.schema_version),
      eventId: row.event_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      occurredAt: Number(row.occurred_at),
      parentEventId: row.parent_event_id,
      parentValueId: row.parent_value_id,
      valueId: row.value_id,
      placeholderId: row.placeholder_id,
      placeholder: row.placeholder,
      provider: row.provider,
      operation: row.operation,
      model: row.model,
      artifactType: row.artifact_type,
      phase: row.phase,
      policyRef: row.policy_ref,
      transformation: row.transformation,
      transformationRef: row.transformation_ref,
      requestRef: row.request_ref,
      responseRef: row.response_ref,
      restorationRef: row.restoration_ref,
      cacheRef: row.cache_ref,
      reasonCode: row.reason_code,
      diagnosticCode: row.diagnostic_code,
      metadata
    }, { recordedAt: Number(row.recorded_at), now: Number(row.occurred_at) });

    if (stableJson(event.metadata) !== row.metadata_json) throw new Error("non-canonical metadata");
    return event;
  } catch {
    throw lineageError(
      "PRIVACYAI_LINEAGE_CORRUPT",
      "PrivacyAI lineage storage contains an invalid event record."
    );
  }
}

export function normalizeMetadata(value = {}) {
  assertPlainObject(value, "Lineage metadata must be a plain object.");
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (INTEGER_METADATA.has(key)) {
      output[key] = requiredNonNegativeInteger(item, `metadata.${key}`);
      continue;
    }
    if (BOOLEAN_METADATA.has(key) && typeof item === "boolean") {
      output[key] = item;
      continue;
    }
    throw lineageInputError(`Lineage metadata field ${key} is not allowed.`);
  }
  return Object.freeze(output);
}

export function opaqueIdentity(value, name = "identity") {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw lineageInputError(`${name} must be a namespaced opaque identity.`);
  }
  return value;
}

export function isValueOriginEvent(eventType) {
  return VALUE_ORIGIN_TYPES.has(eventType);
}

function requiredEventType(value) {
  if (!EVENT_TYPES.has(value)) throw lineageInputError("Lineage event type is not supported.");
  return value;
}

function timestamp(value, now) {
  const candidate = value == null
    ? (typeof now === "function" ? now() : now ?? Date.now())
    : value;
  return requiredNonNegativeInteger(candidate, "occurredAt");
}

function requiredNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw lineageInputError(`${name} must be a non-negative safe integer.`);
  }
  return number;
}

function optionalOpaqueIdentity(value, name) {
  return value == null ? null : opaqueIdentity(value, name);
}

function optionalToken(value, name) {
  if (value == null) return null;
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw lineageInputError(`${name} must be a bounded non-sensitive token.`);
  }
  return value;
}

function requiredReasonCode(value) {
  if (typeof value !== "string" || !REASON_CODE.test(value) || !REASON_CODES.has(value)) {
    throw lineageInputError("reasonCode is not supported by the lineage contract.");
  }
  return value;
}

function optionalDiagnosticCode(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !DIAGNOSTIC_CODE.test(value)) {
    throw lineageInputError("diagnosticCode must be a PrivacyAI error code.");
  }
  return value;
}

function normalizePublicPlaceholder(value) {
  if (value == null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw lineageInputError("placeholder must satisfy the SDK public placeholder contract.");
  }

  try {
    const map = Object.create(null);
    Object.defineProperty(map, value, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: PLACEHOLDER_SENTINEL
    });
    const normalized = normalizeSessionMap(map);
    if (Object.keys(normalized).length !== 1 || normalized[value] !== PLACEHOLDER_SENTINEL) {
      throw new Error("invalid placeholder");
    }
  } catch {
    throw lineageInputError("placeholder must satisfy the SDK public placeholder contract.");
  }
  return value;
}

function validateEventShape(event) {
  if (event.eventType !== "session_created" && event.parentEventId == null) {
    throw lineageInputError(`${event.eventType} requires parentEventId.`);
  }

  switch (event.eventType) {
    case "session_created":
      forbid(event, ["valueId", "parentValueId", "placeholderId", "placeholder"], "session_created");
      break;
    case "value_protected":
      requireFields(event, ["valueId"]);
      forbid(event, ["parentValueId"], "value_protected");
      if (!event.policyRef && !event.transformation) {
        throw lineageInputError("value_protected requires policyRef or transformation.");
      }
      break;
    case "value_derived":
      requireFields(event, ["valueId", "parentValueId", "transformation"]);
      break;
    case "placeholder_assigned":
      requireFields(event, ["valueId", "placeholderId", "placeholder"]);
      break;
    case "transformation":
      requireFields(event, ["valueId", "transformation"]);
      break;
    case "provider_request":
      requireFields(event, ["provider", "operation", "requestRef"]);
      break;
    case "provider_response":
      requireFields(event, ["parentEventId", "provider", "requestRef", "responseRef"]);
      break;
    case "cache_hit":
    case "cache_miss":
    case "cache_write":
      requireFields(event, ["cacheRef", "operation"]);
      break;
    case "restoration":
    case "reveal":
      requireFields(event, ["parentEventId", "restorationRef"]);
      if (!event.valueId && !event.placeholderId) {
        throw lineageInputError(`${event.eventType} requires valueId or placeholderId.`);
      }
      break;
    default:
      throw lineageInputError("Lineage event type is not supported.");
  }

  if (event.placeholder != null && event.placeholderId == null) {
    throw lineageInputError("placeholder requires placeholderId.");
  }
}

function requireFields(event, fields) {
  const missing = fields.find(field => event[field] == null);
  if (missing) throw lineageInputError(`${event.eventType} requires ${missing}.`);
}

function forbid(event, fields, eventType) {
  const present = fields.find(field => event[field] != null);
  if (present) throw lineageInputError(`${eventType} does not allow ${present}.`);
}

function rejectUnknownFields(value, allowed, label) {
  const field = Object.keys(value).find(key => !allowed.has(key));
  if (field) throw lineageInputError(`${label} field ${field} is not allowed.`);
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw lineageInputError(message);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw lineageInputError(message);
}

function freezeEvent(event) {
  return Object.freeze({ ...event, metadata: Object.freeze({ ...event.metadata }) });
}

export function lineageError(code, message, cause) {
  const safeCause = sqliteContentionCause(cause);
  const error = new Error(message, safeCause ? { cause: safeCause } : undefined);
  error.code = code;
  return error;
}

export function lineageInputError(message) {
  return lineageError("PRIVACYAI_LINEAGE_INVALID_EVENT", message);
}

function sqliteContentionCause(cause) {
  const code = String(cause?.code || "").toUpperCase();
  const message = String(cause?.message || "").toLowerCase();
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    code === "ERR_SQLITE_BUSY" ||
    code === "ERR_SQLITE_LOCKED" ||
    (code === "ERR_SQLITE_ERROR" && message.includes("locked"))
  ) {
    const safe = new Error("SQLite contention prevented the local lineage operation.");
    safe.code = message.includes("locked") ? "SQLITE_LOCKED" : "SQLITE_BUSY";
    return safe;
  }
  return undefined;
}
