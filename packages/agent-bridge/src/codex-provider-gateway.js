import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

import { restoreText } from "@privacy-ai/sdk";
import { createCodexImageSanitizer } from "./codex-image-adapter.js";
import {
  codexSessionContext,
  restoreCodexCompactResponse,
  restoreCodexJsonResponse,
  sanitizeCodexMetadataHeaders,
  sanitizeCodexRequestBody
} from "./codex-request-transform.js";
import { CodexSseRestorer } from "./codex-sse-transform.js";
import {
  openContextVerificationStore,
  verificationFingerprint
} from "./context-verification-store.js";
import {
  gatewayError,
  publicGatewayFailure,
  safeGatewayDiagnostic
} from "./gateway-error.js";
import { SessionVault } from "./session-vault.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ALIASES_PER_ORIGINAL = 8;
const CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
const API_UPSTREAM = "https://api.openai.com/v1";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "content-encoding"
]);

export async function startCodexProviderGateway(options = {}) {
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Codex provider gateway requires a local sanitizer function.");
  }

  const nonce = options.nonce || randomBytes(24).toString("hex");
  const vault = options.vault || new SessionVault(options);
  const imageSanitizer = options.imageSanitizer || createCodexImageSanitizer(options.imageSanitizerOptions);
  const ownsImageSanitizer = !options.imageSanitizer;
  const verificationStore = await openContextVerificationStore(options);
  const ownsVerificationStore = !options.verificationStore;
  const stablePolicyFingerprint =
    options.policyFingerprint || options.sanitizer.identity?.fingerprint;
  const policyFingerprint = String(
    stablePolicyFingerprint ||
    verificationFingerprint({
      boundary: "codex-provider",
      version: 3,
      // Function.toString() cannot capture closed-over model or policy state.
      // Without an explicit stable identity, keep cache reuse inside this
      // gateway lifetime and intentionally miss persisted entries on restart.
      ephemeralSanitizerNonce: randomBytes(32).toString("hex")
    })
  );
  const serial = new KeyedSerialQueue();
  const sessionCaches = new Map();
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const requestContext = {
      ...options,
      nonce,
      vault,
      imageSanitizer,
      verificationStore,
      policyFingerprint,
      serial,
      sessionCaches
    };
    handleRequest(request, response, requestContext).catch(error => {
      if (!isCancellationError(error)) reportGatewayError(requestContext, error, "request");
      writeGatewayFailure(response, error);
    });
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });

  try {
    await listen(server, options.port || 0, LOOPBACK_HOST);
  } catch (error) {
    try {
      if (ownsImageSanitizer) await imageSanitizer.close();
    } finally {
      if (ownsVerificationStore) verificationStore.close();
    }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server, sockets);
    try {
      if (ownsImageSanitizer) await imageSanitizer.close();
    } finally {
      if (ownsVerificationStore) verificationStore.close();
    }
    throw new Error("PrivacyAI could not determine the Codex gateway address.");
  }

  let closed = false;
  return {
    host: LOOPBACK_HOST,
    port: address.port,
    nonce,
    baseURL: `http://${LOOPBACK_HOST}:${address.port}/${nonce}`,
    async close() {
      if (closed) return;
      closed = true;
      sessionCaches.clear();
      await closeServer(server, sockets);
      try {
        if (ownsImageSanitizer) await imageSanitizer.close();
      } finally {
        if (ownsVerificationStore) verificationStore.close();
      }
    }
  };
}

async function handleRequest(request, response, context) {
  const lifecycle = createDownstreamLifecycle(request, response);
  try {
    return await handleRequestCore(request, response, {
      ...context,
      requestSignal: lifecycle.signal
    });
  } finally {
    lifecycle.cleanup();
  }
}

