import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { restoreText } from "@privacy-ai/sdk";
import { AgySseRestorer } from "./agy-sse-transform.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MODEL_HOST = "daily-cloudcode-pa.googleapis.com";
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const AUDITED_OPAQUE_ROUTES = new Map([
  ["GET", new Set(["/oauth/status"])],
  ["POST", new Set([
    "/v1internal:fetchAdminControls",
    "/v1internal:fetchAvailableModels",
    "/v1internal:fetchUserInfo",
    "/v1internal:listExperiments",
    "/v1internal:loadCodeAssist",
    "/v1internal:recordCodeAssistMetrics",
    "/v1internal:retrieveUserQuotaSummary",
    "/v1internal:setUserSettings"
  ])]
]);
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
  "content-length"
]);

export async function startAgyTransportProxy(options = {}) {
  if (!options.authority?.leafCertificate || !options.authority?.leafPrivateKey) {
    throw new TypeError("AGY transport proxy requires an ephemeral TLS authority.");
  }
  if (!options.sessionController?.transform) {
    throw new TypeError("AGY transport proxy requires an AGY session controller.");
  }

  const modelHost = String(options.modelHost || DEFAULT_MODEL_HOST).toLowerCase();
  const upstreamAgent = options.upstreamAgent || new https.Agent({ keepAlive: true, maxSockets: 32 });
  const ownsUpstreamAgent = !options.upstreamAgent;
  const proxyToken = options.proxyToken || randomBytes(24).toString("base64url");
  const expectedAuthorization = `Basic ${Buffer.from(`privacyai:${proxyToken}`).toString("base64")}`;
  const sockets = new Set();

  const interceptServer = https.createServer({
    key: options.authority.leafPrivateKey,
    cert: options.authority.leafCertificate,
    ALPNProtocols: ["http/1.1"]
  }, (request, response) => {
    handleInterceptedRequest(request, response, { ...options, modelHost, upstreamAgent }).catch(error => {
      if (!isExpectedClientDisconnect(error, request, response)) {
        reportError(options, error, "intercepted-request");
      }
      writeProxyFailure(response, error);
    });
  });
  trackServerSockets(interceptServer, sockets);

  const proxyServer = http.createServer((_request, response) => {
    response.writeHead(405, { "content-type": "text/plain", connection: "close" });
    response.end("PrivacyAI AGY proxy accepts CONNECT only.\n");
  });
  trackServerSockets(proxyServer, sockets);
  proxyServer.on("connect", (request, clientSocket, head) => {
    handleConnect(request, clientSocket, head, {
      modelHost,
      expectedAuthorization,
      interceptPort: interceptServer.address()?.port,
      sockets,
      options
    });
  });

  try {
    await listen(interceptServer, options.interceptPort || 0, LOOPBACK_HOST);
    await listen(proxyServer, options.proxyPort || 0, LOOPBACK_HOST);
  } catch (error) {
    await closeServers([proxyServer, interceptServer], sockets);
    if (ownsUpstreamAgent) upstreamAgent.destroy();
    throw error;
  }

  const proxyAddress = proxyServer.address();
  if (!proxyAddress || typeof proxyAddress === "string") {
    await closeServers([proxyServer, interceptServer], sockets);
    if (ownsUpstreamAgent) upstreamAgent.destroy();
    throw proxyError("PRIVACYAI_AGY_PROXY_ADDRESS", "PrivacyAI could not determine the AGY proxy address.");
  }

  let closed = false;
  return {
    host: LOOPBACK_HOST,
    port: proxyAddress.port,
    modelHost,
    proxyURL: `http://privacyai:${encodeURIComponent(proxyToken)}@${LOOPBACK_HOST}:${proxyAddress.port}`,
    env: {
      HTTPS_PROXY: `http://privacyai:${encodeURIComponent(proxyToken)}@${LOOPBACK_HOST}:${proxyAddress.port}`,
      SSL_CERT_FILE: options.authority.trustBundlePath,
      GRPC_DEFAULT_SSL_ROOTS_FILE_PATH: options.authority.trustBundlePath,
      NO_PROXY: mergeNoProxy(options.baseEnv?.NO_PROXY || options.baseEnv?.no_proxy)
    },
    async close() {
      if (closed) return;
      closed = true;
      await closeServers([proxyServer, interceptServer], sockets);
      if (ownsUpstreamAgent) upstreamAgent.destroy();
    }
  };
}

