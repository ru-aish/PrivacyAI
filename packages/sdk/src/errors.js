const ERROR_CODE_PATTERN = /^PRIVACYAI_[A-Z0-9_]{1,96}$/;

const CATEGORY_POLICIES = Object.freeze({
  internal: policy(500, false, "PrivacyAI encountered an internal failure."),
  gateway: policy(502, false, "PrivacyAI could not complete the local gateway request."),
  client_cancelled: policy(499, false, "PrivacyAI stopped the request because the client disconnected."),
  timeout: policy(504, true, "PrivacyAI timed out while completing the request."),
  dns: policy(502, true, "PrivacyAI could not resolve the upstream service."),
  upstream_reset: policy(502, true, "PrivacyAI lost its upstream connection."),
  broken_pipe: policy(502, true, "PrivacyAI lost its upstream connection."),
  upstream: policy(502, true, "PrivacyAI could not complete the upstream request."),
  protocol: policy(502, false, "PrivacyAI could not safely process the upstream protocol."),
  request_limit: policy(413, false, "PrivacyAI blocked a request that exceeded a configured limit."),
  local_model: policy(502, true, "PrivacyAI could not complete local privacy classification."),
  storage: policy(500, false, "PrivacyAI could not access required local storage."),
  privacy_boundary: policy(422, false, "PrivacyAI stopped the request because its privacy boundary could not be verified.")
});

const ERROR_PHASES = new Set([
  "request",
  "classification",
  "sanitization",
  "restoration",
  "upstream_connect",
  "upstream_response",
  "sse",
  "storage_read",
  "storage_write",
  "startup",
  "runtime"
]);

const NETWORK_CODES = new Set([
  "NONE",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ESERVFAIL"
]);

const DIAGNOSTIC_FIELDS = Object.freeze({
  networkCode: value => normalizedEnum(value, NETWORK_CODES, "diagnostic networkCode"),
  retryCount: value => boundedInteger(value, 0, 99, "diagnostic retryCount"),
  attempt: value => boundedInteger(value, 0, 99, "diagnostic attempt"),
  downstreamClosed: value => requiredBoolean(value, "diagnostic downstreamClosed"),
  timeoutMs: value => boundedInteger(value, 1, 86_400_000, "diagnostic timeoutMs"),
  statusCode: value => boundedInteger(value, 100, 599, "diagnostic statusCode")
});

export class PrivacyError extends Error {
  constructor(message, options = {}) {
    const requestedCategory = String(options.category || "internal");
    const hasCategoryPolicy = Object.hasOwn(CATEGORY_POLICIES, requestedCategory);
    const category = hasCategoryPolicy ? requestedCategory : "internal";
    const categoryPolicy = CATEGORY_POLICIES[category];
    const cause = options.cause;
    super(normalizedMessage(message, categoryPolicy.publicMessage), cause === undefined ? undefined : { cause });

    const contractCode = normalizedErrorCode(options.code);
    if (options.exposeCode !== false) this.code = contractCode;

    Object.defineProperties(this, {
      name: mutableHiddenValue(normalizedErrorName(options.name, "PrivacyError")),
      contractCode: hiddenValue(contractCode),
      category: hiddenValue(category),
      phase: hiddenValue(normalizedPhase(options.phase)),
      status: hiddenValue(hasCategoryPolicy
        ? normalizedStatus(options.status, categoryPolicy.status)
        : categoryPolicy.status),
      retryable: hiddenValue(hasCategoryPolicy
        ? normalizedRetryable(options.retryable, categoryPolicy.retryable)
        : categoryPolicy.retryable),
      publicMessage: hiddenValue(hasCategoryPolicy
        ? normalizedPublicMessage(options.publicMessage, categoryPolicy.publicMessage)
        : categoryPolicy.publicMessage),
      diagnostics: hiddenValue(sanitizePrivacyDiagnostics(options.diagnostics))
    });
  }
}

export function createPrivacyError(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError("PrivacyAI error options must be a plain object.");
  }
  return new PrivacyError(options.message, options);
}

export function isPrivacyError(error) {
  return error instanceof PrivacyError;
}

export function privacyErrorPolicy(category) {
  const normalized = normalizedCategory(category);
  return CATEGORY_POLICIES[normalized];
}

export function sanitizePrivacyDiagnostics(metadata = undefined) {
  if (metadata == null) return Object.freeze({});
  if (!isPlainObject(metadata)) {
    throw new TypeError("PrivacyAI diagnostic metadata must be a plain object.");
  }

  const sanitized = {};
  for (const [field, value] of Object.entries(metadata)) {
    const sanitize = DIAGNOSTIC_FIELDS[field];
    if (!sanitize) {
      throw new TypeError(`PrivacyAI diagnostic metadata does not allow ${field}.`);
    }
    sanitized[field] = sanitize(value);
  }
  return Object.freeze(sanitized);
}