async function handleRequestCore(request, response, context) {
  applyLocalResponseSecurityHeaders(response);
  const url = new URL(request.url || "/", `http://${LOOPBACK_HOST}`);
  const prefix = `/${context.nonce}`;
  if (!url.pathname.startsWith(`${prefix}/`)) {
    return writeJson(response, 404, { error: "PrivacyAI gateway route not found." });
  }

  const suffix = url.pathname.slice(prefix.length);
  if (suffix === "/health" && request.method === "GET") {
    return writeJson(response, 200, { ok: true });
  }
  if (!new Set(["/responses", "/responses/compact", "/models"]).has(suffix)) {
    return writeJson(response, 404, { error: "PrivacyAI blocked an unsupported Codex provider route." });
  }
  const safeSearch = sanitizeUpstreamSearch(suffix, url.search, context);
  if (suffix === "/models") {
    if (request.method !== "GET") return writeJson(response, 405, { error: "Method not allowed." });
    return proxyModels(request, response, context, suffix, safeSearch);
  }
  if (request.method !== "POST") return writeJson(response, 405, { error: "Method not allowed." });

  const encoding = String(request.headers["content-encoding"] || "identity").toLowerCase();
  if (encoding !== "identity" && encoding !== "") {
    return writeJson(response, 415, { error: "PrivacyAI requires uncompressed Codex provider requests." });
  }
  const mediaType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return writeJson(response, 415, { error: "PrivacyAI requires JSON Codex provider requests." });
  }

  const rawBody = await readBody(
    request,
    Number(context.maxRequestBytes || DEFAULT_MAX_REQUEST_BYTES),
    { destroyOnLimit: false }
  );
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw gatewayError("PRIVACYAI_CODEX_INVALID_JSON", "PrivacyAI blocked malformed Codex provider JSON.");
  }
  validateRouteRequestBody(suffix, body);

  const identity = codexSessionContext(body, undefined, request.headers);
  const transformed = await context.serial.run(identity.sessionKey, async () => {
    throwIfAborted(context.requestSignal);
    const currentVault = await context.vault.load(identity.sessionKey);
    const currentThread = context.verificationStore.loadThread(identity.sessionKey);
    const currentSessionMap = mergeInheritedSessionMap(
      currentVault?.sessionMap || {},
      currentThread.sessionMap || {}
    );
    let sessionMap = { ...currentSessionMap };
    for (const parentSessionKey of identity.parentSessionKeys) {
      const parentVault = await context.vault.load(parentSessionKey);
      const parentThread = context.verificationStore.loadThread(parentSessionKey);
      if (parentVault?.sessionMap) {
        sessionMap = mergeInheritedSessionMap(sessionMap, parentVault.sessionMap);
      }
      if (parentThread?.sessionMap) {
        sessionMap = mergeInheritedSessionMap(sessionMap, parentThread.sessionMap);
      }
    }

    const cache = sessionCache(context, identity.sessionKey);
    const result = await sanitizeCodexRequestBody(body, {
      sanitizer: context.sanitizer,
      imageSanitizer: context.imageSanitizer,
      sessionMap,
      cache,
      policyFingerprint: context.policyFingerprint,
      maxContextChars: context.maxContextChars,
      headers: request.headers,
      signal: context.requestSignal,
      onBatchComplete: context.onSanitizerBatchComplete,
      onArtifactComplete: context.onSanitizerArtifactComplete,
      onSchemaTrace: context.onSchemaTrace
    });
    throwIfAborted(context.requestSignal);
    const completeMap = { ...sessionMap, ...result.sessionMapAdditions };
    if (!sessionMapsEqual(currentVault?.sessionMap || {}, completeMap)) {
      await context.vault.save(identity.sessionKey, completeMap);
    }
    context.verificationStore.saveThread(identity.sessionKey, {
      parentSessionKeys: identity.parentSessionKeys,
      sessionMap: completeMap,
      policyFingerprint: context.policyFingerprint
    });
    if (typeof context.onSanitizedRequest === "function") {
      await context.onSanitizedRequest(result.body, {
        sessionKey: identity.sessionKey,
        route: suffix
      });
    }
    commitCacheWrites(
      cache,
      result.cacheWrites,
      Number(context.maxCacheEntriesPerSession || 2048),
      context.verificationStore
    );
    for (const item of result.itemRecords || []) {
      context.verificationStore.recordThreadItem({
        ...item,
        sessionKey: identity.sessionKey
      });
    }
    context.verificationRequestCount = (context.verificationRequestCount || 0) + 1;
    if (context.verificationRequestCount % 100 === 0) context.verificationStore.prune();
    return { body: result.body, sessionMap: completeMap };
  });

  throwIfAborted(context.requestSignal);
  return proxyTransformed(
    request,
    response,
    context,
    suffix,
    safeSearch,
    Buffer.from(JSON.stringify(transformed.body)),
    transformed.sessionMap,
    transformed.body.stream === true
  );
}