async function handleInterceptedRequest(request, response, context) {
  const host = normalizeHostHeader(request.headers.host);
  if (host !== context.modelHost) {
    request.resume();
    throw proxyError("PRIVACYAI_AGY_HOST_MISMATCH", "PrivacyAI blocked an unexpected intercepted AGY host.");
  }

  const url = new URL(request.url || "/", `https://${context.modelHost}`);
  if (!isModelPath(url)) {
    if (!isAuditedOpaqueRoute(request.method, url)) {
      request.resume();
      throw proxyError(
        "PRIVACYAI_AGY_UNSUPPORTED_HOST_ROUTE",
        `PrivacyAI blocked unaudited AGY model-host route ${String(request.method || "").toUpperCase()} ${url.pathname}.`
      );
    }
    return proxyOpaqueRequest(request, response, context, url);
  }
  if (!isSupportedModelRoute(request.method, url)) {
    request.resume();
    throw proxyError(
      "PRIVACYAI_AGY_UNSUPPORTED_MODEL_ROUTE",
      "PrivacyAI supports only POST SSE requests on the AGY generation endpoint."
    );
  }

  const lifecycle = downstreamLifecycle(request, response);
  try {
    const contentEncoding = String(request.headers["content-encoding"] || "identity").toLowerCase();
    if (contentEncoding !== "identity" && contentEncoding !== "") {
      request.resume();
      throw proxyError(
        "PRIVACYAI_AGY_UNSUPPORTED_REQUEST_ENCODING",
        "PrivacyAI requires uncompressed AGY model requests."
      );
    }
    const mediaType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      request.resume();
      throw proxyError("PRIVACYAI_AGY_UNSUPPORTED_REQUEST_TYPE", "PrivacyAI requires JSON AGY model requests.");
    }

    const raw = await readBody(request, Number(context.maxRequestBytes || DEFAULT_MAX_REQUEST_BYTES));
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw proxyError("PRIVACYAI_AGY_INVALID_JSON", "PrivacyAI blocked malformed AGY model JSON.");
    }

    const transformed = await context.sessionController.transform(body, { signal: lifecycle.signal });
    const payload = Buffer.from(JSON.stringify(transformed.body));
    const headers = buildAgyUpstreamHeaders(request.headers, context.modelHost, payload.length, { modelRoute: true });
    const upstream = await (context.requestUpstream || makeUpstreamRequest)({
      hostname: context.modelHost,
      method: "POST",
      path: `${url.pathname}${url.search}`,
      headers,
      body: payload,
      signal: lifecycle.signal,
      agent: context.upstreamAgent
    });
    await proxyModelResponse(response, upstream, transformed.sessionMap, context, lifecycle.signal);
  } finally {
    lifecycle.cleanup();
  }
}

