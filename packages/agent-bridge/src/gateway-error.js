import { sanitizePrivacyDiagnostics } from "@privacy-ai/sdk";

import {
  createGatewayContractError,
  gatewayNetworkCode,
  normalizeGatewayContractError
} from "./errors/gateway-policy.js";

const SAFE_PHASES = new Set(["request", "upstream_connect", "upstream_response", "sse"]);
const SAFE_ROUTES = new Set(["responses", "responses_compact", "models", "gateway"]);
const SAFE_DIAGNOSTIC_OPTIONS = new Set([
  "now",
  "route",
  "phase",
  "retryCount",
  "downstreamClosed"
]);

export function gatewayError(code, message) {
  return createGatewayContractError(code, message);
}

export function publicGatewayFailure(error) {
  const failure = normalizeGatewayContractError(error);
  return {
    code: failure.code,
    category: failure.category
  };
}

export function publicGatewayHttpStatus(error) {
  return normalizeGatewayContractError(error).status;
}

export function publicGatewayMessage(error) {
  return normalizeGatewayContractError(error).publicMessage;
}

export function safeGatewayDiagnostic(error, options = {}) {
  assertSafeDiagnosticOptions(options);
  const failure = normalizeGatewayContractError(error);
  const metadata = sanitizePrivacyDiagnostics({
    networkCode: gatewayNetworkCode(error),
    retryCount: safeRetryCount(options.retryCount),
    downstreamClosed: options.downstreamClosed === true
  });
  return {
    timestamp: new Date(safeDiagnosticTime(options.now)).toISOString(),
    route: SAFE_ROUTES.has(options.route) ? options.route : "gateway",
    phase: SAFE_PHASES.has(options.phase) ? options.phase : "request",
    networkCode: metadata.networkCode,
    retryCount: metadata.retryCount,
    downstreamClosed: metadata.downstreamClosed,
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

function assertSafeDiagnosticOptions(options) {
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("PrivacyAI gateway diagnostic options must be an object.");
  }
  for (const field of Object.keys(options)) {
    if (!SAFE_DIAGNOSTIC_OPTIONS.has(field)) {
      throw new TypeError(`PrivacyAI gateway diagnostics do not allow ${field}.`);
    }
  }
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
