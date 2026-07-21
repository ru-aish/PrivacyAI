import { gatewayError } from "./gateway-error.js";
import { readBoundedHttpBody as readRuntimeHttpBody } from "./runtime/http-body.js";
import {
  requestHttpResponse,
  selectPreferredAddress
} from "./runtime/http-client.js";
import { resolvePositiveDuration } from "./runtime/duration.js";
import { closeHttpServer, listenOnHost } from "./runtime/http-server.js";
import { nextWithTimeout } from "./runtime/stream-io.js";

export { closeHttpServer, listenOnHost, resolvePositiveDuration, selectPreferredAddress };

export function requestCodexUpstream(url, method, headers, body, options = {}) {
  return requestHttpResponse(url, {
    method,
    headers,
    body,
    signal: options.signal,
    onRequestSent: options.onRequestSent,
    timeoutMs: options.timeoutMs,
    timeoutLabel: "Codex upstream response-header timeout",
    timeoutError: () => codexUpstreamTimeoutError("response headers")
  });
}

export function readBoundedHttpBody(stream, maxBytes, options = {}) {
  return readRuntimeHttpBody(stream, maxBytes, {
    idleTimeoutMs: options.idleTimeoutMs,
    idleTimeoutLabel: "upstream body idle timeout",
    limitAction: options.destroyOnLimit ? "destroy" : "drain",
    errors: {
      tooLarge: () => gatewayError(
        "PRIVACYAI_CODEX_BODY_TOO_LARGE",
        "PrivacyAI blocked an oversized Codex provider payload."
      ),
      aborted: () => gatewayError(
        "PRIVACYAI_CODEX_BODY_ABORTED",
        "PrivacyAI stopped an aborted Codex provider payload."
      ),
      truncated: () => gatewayError(
        "PRIVACYAI_CODEX_BODY_TRUNCATED",
        "PrivacyAI stopped a Codex provider payload that closed before completion."
      ),
      idle: () => codexUpstreamTimeoutError("response body")
    }
  });
}

export function nextHttpChunk(iterator, upstreamResponse, timeoutMs) {
  return nextWithTimeout(
    iterator,
    upstreamResponse,
    timeoutMs,
    () => codexUpstreamTimeoutError("SSE stream"),
    "Codex upstream SSE idle timeout"
  );
}

function codexUpstreamTimeoutError(phase) {
  return Object.assign(new Error(`PrivacyAI upstream ${phase} timed out.`), { code: "ETIMEDOUT" });
}