function proxyOpaqueRequest(request, response, context, url) {
  return new Promise((resolve, reject) => {
    const contentLength = request.headers["content-length"] == null
      ? null
      : Number(request.headers["content-length"]);
    const headers = buildAgyUpstreamHeaders(
      request.headers,
      context.modelHost,
      Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null,
      { modelRoute: false }
    );
    const requestUpstream = context.requestOpaqueUpstream || https.request;
    let upstreamResponse;
    let settled = false;

    const cleanup = () => {
      request.off("aborted", onDownstreamAbort);
      response.off("close", onDownstreamClose);
      upstream.off("error", onUpstreamError);
      upstreamResponse?.off("end", onUpstreamEnd);
      upstreamResponse?.off("error", onUpstreamError);
      upstreamResponse?.off("aborted", onUpstreamAbort);
    };
    const finish = error => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const ignoreExpectedDisconnect = () => {};
    const destroyUpstream = () => {
      // A ClientRequest may emit ECONNRESET after destroy() while its socket is
      // closing. Keep a sink on streams intentionally cancelled by the
      // downstream so that expected teardown cannot become an unhandled error.
      upstreamResponse?.on("error", ignoreExpectedDisconnect);
      upstream.on("error", ignoreExpectedDisconnect);
      upstreamResponse?.destroy();
      upstream.destroy();
    };
    const onDownstreamAbort = () => {
      destroyUpstream();
      finish();
    };
    const onDownstreamClose = () => {
      if (response.writableFinished) return;
      destroyUpstream();
      finish();
    };
    const onUpstreamEnd = () => finish();
    const onUpstreamError = error => finish(error);
    const onUpstreamAbort = () => finish(proxyError(
      "PRIVACYAI_AGY_OPAQUE_UPSTREAM_ABORTED",
      "PrivacyAI's opaque AGY upstream response ended unexpectedly."
    ));

    const upstream = requestUpstream({
      hostname: context.modelHost,
      port: 443,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      servername: context.modelHost,
      agent: context.upstreamAgent
    }, value => {
      upstreamResponse = value;
      forwardResponseHeaders(response, upstreamResponse.headers, { transformed: false });
      response.writeHead(upstreamResponse.statusCode || 502);
      upstreamResponse.once("end", onUpstreamEnd);
      upstreamResponse.once("error", onUpstreamError);
      upstreamResponse.once("aborted", onUpstreamAbort);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", onUpstreamError);
    request.once("aborted", onDownstreamAbort);
    response.once("close", onDownstreamClose);
    request.pipe(upstream);
  });
}

async function proxyModelResponse(response, upstream, sessionMap, context, signal) {
  const status = upstream.statusCode || 502;
  const contentType = String(upstream.headers["content-type"] || "").toLowerCase();
  const contentEncoding = String(upstream.headers["content-encoding"] || "identity").toLowerCase();
  if (contentEncoding !== "identity" && contentEncoding !== "") {
    upstream.destroy();
    throw proxyError(
      "PRIVACYAI_AGY_UNSUPPORTED_RESPONSE_ENCODING",
      "PrivacyAI blocked a compressed AGY model response."
    );
  }

  if (status >= 200 && status < 300) {
    if (!contentType.includes("text/event-stream")) {
      upstream.destroy();
      throw proxyError(
        "PRIVACYAI_AGY_UNSUPPORTED_SUCCESS_RESPONSE",
        "PrivacyAI blocked an unexpected successful AGY model response type."
      );
    }

    forwardResponseHeaders(response, upstream.headers, { transformed: true });
    response.writeHead(status);
    const restorer = new AgySseRestorer(sessionMap, context);
    for await (const chunk of upstream) {
      throwIfAborted(signal);
      for (const value of restorer.write(chunk)) await writeWithBackpressure(response, value);
    }
    for (const value of restorer.end()) await writeWithBackpressure(response, value);
    response.end();
    return;
  }

  const raw = await readBody(upstream, Number(context.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES));
  const textual = isTextualContentType(contentType);
  const body = textual
    ? Buffer.from(restoreText(raw.toString("utf8"), sessionMap))
    : raw;
  forwardResponseHeaders(response, upstream.headers, { transformed: textual });
  response.writeHead(status);
  response.end(body);
}

function handleConnect(request, clientSocket, head, context) {
  if (request.headers["proxy-authorization"] !== context.expectedAuthorization) {
    clientSocket.end(
      "HTTP/1.1 407 Proxy Authentication Required\r\n" +
      "Proxy-Authenticate: Basic realm=PrivacyAI\r\n" +
      "Connection: close\r\n\r\n"
    );
    return;
  }

  let target;
  try {
    target = parseConnectTarget(request.url);
  } catch {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }

  const intercept = target.host === context.modelHost && target.port === 443;
  const destinationHost = intercept ? LOOPBACK_HOST : target.host;
  const destinationPort = intercept ? context.interceptPort : target.port;
  const targetSocket = net.connect(destinationPort, destinationHost);
  context.sockets.add(targetSocket);
  targetSocket.once("close", () => context.sockets.delete(targetSocket));

  const fail = error => {
    reportError(context.options, error, "connect");
    if (!clientSocket.destroyed) {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
    targetSocket.destroy();
  };
  targetSocket.once("error", fail);
  clientSocket.once("error", () => targetSocket.destroy());
  clientSocket.once("close", () => targetSocket.destroy());
  targetSocket.once("connect", () => {
    targetSocket.off("error", fail);
    targetSocket.on("error", () => clientSocket.destroy());
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) targetSocket.write(head);
    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
  });
}

function makeUpstreamRequest(options) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: options.hostname,
      port: 443,
      method: options.method,
      path: options.path,
      headers: options.headers,
      servername: options.hostname,
      agent: options.agent
    }, resolve);
    const abort = () => request.destroy(abortError());
    if (options.signal) {
      if (options.signal.aborted) return abort();
      options.signal.addEventListener("abort", abort, { once: true });
    }
    request.once("error", reject);
    request.once("close", () => options.signal?.removeEventListener("abort", abort));
    request.end(options.body);
  });
}

