import dns from "node:dns";
import http from "node:http";
import https from "node:https";

import { gatewayError } from "./gateway-error.js";

const MAX_DURATION_MS = 30 * 60 * 1000;
const UPSTREAM_HTTP_AGENT = new http.Agent({ keepAlive: true, timeout: 0 });
const UPSTREAM_HTTPS_AGENT = new https.Agent({ keepAlive: true, timeout: 0 });

export function selectPreferredAddress(addresses, preferredFamily = 4) {
  if (!Array.isArray(addresses)) return null;
  const valid = addresses.filter(entry =>
    entry && typeof entry.address === "string" && (entry.family === 4 || entry.family === 6)
  );
  return valid.find(entry => entry.family === preferredFamily) || valid[0] || null;
}

function lookupPreferredAddress(hostname, _options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    const selected = selectPreferredAddress(addresses, 4);
    if (!selected) {
      const missing = new Error(`No IP address found for ${hostname}.`);
      missing.code = "ENOTFOUND";
      callback(missing);
      return;
    }
    callback(null, selected.address, selected.family);
  });
}

export function resolvePositiveDuration(value, fallback, label) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > MAX_DURATION_MS) {
    throw new TypeError(`${label} must be an integer between 1 and ${MAX_DURATION_MS} milliseconds.`);
  }
  return normalized;
}

export function requestCodexUpstream(url, method, headers, body, options = {}) {
  const client = url.protocol === "https:" ? https : http;
  const timeoutMs = resolvePositiveDuration(
    options.timeoutMs,
    options.timeoutMs,
    "Codex upstream response-header timeout"
  );

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let deadlineTimer = null;
    const requestOptions = {
      method,
      headers,
      agent: url.protocol === "https:" ? UPSTREAM_HTTPS_AGENT : UPSTREAM_HTTP_AGENT
    };
    if (url.protocol === "https:") {
      requestOptions.autoSelectFamily = false;
      requestOptions.lookup = lookupPreferredAddress;
    }
    const request = client.request(url, requestOptions);
    const downstream = options.downstream;

    const cleanup = () => {
      downstream?.off("close", onDownstreamClose);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      request.setTimeout(0);
    };
    const finishError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(options.isDownstreamClosed?.()
        ? gatewayError(
          "PRIVACYAI_CODEX_CLIENT_DISCONNECTED",
          "PrivacyAI stopped the Codex request because the client disconnected."
        )
        : error);
    };
    const onDownstreamClose = () => {
      if (downstream?.writableEnded || request.destroyed) return;
      request.destroy(gatewayError(
        "PRIVACYAI_CODEX_CLIENT_DISCONNECTED",
        "PrivacyAI stopped the Codex request because the client disconnected."
      ));
    };

    if (downstream) downstream.once("close", onDownstreamClose);
    request.once("error", finishError);
    deadlineTimer = setTimeout(() => {
      request.destroy(codexUpstreamTimeoutError("response headers"));
    }, timeoutMs);
    request.setTimeout(timeoutMs, () => {
      request.destroy(codexUpstreamTimeoutError("response headers"));
    });
    request.once("response", upstreamResponse => {
      if (settled) {
        upstreamResponse.destroy();
        return;
      }
      settled = true;
      cleanup();
      upstreamResponse.on("error", () => {});
      resolvePromise(upstreamResponse);
    });
    if (body) request.end(body);
    else request.end();
  });
}

export function readBoundedHttpBody(stream, maxBytes, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    const idleTimeoutMs = options.idleTimeoutMs == null
      ? null
      : resolvePositiveDuration(
        options.idleTimeoutMs,
        options.idleTimeoutMs,
        "upstream body idle timeout"
      );
    let size = 0;
    let settled = false;
    let ended = false;
    let idleTimer = null;

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("aborted", onAborted);
      stream.off("close", onClose);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const resetIdleTimer = () => {
      if (idleTimeoutMs == null || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = codexUpstreamTimeoutError("response body");
        finish(error);
        stream.destroy(error);
      }, idleTimeoutMs);
    };
    const onData = chunk => {
      if (settled) return;
      resetIdleTimer();
      size += chunk.length;
      if (size > maxBytes) {
        finish(gatewayError(
          "PRIVACYAI_CODEX_BODY_TOO_LARGE",
          "PrivacyAI blocked an oversized Codex provider payload."
        ));
        if (options.destroyOnLimit) stream.destroy();
        else if (typeof stream.resume === "function") stream.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      ended = true;
      finish(null, Buffer.concat(chunks));
    };
    const onError = error => finish(error);
    const onAborted = () => finish(gatewayError(
      "PRIVACYAI_CODEX_BODY_ABORTED",
      "PrivacyAI stopped an aborted Codex provider payload."
    ));
    const onClose = () => {
      if (ended || settled) return;
      finish(gatewayError(
        "PRIVACYAI_CODEX_BODY_TRUNCATED",
        "PrivacyAI stopped a Codex provider payload that closed before completion."
      ));
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("aborted", onAborted);
    stream.once("close", onClose);
    resetIdleTimer();
  });
}

export function nextHttpChunk(iterator, upstreamResponse, timeoutMs) {
  const idleTimeoutMs = resolvePositiveDuration(
    timeoutMs,
    timeoutMs,
    "Codex upstream SSE idle timeout"
  );
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = codexUpstreamTimeoutError("SSE stream");
      upstreamResponse.destroy(error);
      rejectPromise(error);
    }, idleTimeoutMs);
    Promise.resolve(iterator.next()).then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      }
    );
  });
}

export function listenOnHost(server, port, host) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = error => rejectPromise(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

export function closeHttpServer(server, sockets) {
  return new Promise(resolvePromise => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolvePromise());
  });
}

function codexUpstreamTimeoutError(phase) {
  return Object.assign(new Error(`PrivacyAI upstream ${phase} timed out.`), { code: "ETIMEDOUT" });
}
