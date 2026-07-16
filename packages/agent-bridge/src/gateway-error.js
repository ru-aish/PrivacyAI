const GATEWAY_ERROR_MARKER = Symbol("privacyai.gateway.error");
const SAFE_CODE_PATTERN = /^PRIVACYAI_[A-Z0-9_]{1,96}$/;
const SAFE_PHASES = new Set(["request", "sse"]);

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

export function safeGatewayDiagnostic(error, phase) {
  const failure = publicGatewayFailure(error);
  return {
    phase: SAFE_PHASES.has(phase) ? phase : "request",
    code: failure.code,
    category: failure.category
  };
}

function internalGatewayCode(error) {
  if (error?.[GATEWAY_ERROR_MARKER] !== true) return null;
  const code = String(error.code || "");
  return SAFE_CODE_PATTERN.test(code) ? code : null;
}

function providerFailureCode(error) {
  return error?.name === "ProviderError" ? "PRIVACYAI_LOCAL_MODEL_FAILURE" : null;
}

function gatewayFailureCategory(code) {
  if (code === "PRIVACYAI_LOCAL_MODEL_FAILURE") return "local_model";
  if (code === "PRIVACYAI_CODEX_BODY_TOO_LARGE") return "request_limit";
  if (/_(?:UPSTREAM|SSE|RESPONSE)/.test(code)) return "upstream";
  if (/(?:DISCONNECTED|ABORTED|CANCELLED)/.test(code)) return "client_cancelled";
  if (code === "PRIVACYAI_CODEX_GATEWAY_FAILURE") return "gateway";
  return "privacy_boundary";
}
