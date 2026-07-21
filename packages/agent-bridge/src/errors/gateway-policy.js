import {
  createPrivacyError,
  isPrivacyError,
  privacyErrorPolicy
} from "@privacy-ai/sdk";

const SAFE_CODE_PATTERN = /^PRIVACYAI_[A-Z0-9_]{1,96}$/;

const PUBLIC_MESSAGES = Object.freeze({
  timeout: "PrivacyAI timed out waiting for the upstream Codex service.",
  dns: "PrivacyAI could not resolve the upstream Codex service.",
  upstream_reset: "PrivacyAI lost its connection to the upstream Codex service.",
  broken_pipe: "PrivacyAI lost its connection to the upstream Codex service.",
  upstream: "PrivacyAI lost its connection to the upstream Codex service.",
  protocol: "PrivacyAI could not safely process the upstream Codex response protocol.",
  local_model: "PrivacyAI could not complete local privacy classification.",
  request_limit: "PrivacyAI blocked an oversized Codex request.",
  client_cancelled: "Codex disconnected before PrivacyAI completed the request.",
  privacy_boundary: "PrivacyAI stopped this Codex request because its privacy boundary could not be verified.",
  storage: "PrivacyAI could not access required local storage.",
  internal: "PrivacyAI stopped this Codex request because an internal failure occurred.",
  gateway: "PrivacyAI stopped this Codex request because the local gateway failed."
});

const CODE_CATEGORIES = new Map([
  ["PRIVACYAI_LOCAL_MODEL_FAILURE", "local_model"],
  ["PRIVACYAI_CODEX_BODY_TOO_LARGE", "request_limit"],
  ["PRIVACYAI_CODEX_UPSTREAM_RESET", "upstream_reset"],
  ["PRIVACYAI_CODEX_UPSTREAM_TIMEOUT", "timeout"],
  ["PRIVACYAI_CODEX_UPSTREAM_BROKEN_PIPE", "broken_pipe"],
  ["PRIVACYAI_CODEX_UPSTREAM_DNS", "dns"],
  ["PRIVACYAI_CODEX_CLIENT_DISCONNECTED", "client_cancelled"],
  ["PRIVACYAI_CODEX_BODY_ABORTED", "client_cancelled"],
  ["PRIVACYAI_REQUEST_ABORTED", "client_cancelled"],
  ["PRIVACYAI_STORAGE_FAILURE", "storage"],
  ["PRIVACYAI_CONTEXT_DB_UNAVAILABLE", "privacy_boundary"],
  ["PRIVACYAI_CONTEXT_DB_WRITE_FAILED", "privacy_boundary"],
  ["PRIVACYAI_CONTEXT_DB_CLOSED", "privacy_boundary"],
  ["PRIVACYAI_CONTEXT_DB_SCHEMA_UNSUPPORTED", "privacy_boundary"],
  ["PRIVACYAI_CONTEXT_DB_SCHEMA_MIGRATION_REQUIRED", "privacy_boundary"],
  ["PRIVACYAI_CONTEXT_DB_CORRUPT", "privacy_boundary"],
  ["PRIVACYAI_CONTEXT_DB_RETRY_TIMEOUT", "privacy_boundary"],
  ["PRIVACYAI_SESSION_MAP_FILE_CORRUPT", "privacy_boundary"],
  ["PRIVACYAI_VAULT_CORRUPT", "privacy_boundary"],
  ["PRIVACYAI_VAULT_LOCK_TIMEOUT", "privacy_boundary"],
  ["PRIVACYAI_SERVER_CLOSE_TIMEOUT", "privacy_boundary"],
  ["PRIVACYAI_INTERNAL_FAILURE", "internal"],
  ["PRIVACYAI_CODEX_GATEWAY_FAILURE", "gateway"]
]);

const NETWORK_CODE_POLICIES = new Map([
  ["ECONNRESET", ["PRIVACYAI_CODEX_UPSTREAM_RESET", "upstream_reset"]],
  ["ETIMEDOUT", ["PRIVACYAI_CODEX_UPSTREAM_TIMEOUT", "timeout"]],
  ["EPIPE", ["PRIVACYAI_CODEX_UPSTREAM_BROKEN_PIPE", "broken_pipe"]],
  ["ENOTFOUND", ["PRIVACYAI_CODEX_UPSTREAM_DNS", "dns"]],
  ["EAI_AGAIN", ["PRIVACYAI_CODEX_UPSTREAM_DNS", "dns"]],
  ["EAI_FAIL", ["PRIVACYAI_CODEX_UPSTREAM_DNS", "dns"]],
  ["ENODATA", ["PRIVACYAI_CODEX_UPSTREAM_DNS", "dns"]],
  ["ESERVFAIL", ["PRIVACYAI_CODEX_UPSTREAM_DNS", "dns"]]
]);

const CODE_RULES = Object.freeze([
  [code => code.includes("_SSE"), "protocol"],
  [code => /^PRIVACYAI_CODEX_[A-Z0-9_]*(?:UPSTREAM|RESPONSE)[A-Z0-9_]*$/.test(code), "upstream"],
  [isKnownCodexBoundaryCode, "privacy_boundary"],
  [isKnownSdkBoundaryCode, "privacy_boundary"]
]);

export function createGatewayContractError(code, message, options = {}) {
  const normalizedCode = String(code || "");
  if (!SAFE_CODE_PATTERN.test(normalizedCode)) {
    throw new TypeError("PrivacyAI gateway errors require an internal error code.");
  }

  const opts = options ?? {};
  const resolved = gatewayCodePolicy(normalizedCode) || fallbackPolicy();
  return createPrivacyError({
    code: resolved.code,
    category: resolved.category,
    message: resolved.code === normalizedCode ? message : resolved.publicMessage,
    publicMessage: resolved.publicMessage,
    phase: opts.phase,
    status: resolved.status,
    retryable: resolved.retryable,
    cause: opts.cause,
    diagnostics: opts.diagnostics,
    name: "PrivacyError"
  });
}