async function proxyModels(request, response, context, suffix, search) {
  const upstream = upstreamUrl(request.headers, context, suffix, search);
  const sanitizedHeaders = sanitizeCodexMetadataHeaders(request.headers);
  const headers = upstreamHeaders(sanitizedHeaders, upstream, null);
  const upstreamResponse = await makeUpstreamRequest(upstream, request.method, headers, null, {
    downstream: response
  });
  assertIdentityResponseEncoding(upstreamResponse);
  const statusCode = upstreamResponse.statusCode || 502;
  const raw = await readBody(
    upstreamResponse,
    Number(context.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES),
    { destroyOnLimit: true }
  );

  let responseBody;
  if (statusCode >= 200 && statusCode < 300) {
    try {
      responseBody = JSON.stringify(JSON.parse(raw.toString("utf8")));
    } catch {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_MODELS_RESPONSE",
        "PrivacyAI blocked a malformed Codex model-catalog response."
      );
    }
  } else {
    responseBody = raw.toString("utf8");
  }

  forwardResponseHeaders(response, upstreamResponse.headers, true);
  if (!response.hasHeader("content-type")) {
    response.setHeader(
      "content-type",
      statusCode >= 200 && statusCode < 300
        ? "application/json"
        : "text/plain; charset=utf-8"
    );
  }
  response.writeHead(statusCode);
  response.end(responseBody);
}

async function proxyTransformed(
  request,
  response,
  context,
  suffix,
  search,
  body,
  sessionMap,
  expectsSse
) {
  const upstream = upstreamUrl(request.headers, context, suffix, search);
  const sanitizedHeaders = sanitizeCodexMetadataHeaders(request.headers);
  const headers = upstreamHeaders(sanitizedHeaders, upstream, body.length);
  const upstreamResponse = await makeUpstreamRequest(upstream, "POST", headers, body, {
    downstream: response
  });

  assertIdentityResponseEncoding(upstreamResponse);

  const contentType = String(upstreamResponse.headers["content-type"] || "").toLowerCase();
  const statusCode = upstreamResponse.statusCode || 502;
  const headerlessExpectedSse =
    expectsSse && contentType.trim() === "" && statusCode >= 200 && statusCode < 300;
  if (contentType.includes("text/event-stream") || headerlessExpectedSse) {
    await proxySseResponse(response, upstreamResponse, context, sessionMap, statusCode, {
      forceContentType: headerlessExpectedSse
    });
    return;
  }

  if (statusCode >= 400 && contentType.trim() === "") {
    const raw = await readBody(
      upstreamResponse,
      Number(context.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES),
      { destroyOnLimit: true }
    );
    forwardResponseHeaders(response, upstreamResponse.headers, true);
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.writeHead(statusCode);
    response.end(restoreText(raw.toString("utf8"), sessionMap));
    return;
  }

  if (!contentType.includes("application/json") && !contentType.startsWith("text/")) {
    upstreamResponse.destroy();
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_TYPE",
      `PrivacyAI blocked an unsupported Codex provider response type (status=${statusCode}, content-type=${safeContentType(contentType)}).`
    );
  }

  const raw = await readBody(
    upstreamResponse,
    Number(context.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES),
    { destroyOnLimit: true }
  );
  let restoredBody;
  if (contentType.includes("application/json")) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw gatewayError(
        "PRIVACYAI_CODEX_INVALID_RESPONSE",
        "PrivacyAI blocked malformed Codex provider JSON output."
      );
    }
    restoredBody = JSON.stringify(
      statusCode >= 200 && statusCode < 300 && suffix === "/responses/compact"
        ? restoreCodexCompactResponse(parsed, sessionMap)
        : restoreCodexJsonResponse(parsed, sessionMap)
    );
  } else {
    restoredBody = restoreText(raw.toString("utf8"), sessionMap);
  }
  forwardResponseHeaders(response, upstreamResponse.headers, true);
  response.writeHead(statusCode);
  response.end(restoredBody);
}