export function buildAgyUpstreamHeaders(input, host, contentLength, options = {}) {
  const output = {};
  for (const [name, rawValue] of Object.entries(input || {})) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (options.modelRoute && normalized === "content-encoding") continue;
    if (options.modelRoute && normalized === "accept-encoding") continue;
    output[normalized] = rawValue;
  }
  output.host = host;
  if (contentLength != null) output["content-length"] = String(contentLength);
  if (options.modelRoute) output["accept-encoding"] = "identity";
  return output;
}

function forwardResponseHeaders(response, headers, options = {}) {
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (options.transformed && new Set(["content-encoding", "content-length"]).has(normalized)) continue;
    if (value != null) response.setHeader(name, value);
  }
  response.setHeader("cache-control", "no-store");
}

function readBody(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let ended = false;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.destroy();
        finish(proxyError("PRIVACYAI_AGY_BODY_TOO_LARGE", "PrivacyAI blocked an oversized AGY payload."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      ended = true;
      finish(null, Buffer.concat(chunks));
    };
    const onError = error => finish(error);
    const onClose = () => {
      if (!ended) finish(proxyError("PRIVACYAI_AGY_BODY_TRUNCATED", "AGY payload closed before completion."));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

function downstreamLifecycle(request, response) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(abortError());
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

function trackServerSockets(server, sockets) {
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

function parseConnectTarget(authority) {
  const match = String(authority || "").match(/^([^:\s]+):(\d{1,5})$/);
  if (!match) throw new Error("invalid CONNECT target");
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid CONNECT port");
  return { host: match[1].toLowerCase(), port };
}

function normalizeHostHeader(value) {
  return String(value || "").toLowerCase().replace(/:443$/, "");
}

function isModelPath(url) {
  return url.pathname === "/v1internal:streamGenerateContent";
}

function isAuditedOpaqueRoute(method, url) {
  return AUDITED_OPAQUE_ROUTES.get(String(method || "").toUpperCase())?.has(url.pathname) === true;
}

function isSupportedModelRoute(method, url) {
  const altValues = url.searchParams.getAll("alt");
  return method === "POST" && altValues.length === 1 && altValues[0] === "sse";
}

function isTextualContentType(value) {
  const mediaType = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json");
}

function mergeNoProxy(value) {
  const items = String(value || "").split(",").map(item => item.trim()).filter(Boolean);
  for (const required of ["127.0.0.1", "localhost"]) {
    if (!items.includes(required)) items.push(required);
  }
  return items.join(",");
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

function closeServers(servers, sockets) {
  const closing = servers.map(server => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  }));
  for (const server of servers) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  }
  for (const socket of sockets) socket.destroy();
  return Promise.all(closing);
}

function writeWithBackpressure(stream, value) {
  if (stream.destroyed || stream.writableEnded) return Promise.reject(abortError());
  if (stream.write(value)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(abortError()); };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

function isExpectedClientDisconnect(error, request, response) {
  const code = String(error?.code || "");
  if (!new Set([
    "ECONNRESET",
    "EPIPE",
    "ECONNABORTED",
    "PRIVACYAI_AGY_CLIENT_DISCONNECTED"
  ]).has(code)) return false;
  return request.aborted || request.destroyed || response.destroyed || response.writableEnded;
}

function writeProxyFailure(response, error) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const status = error?.code === "PRIVACYAI_AGY_BODY_TOO_LARGE" ? 413 : 502;
  const body = JSON.stringify({
    error: {
      type: "privacyai_gateway_error",
      code: error?.code || "PRIVACYAI_AGY_PROXY_FAILURE",
      message: "PrivacyAI stopped this AGY request because its privacy boundary could not be verified."
    }
  });
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function reportError(options, error, phase) {
  if (typeof options?.onProxyError !== "function") return;
  try {
    options.onProxyError({
      phase,
      code: error?.code || "PRIVACYAI_AGY_PROXY_FAILURE",
      name: error?.name || "Error",
      message: String(error?.message || ""),
      cause: error?.cause
        ? {
            code: error.cause.code || "",
            name: error.cause.name || "Error",
            message: String(error.cause.message || ""),
            status: Number.isInteger(Number(error.cause.details?.status))
              ? Number(error.cause.details.status)
              : null
          }
        : null
    });
  } catch {
    // Diagnostics must not affect the privacy boundary.
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : abortError();
}

function abortError() {
  const error = new Error("PrivacyAI stopped the AGY request because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_AGY_CLIENT_DISCONNECTED";
  return error;
}

function proxyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
