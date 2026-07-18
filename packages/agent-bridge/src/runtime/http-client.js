import dns from "node:dns";
import http from "node:http";
import https from "node:https";

import { bindAbortSignal } from "./downstream-lifecycle.js";
import { resolvePositiveDuration } from "./duration.js";

const DEFAULT_HTTP_AGENT = new http.Agent({ keepAlive: true, timeout: 0 });
const DEFAULT_HTTPS_AGENT = new https.Agent({ keepAlive: true, timeout: 0 });

export function selectPreferredAddress(addresses, preferredFamily = 4) {
  if (!Array.isArray(addresses)) return null;
  const valid = addresses.filter(entry =>
    entry && typeof entry.address === "string" && (entry.family === 4 || entry.family === 6)
  );
  return valid.find(entry => entry.family === preferredFamily) || valid[0] || null;
}

export function createPreferredLookup(lookup = dns.lookup) {
  return (hostname, _options, callback) => {
    lookup(hostname, { all: true }, (error, addresses) => {
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
  };
}

export const lookupPreferredAddress = createPreferredLookup();

export function requestHttpResponse(url, options = {}) {
  const target = url instanceof URL ? url : new URL(url);
  const client = target.protocol === "https:"
    ? https
    : target.protocol === "http:"
      ? http
      : null;
  if (!client) throw new TypeError(`Unsupported upstream protocol: ${target.protocol}`);

  const timeoutMs = options.timeoutMs == null
    ? null
    : resolvePositiveDuration(
      options.timeoutMs,
      options.timeoutMs,
      options.timeoutLabel || "upstream response-header timeout"
    );
  const requestOptions = {
    method: options.method,
    headers: options.headers,
    agent: options.agent ?? (target.protocol === "https:" ? DEFAULT_HTTPS_AGENT : DEFAULT_HTTP_AGENT)
  };
  if (target.protocol === "https:") {
    requestOptions.autoSelectFamily = false;
    requestOptions.lookup = options.lookup || lookupPreferredAddress;
    if (options.servername) requestOptions.servername = options.servername;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer = null;
    let request;

    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      request?.setTimeout(0);
    };
    const finishError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (!request?.destroyed) request.destroy(abortReason(options.signal, options.abortError));
    };

    try {
      request = client.request(target, requestOptions, upstreamResponse => {
        if (settled) {
          upstreamResponse.destroy();
          return;
        }
        settled = true;
        cleanup();
        upstreamResponse.on("error", () => {});
        bindAbortSignal(upstreamResponse, options.signal);
        resolve(upstreamResponse);
      });
    } catch (error) {
      finishError(error);
      return;
    }

    request.once("error", finishError);
    if (timeoutMs != null) {
      const timeout = () => request.destroy(materializeError(
        options.timeoutError,
        "PrivacyAI upstream response headers timed out.",
        "ETIMEDOUT"
      ));
      deadlineTimer = setTimeout(timeout, timeoutMs);
      request.setTimeout(timeoutMs, timeout);
    }
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      if (options.body == null) request.end();
      else request.end(options.body);
    } catch (error) {
      request.destroy(error);
      finishError(error);
    }
  });
}

function abortReason(signal, fallback) {
  if (signal?.reason instanceof Error) return signal.reason;
  return materializeError(fallback, "PrivacyAI upstream request aborted.", "ABORT_ERR", "AbortError");
}

function materializeError(value, fallbackMessage, fallbackCode, fallbackName) {
  const error = typeof value === "function" ? value() : value;
  if (error instanceof Error) return error;
  const fallback = new Error(fallbackMessage);
  if (fallbackCode) fallback.code = fallbackCode;
  if (fallbackName) fallback.name = fallbackName;
  return fallback;
}