export function serializePrivacyError(error) {
  if (!isPrivacyError(error) || !Object.hasOwn(CATEGORY_POLICIES, error.category)) {
    return genericSerializedError();
  }

  const categoryPolicy = CATEGORY_POLICIES[error.category];
  return {
    code: normalizedSerializedCode(error.contractCode),
    category: error.category,
    phase: ERROR_PHASES.has(error.phase) ? error.phase : null,
    status: normalizedStatus(error.status, categoryPolicy.status),
    retryable: normalizedRetryable(error.retryable, categoryPolicy.retryable),
    message: normalizedPublicMessage(error.publicMessage, categoryPolicy.publicMessage),
    diagnostics: { ...sanitizePrivacyDiagnostics(error.diagnostics) }
  };
}

export class PrivacyGuardianError extends PrivacyError {
  constructor(message, details = undefined, options = {}) {
    super(message, {
      ...options,
      code: options.code || "PRIVACYAI_PRIVACY_GUARDIAN_FAILURE",
      category: options.category || "privacy_boundary",
      cause: options.cause === undefined ? diagnosticCause(details) : options.cause,
      exposeCode: options.exposeCode === true,
      name: options.name || "PrivacyGuardianError"
    });
    this.details = details;
  }
}

export class ProviderError extends PrivacyGuardianError {
  constructor(message, details = undefined, options = {}) {
    const status = providerStatus(message, details);
    super(message, details, {
      ...options,
      code: options.code || "PRIVACYAI_LOCAL_MODEL_FAILURE",
      category: "local_model",
      status: options.status ?? status ?? CATEGORY_POLICIES.local_model.status,
      retryable: options.retryable ?? providerRetryable(message, details, status),
      publicMessage: options.publicMessage || CATEGORY_POLICIES.local_model.publicMessage,
      name: "ProviderError"
    });
  }
}

function policy(status, retryable, publicMessage) {
  return Object.freeze({ status, retryable, publicMessage });
}

function hiddenValue(value) {
  return { value, enumerable: false };
}

function mutableHiddenValue(value) {
  return { value, enumerable: false, writable: true, configurable: true };
}

function normalizedErrorCode(value) {
  const code = String(value || "");
  if (!ERROR_CODE_PATTERN.test(code)) {
    throw new TypeError("PrivacyAI errors require a stable PRIVACYAI_* code.");
  }
  return code;
}

function normalizedCategory(value) {
  const category = String(value || "internal");
  return CATEGORY_POLICIES[category] ? category : "internal";
}

function normalizedPhase(value) {
  if (value == null) return null;
  const phase = String(value);
  if (!ERROR_PHASES.has(phase)) {
    throw new TypeError("PrivacyAI errors require an allowlisted lifecycle phase.");
  }
  return phase;
}

function normalizedStatus(value, fallback) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : fallback;
}

function normalizedRetryable(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizedMessage(value, fallback) {
  return typeof value === "string" && value ? value : fallback;
}

function normalizedPublicMessage(value, fallback) {
  if (typeof value !== "string" || !value || value.length > 500) return fallback;
  return value;
}

function normalizedErrorName(value, fallback) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : fallback;
}

function normalizedEnum(value, allowed, label) {
  const normalized = String(value || "").toUpperCase();
  if (!allowed.has(normalized)) throw new TypeError(`PrivacyAI ${label} is not allowlisted.`);
  return normalized;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`PrivacyAI ${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`PrivacyAI ${label} must be boolean.`);
  return value;
}

function normalizedSerializedCode(value) {
  const code = String(value || "");
  return ERROR_CODE_PATTERN.test(code) ? code : "PRIVACYAI_INTERNAL_FAILURE";
}

function genericSerializedError() {
  const policy = CATEGORY_POLICIES.internal;
  return {
    code: "PRIVACYAI_INTERNAL_FAILURE",
    category: "internal",
    phase: null,
    status: policy.status,
    retryable: policy.retryable,
    message: policy.publicMessage,
    diagnostics: {}
  };
}

function providerStatus(message, details) {
  const explicit = Number(details?.status);
  if (Number.isInteger(explicit) && explicit >= 100 && explicit <= 599) return explicit;
  const match = String(message || "").match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function providerRetryable(message, details, status) {
  if (Number.isInteger(status)) return status >= 500 && status <= 599;
  const text = String(message || "");
  if (/(?:request failed|request timed out|returned non-JSON response)/i.test(text)) return true;
  return /response did not include (?:choices\[0\]\.message\.content|message\.content)/i.test(text) &&
    details?.error != null;
}

function diagnosticCause(details) {
  if (details instanceof Error) return details;
  return details?.error instanceof Error ? details.error : undefined;
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