async function proxySseResponse(
  response,
  upstreamResponse,
  context,
  sessionMap,
  statusCode,
  options = {}
) {
  const restorer = new CodexSseRestorer(sessionMap);
  const iterator = upstreamResponse[Symbol.asyncIterator]();
  const staged = [];
  const maxProbeBytes = Number(context.maxSseProbeBytes || 256 * 1024);
  let probedBytes = 0;
  let done = false;

  while (!containsJsonSseData(staged)) {
    const next = await iterator.next();
    done = Boolean(next.done);
    if (done) {
      staged.push(...restorer.end());
      break;
    }
    probedBytes += next.value.length;
    if (probedBytes > maxProbeBytes) {
      upstreamResponse.destroy();
      throw gatewayError(
        "PRIVACYAI_CODEX_SSE_PROBE_TOO_LARGE",
        "PrivacyAI blocked a Codex stream that did not produce a valid SSE event within the probe limit."
      );
    }
    staged.push(...restorer.write(next.value));
  }

  if (!containsJsonSseData(staged)) {
    upstreamResponse.destroy();
    throw gatewayError(
      "PRIVACYAI_CODEX_EMPTY_SSE",
      "PrivacyAI blocked a Codex stream that ended before a valid SSE data event."
    );
  }

  forwardResponseHeaders(response, upstreamResponse.headers, true);
  if (options.forceContentType) response.setHeader("content-type", "text/event-stream");
  response.writeHead(statusCode);

  try {
    for (const output of staged) await writeWithBackpressure(response, output);
    while (!done) {
      const next = await iterator.next();
      done = Boolean(next.done);
      if (!done) {
        for (const output of restorer.write(next.value)) {
          await writeWithBackpressure(response, output);
        }
      }
    }
    for (const output of restorer.end()) await writeWithBackpressure(response, output);
    response.end();
  } catch (error) {
    const cancelled = isCancellationError(error) || response.destroyed || response.writableEnded;
    upstreamResponse.destroy();
    if (!response.destroyed && !response.writableEnded) response.destroy();
    if (!cancelled) throw error;
  }
}

function containsJsonSseData(outputs) {
  return outputs.some(output =>
    String(output)
      .split(/\r?\n/)
      .some(line => line.startsWith("data:") && line.slice(5).trim() !== "[DONE]")
  );
}

function assertIdentityResponseEncoding(upstreamResponse) {
  const encoding = String(upstreamResponse.headers["content-encoding"] || "identity").toLowerCase();
  if (encoding === "identity" || encoding === "") return;
  upstreamResponse.destroy();
  throw gatewayError(
    "PRIVACYAI_CODEX_COMPRESSED_RESPONSE",
    "PrivacyAI blocked an unexpectedly compressed Codex provider response."
  );
}

function validateRouteRequestBody(suffix, body) {
  if (suffix === "/responses") {
    if (body?.stream !== true) {
      throw gatewayError(
        "PRIVACYAI_CODEX_STREAM_REQUIRED",
        "PrivacyAI requires streaming Codex Responses requests so every output event crosses the SSE boundary."
      );
    }
    return;
  }
  if (suffix === "/responses/compact" && body?.stream != null) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_COMPACT_REQUEST",
      "PrivacyAI blocked a compact request with an unsupported stream field."
    );
  }
}

