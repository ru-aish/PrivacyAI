const GATEWAY_ERROR_MARKER = Symbol("privacyai.gateway.error");
const SAFE_CODE_PATTERN = /^PRIVACYAI_[A-Z0-9_]{1,96}$/;
const SAFE_PHASES = new Set(["request", "upstream_connect", "upstream_response", "sse"]);
const SAFE_ROUTES = new Set(["responses", "responses_compact", "models", "gateway"]);
const SAFE_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA", "ESERVFAIL"]);

export function gatewayError(code, message) {
  if (!SAFE_CODE_PATTERN.test(String(code || ""))) {
    throw new TypeError("PrivacyAI gateway errors require an internal error code.");
  }
  const error = new Error(message);
  error.code = code;
  error[GATEWAY_ERROR_MARKER] = true;
  return error;
}

export function publicGatewayFailure(error) {
  const code = internalGatewayCode(error) || providerFailureCode(error) || "PRIVACYAI_CODEX_GATEWAY_FAILURE";
  return {
    code,
    category: gatewayFailureCategory(code)
  };
}

export function safeGatewayDiagnostic(error, options = {}) {
  const failure = publicGatewayFailure(error);
  return {
    timestamp: new Date(safeDiagnosticTime(options.now)).toISOString(),
    route: SAFE_ROUTES.has(options.route) ? options.route : "gateway",
    phase: SAFE_PHASES.has(options.phase) ? options.phase : "request",
    networkCode: safeNetworkCode(error),
    retryCount: safeRetryCount(options.retryCount),
    downstreamClosed: options.downstreamClosed === true,
    code: failure.code,
    category: failure.category
  };
}

export function createGatewayDiagnosticReporter(callback, options = {}) {
  const seen = new Map();
  const maxEntries = boundedPositiveInteger(options.maxEntries, 256);
  const windowMs = boundedPositiveInteger(options.windowMs, 30_000);
  const now = typeof options.now === "function" ? options.now : Date.now;
  return (error, metadata = {}) => {
    if (isClientDisconnected(error)) return false;
    let diagnostic;
    try {
      const timestamp = safeDiagnosticTimeFromClock(now);
      diagnostic = safeGatewayDiagnostic(error, { ...metadata, now: timestamp });
      const key = [diagnostic.route, diagnostic.phase, diagnostic.networkCode, diagnostic.retryCount,
        diagnostic.downstreamClosed, diagnostic.code, diagnostic.category].join("|");
      for (const [candidate, last] of seen) {
        if (timestamp - last >= windowMs || timestamp < last) seen.delete(candidate);
      }
      if (seen.has(key)) return false;
      while (seen.size >= maxEntries) seen.delete(seen.keys().next().value);
      seen.set(key, timestamp);
    } catch {
      // Diagnostics are observational and must never replace the gateway error.
      return false;
    }
    try { callback?.(diagnostic); } catch { /* diagnostics are observational */ }
    return true;
  };
}

function internalGatewayCode(error) {
  if (error?.[GATEWAY_ERROR_MARKER] !== true) return null;
  const code = String(error.code || "");
  return SAFE_CODE_PATTERN.test(code) ? code : null;
}

function providerFailureCode(error) {
  if (error?.name === "ProviderError") return "PRIVACYAI_LOCAL_MODEL_FAILURE";
  switch (safeNetworkCode(error)) {
    case "ECONNRESET": return "PRIVACYAI_CODEX_UPSTREAM_RESET";
    case "ETIMEDOUT": return "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT";
    case "EPIPE": return "PRIVACYAI_CODEX_UPSTREAM_BROKEN_PIPE";
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_FAIL":
    case "ENODATA":
    case "ESERVFAIL": return "PRIVACYAI_CODEX_UPSTREAM_DNS";
    default: return null;
  }
}

function gatewayFailureCategory(code) {
  if (code === "PRIVACYAI_LOCAL_MODEL_FAILURE") return "local_model";
  if (code === "PRIVACYAI_CODEX_BODY_TOO_LARGE") return "request_limit";
  if (code === "PRIVACYAI_CODEX_UPSTREAM_RESET") return "upstream_reset";
  if (code === "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT") return "timeout";
  if (code === "PRIVACYAI_CODEX_UPSTREAM_BROKEN_PIPE") return "broken_pipe";
  if (code === "PRIVACYAI_CODEX_UPSTREAM_DNS") return "dns";
  if (/_(?:UPSTREAM|SSE|RESPONSE)/.test(code)) return "upstream";
  if (/(?:DISCONNECTED|ABORTED|CANCELLED)/.test(code)) return "client_cancelled";
  if (code === "PRIVACYAI_CODEX_GATEWAY_FAILURE") return "gateway";
  return "privacy_boundary";
}

function safeNetworkCode(error) {
  const code = String(error?.code || "").toUpperCase();
  return SAFE_NETWORK_CODES.has(code) ? code : "NONE";
}

function safeRetryCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 99 ? value : 0;
}

function safeDiagnosticTime(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function safeDiagnosticTimeFromClock(clock) {
  try {
    return safeDiagnosticTime(clock());
  } catch {
    return Date.now();
  }
}

function boundedPositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 && value <= 10_000 ? value : fallback;
}

function isClientDisconnected(error) {
  return error?.code === "PRIVACYAI_CODEX_CLIENT_DISCONNECTED" ||
    error?.code === "PRIVACYAI_REQUEST_ABORTED";
}