export function normalizeGatewayContractError(error) {
  const exposedCode = gatewayIdentityCode(error);
  if (exposedCode) {
    const resolved = gatewayCodePolicy(exposedCode);
    if (resolved) return normalizedError(error, resolved);
    if (isPrivacyError(error) && PUBLIC_MESSAGES[error.category]) {
      return normalizedError(error, policy(exposedCode, error.category, {
        status: error.status,
        retryable: error.retryable,
        publicMessage: error.publicMessage
      }));
    }
  }

  if (error?.name === "ProviderError") {
    return normalizedError(error, policy("PRIVACYAI_LOCAL_MODEL_FAILURE", "local_model", {
      retryable: isPrivacyError(error) ? error.retryable : undefined
    }));
  }

  const networkPolicy = NETWORK_CODE_POLICIES.get(gatewayNetworkCode(error));
  if (networkPolicy) return normalizedError(error, policy(networkPolicy[0], networkPolicy[1]));

  return normalizedError(error, fallbackPolicy());
}

export function gatewayNetworkCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = String(current.code || "").toUpperCase();
    if (NETWORK_CODE_POLICIES.has(code)) return code;
    current = current.cause;
  }
  return "NONE";
}

function normalizedError(error, resolved) {
  if (
    isPrivacyError(error) &&
    error.code === resolved.code &&
    error.category === resolved.category &&
    error.status === resolved.status &&
    error.retryable === resolved.retryable &&
    error.publicMessage === resolved.publicMessage
  ) {
    return error;
  }
  return createPrivacyError({
    code: resolved.code,
    category: resolved.category,
    message: resolved.publicMessage,
    publicMessage: resolved.publicMessage,
    phase: isPrivacyError(error) ? error.phase : undefined,
    status: resolved.status,
    retryable: resolved.retryable,
    cause: error,
    diagnostics: isPrivacyError(error) ? error.diagnostics : undefined,
    name: "PrivacyError"
  });
}

function gatewayCodePolicy(code) {
  const exactCategory = CODE_CATEGORIES.get(code);
  if (exactCategory) return policy(code, exactCategory);
  for (const [matches, category] of CODE_RULES) {
    if (matches(code)) return policy(code, category);
  }
  return null;
}

function fallbackPolicy() {
  return policy("PRIVACYAI_CODEX_GATEWAY_FAILURE", "gateway");
}

function policy(code, category, overrides = {}) {
  const defaults = privacyErrorPolicy(category);
  return Object.freeze({
    code,
    category,
    status: gatewayStatus(category, overrides.status ?? defaults.status),
    retryable: overrides.retryable ?? defaults.retryable,
    publicMessage: PUBLIC_MESSAGES[category] || overrides.publicMessage || PUBLIC_MESSAGES.gateway
  });
}

function gatewayStatus(category, fallback) {
  if (category === "request_limit") return 413;
  if (category === "privacy_boundary") return 422;
  if (category === "timeout") return 504;
  if (category === "storage" || category === "internal") return fallback;
  return 502;
}

function gatewayIdentityCode(error) {
  const exposedCode = safePrivacyCode(error?.code);
  if (!isPrivacyError(error) || !exposedCode) return exposedCode;

  const exposedPolicy = gatewayCodePolicy(exposedCode);
  if (exposedPolicy?.category === "client_cancelled") return exposedCode;
  return safePrivacyCode(error.contractCode) || exposedCode;
}

function safePrivacyCode(value) {
  const code = String(value || "");
  return SAFE_CODE_PATTERN.test(code) ? code : null;
}

function isKnownCodexBoundaryCode(code) {
  return /^PRIVACYAI_CODEX_(?:ANIMATED_IMAGE|BODY_TRUNCATED|CAPTURE_[A-Z0-9_]+|CONFLICTING_[A-Z0-9_]+|EXECUTABLE_BROKEN|IDENTIFIER_[A-Z0-9_]+|IMAGE_[A-Z0-9_]+|INCOMPLETE_TOOL_[A-Z0-9_]+|INVALID_[A-Z0-9_]+|MISSING_[A-Z0-9_]+|MODE|SCHEMA_[A-Z0-9_]+|SESSION_[A-Z0-9_]+|STREAM_REQUIRED|TOOL_[A-Z0-9_]+|TOO_MANY_[A-Z0-9_]+|UNIDENTIFIED_[A-Z0-9_]+|UNSUPPORTED_[A-Z0-9_]+)$/.test(code);
}

function isKnownSdkBoundaryCode(code) {
  return /^PRIVACYAI_(?:AMBIGUOUS_(?:SESSION_MAP|TEXT_EDIT)|CONTEXT_TOO_LARGE|DUMMY_ALLOCATION_EXHAUSTED|IMAGE_[A-Z0-9_]+|IMMUTABLE_TOOL_STRUCTURE_PROTECTED_VALUE|INVALID_(?:CLASSIFIER_SPAN|SANITIZED_CONTEXT|SESSION_MAP|TEXT_EDIT|TEXT_EDITS|TOOL_SCHEMA)|OVERLAPPING_TEXT_EDITS|PROVIDER_PAYLOAD_LEAK|SESSION_MAP_COLLISION|TEXT_EDIT_[A-Z0-9_]+|TOO_MANY_TEXT_EDITS|TOOL_SCHEMA_[A-Z0-9_]+|TRANSFORM_KEY_COLLISION|UNRESTORABLE_MODEL_IDENTIFIER|WHOLE_DOCUMENT_EDIT)$/.test(code);
}
