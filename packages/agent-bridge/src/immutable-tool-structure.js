import { createHash } from "node:crypto";

import { RegexDetector } from "@privacy-ai/sdk";

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
 * Executable tool structures are immutable by default. Adapters may expose
 * explicitly documented prose annotations as sanitizer slots, but grammar,
 * schema identifiers, protocol constants, and unknown future fields must pass
 * through byte-for-byte or fail closed when they contain protected data.
 */
export function assertImmutableToolStructure(value, sessionMap = {}, options = {}) {
  walk(value, sessionMap, options, 0);
  return value;
}

export function assertImmutableToolString(value, sessionMap = {}, options = {}) {
  if (typeof value !== "string") throw invalidValue(options);
  assertUnprotectedString(value, sessionMap, options);
  return value;
}

export function immutableToolStructureFingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function walk(value, sessionMap, options, depth) {
  const maxDepth = Number(options.maxDepth ?? 64);
  if (!Number.isSafeInteger(maxDepth) || maxDepth <= 0) {
    throw new TypeError("maxDepth must be a positive safe integer.");
  }
  if (depth > maxDepth) throw invalidValue(options);

  if (typeof value === "string") {
    assertUnprotectedString(value, sessionMap, options);
    return;
  }
  if (value == null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidValue(options);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(entry => walk(entry, sessionMap, options, depth + 1));
    return;
  }
  if (!isPlainObject(value)) throw invalidValue(options);

  for (const [key, child] of Object.entries(value)) {
    assertUnprotectedString(key, sessionMap, options);
    walk(child, sessionMap, options, depth + 1);
  }
}

function assertUnprotectedString(value, sessionMap, options) {
  const normalized = value.toLocaleLowerCase("en-US");
  for (const original of Object.values(sessionMap || {})) {
    if (
      typeof original === "string" &&
      original.length > 0 &&
      normalized.includes(original.toLocaleLowerCase("en-US"))
    ) {
      throw protectedValue(options);
    }
  }
  if (
    IMMUTABLE_SECRET_DETECTOR
      .detect(value)
      .some(detection => IMMUTABLE_SECRET_TYPES.has(detection.type))
  ) {
    throw protectedValue(options);
  }
}

function protectedValue(options) {
  if (typeof options.protectedValueError === "function") return options.protectedValueError();
  const error = new Error("PrivacyAI blocked protected data in immutable tool structure.");
  error.code = "PRIVACYAI_IMMUTABLE_TOOL_STRUCTURE_PROTECTED_VALUE";
  return error;
}

function invalidValue(options) {
  if (typeof options.invalidValueError === "function") return options.invalidValueError();
  const error = new Error("PrivacyAI blocked invalid immutable tool structure.");
  error.code = "PRIVACYAI_INVALID_IMMUTABLE_TOOL_STRUCTURE";
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