function sanitizeUpstreamSearch(suffix, search, context) {
  if (!search) return "";
  if (context.allowTestQueryParameters) return search;
  if (suffix !== "/models") {
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_QUERY",
      "PrivacyAI blocked query parameters on a Codex provider request."
    );
  }

  const input = new URLSearchParams(search);
  const values = input.getAll("client_version");
  if (input.size !== 1 || values.length !== 1 || !/^[A-Za-z0-9._+-]{1,64}$/.test(values[0])) {
    throw gatewayError(
      "PRIVACYAI_CODEX_INVALID_MODELS_QUERY",
      "PrivacyAI blocked unsupported Codex model-catalog query parameters."
    );
  }
  return `?client_version=${encodeURIComponent(values[0])}`;
}

function upstreamUrl(headers, context, suffix, search) {
  const isChatGpt = Object.keys(headers).some(name => name.toLowerCase() === "chatgpt-account-id");
  const base = isChatGpt
    ? context.chatgptUpstream || CHATGPT_UPSTREAM
    : context.apiUpstream || API_UPSTREAM;
  const parsed = new URL(base);
  if (!context.allowInsecureTestUpstream && parsed.protocol !== "https:") {
    throw gatewayError("PRIVACYAI_CODEX_INVALID_UPSTREAM", "PrivacyAI requires an HTTPS Codex upstream.");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}${suffix}`;
  parsed.search = search;
  return parsed;
}

function upstreamHeaders(source, upstream, contentLength) {
  const headers = {};
  for (const [name, value] of Object.entries(source)) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized.startsWith("x-forwarded-")) continue;
    if (value != null) headers[name] = value;
  }
  headers.host = upstream.host;
  headers["accept-encoding"] = "identity";
  if (contentLength != null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(contentLength);
  }
  return headers;
}

function makeUpstreamRequest(url, method, headers, body, options = {}) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = client.request(url, { method, headers });
    const downstream = options.downstream;
    const cleanup = () => {
      downstream?.off("close", onDownstreamClose);
    };
    const onError = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onDownstreamClose = () => {
      if (downstream?.writableEnded || request.destroyed) return;
      request.destroy();
    };

    if (downstream) downstream.once("close", onDownstreamClose);
    request.once("error", onError);
    request.once("response", upstreamResponse => {
      if (settled) {
        upstreamResponse.destroy();
        return;
      }
      settled = true;
      upstreamResponse.on("error", () => {});
      const finish = () => cleanup();
      upstreamResponse.once("end", finish);
      upstreamResponse.once("close", finish);
      resolve(upstreamResponse);
    });
    if (body) request.end(body);
    else request.end();
  });
}

function forwardResponseHeaders(response, headers, transformed) {
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (transformed && normalized === "content-length") continue;
    if (value != null) response.setHeader(name, value);
  }
  if (transformed) {
    response.removeHeader("content-length");
    response.removeHeader("content-encoding");
  }
}

function applyLocalResponseSecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
}

function createDownstreamLifecycle(request, response) {
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted || response.writableEnded) return;
    controller.abort(gatewayError(
      "PRIVACYAI_CODEX_CLIENT_DISCONNECTED",
      "PrivacyAI stopped the Codex request because the client disconnected."
    ));
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      request.off("aborted", abort);
      response.off("close", abort);
    }
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw gatewayError(
    "PRIVACYAI_REQUEST_ABORTED",
    "PrivacyAI stopped the Codex request because the client disconnected."
  );
}

function isCancellationError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "PRIVACYAI_REQUEST_ABORTED" ||
    error?.code === "PRIVACYAI_CODEX_CLIENT_DISCONNECTED"
  );
}

function readBody(stream, maxBytes, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let ended = false;

    const cleanup = () => {
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
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      if (settled) return;
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
  });
}

function writeJson(response, status, value) {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function safeContentType(value) {
  const normalized = String(value || "missing").toLowerCase().trim();
  return /^[a-z0-9!#$&^_.+\-\/;= ]{1,120}$/.test(normalized)
    ? normalized
    : "invalid";
}

function reportGatewayError(context, error, phase) {
  if (typeof context?.onGatewayError !== "function") return;
  try {
    context.onGatewayError(safeGatewayDiagnostic(error, phase));
  } catch {
    // Diagnostic callbacks are observational only and must not alter the boundary.
  }
}

function writeGatewayFailure(response, error) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const { code } = publicGatewayFailure(error);
  const status = code === "PRIVACYAI_CODEX_BODY_TOO_LARGE" ? 413 : 502;
  writeJson(response, status, {
    error: {
      type: "privacyai_gateway_error",
      code,
      message: "PrivacyAI stopped this Codex request because its privacy boundary could not be verified."
    }
  });
}

function writeWithBackpressure(stream, value) {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.reject(gatewayError(
      "PRIVACYAI_CODEX_CLIENT_DISCONNECTED",
      "PrivacyAI stopped writing because the Codex client disconnected."
    ));
  }

  let accepted;
  try {
    accepted = stream.write(value);
  } catch (error) {
    return Promise.reject(error);
  }
  if (accepted) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(gatewayError(
        "PRIVACYAI_CODEX_CLIENT_DISCONNECTED",
        "PrivacyAI stopped writing because the Codex client disconnected."
      ));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server, sockets) {
  return new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
}

function sessionCache(context, sessionKey) {
  let memory = context.sessionCaches.get(sessionKey);
  if (!memory) {
    const maxSessions = Number(context.maxCachedSessions || 64);
    while (context.sessionCaches.size >= maxSessions) {
      const oldest = context.sessionCaches.keys().next().value;
      if (oldest == null) break;
      context.sessionCaches.delete(oldest);
    }
    memory = new Map();
    context.sessionCaches.set(sessionKey, memory);
  }

  return {
    get(key, policyFingerprint) {
      if (memory.has(key)) {
        const value = memory.get(key);
        memory.delete(key);
        memory.set(key, value);
        return value;
      }
      const persisted = context.verificationStore.getVerification(key, policyFingerprint);
      if (persisted) memory.set(key, persisted);
      return persisted;
    },
    set(key, value) {
      if (memory.has(key)) memory.delete(key);
      memory.set(key, value);
    },
    delete(key) {
      return memory.delete(key);
    },
    keys() {
      return memory.keys();
    },
    get size() {
      return memory.size;
    }
  };
}

function commitCacheWrites(cache, writes = [], maxEntries = 2048, verificationStore) {
  for (const [key, value] of writes) {
    cache.set(key, value);
    verificationStore?.putVerification(value);
  }
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

function mergeInheritedSessionMap(current, inherited) {
  const merged = { ...current };
  const aliasesPerOriginal = new Map();
  for (const original of Object.values(merged)) {
    aliasesPerOriginal.set(original, (aliasesPerOriginal.get(original) || 0) + 1);
  }

  for (const [placeholder, original] of Object.entries(inherited || {})) {
    if (Object.hasOwn(merged, placeholder)) {
      if (merged[placeholder] !== original) {
        throw gatewayError(
          "PRIVACYAI_CODEX_SESSION_MAP_COLLISION",
          "PrivacyAI blocked ambiguous placeholder inheritance between Codex threads."
        );
      }
      continue;
    }

    const aliasCount = aliasesPerOriginal.get(original) || 0;
    if (aliasCount >= MAX_ALIASES_PER_ORIGINAL) {
      throw gatewayError(
        "PRIVACYAI_CODEX_SESSION_MAP_COLLISION",
        "PrivacyAI blocked excessive aliases for one inherited private value."
      );
    }

    // One original may intentionally have both a text placeholder and a
    // provider-identifier-safe alias. Restoration is unambiguous because both
    // aliases resolve to the same local value.
    merged[placeholder] = original;
    aliasesPerOriginal.set(original, aliasCount + 1);
  }
  return merged;
}

function sessionMapsEqual(left, right) {
  const leftEntries = Object.entries(left || {}).sort();
  const rightEntries = Object.entries(right || {}).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

class KeyedSerialQueue {
  constructor() {
    this.pending = new Map();
  }

  async run(key, operation) {
    const previous = this.pending.get(key) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.pending.set(key, tail);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.pending.get(key) === tail) this.pending.delete(key);
    }
  }
}
