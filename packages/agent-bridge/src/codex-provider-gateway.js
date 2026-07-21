import { randomBytes } from "node:crypto";
import http from "node:http";

import { restoreText } from "@privacy-ai/sdk";
import { createCodexImageSanitizer } from "./codex-image-adapter.js";
import {
  codexSessionContext,
  pruneCodexArgumentKeyMappings,
  restoreCodexCompactResponse,
  restoreCodexJsonResponse,
  sanitizeCodexMetadataHeaders,
  sanitizeCodexRequestBody
} from "./codex-request-transform.js";
import { CodexSseRestorer } from "./codex-sse-transform.js";
import {
  closeHttpServer,
  listenOnHost,
  nextHttpChunk,
  readBoundedHttpBody,
  requestCodexUpstream,
  resolvePositiveDuration
} from "./codex-http-transport.js";
import { retryContextStoreOperation } from "./context-store-retry.js";
import {
  openContextVerificationStore,
  updateRepositoryThread,
  verificationFingerprint
} from "./context-verification-store.js";
import {
  createGatewayDiagnosticReporter,
  gatewayError,
  publicGatewayFailure,
  publicGatewayHttpStatus,
  publicGatewayMessage
} from "./gateway-error.js";
import {
  commitCodexMutationHistory,
  stageCompletedCodexToolCalls
} from "./codex-mutation-tracker.js";
import { runCleanupSteps } from "./resource-cleanup.js";
import {
  createDownstreamLifecycle,
  throwIfAborted as throwIfRuntimeAborted
} from "./runtime/downstream-lifecycle.js";
import {
  HOP_BY_HOP_HEADERS,
  copyHttpHeaders,
  forwardHttpHeaders
} from "./runtime/http-headers.js";
import { trackServerSockets } from "./runtime/http-server.js";
import { writeWithBackpressure as writeRuntimeWithBackpressure } from "./runtime/stream-io.js";
import { SessionVault } from "./session-vault.js";
import { recordFailedProviderResponse, recordLineageBestEffort } from "./lineage/recorder.js";
import {
  openInstallationPrivacyIdentity,
  privacyIdentityMetadata,
  sessionPrivacyIdentity
} from "./privacy-identity.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_VERIFICATION_RETRY_TIMEOUT_MS = 2500;
const MAX_ALIASES_PER_ORIGINAL = 8;
const CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
const API_UPSTREAM = "https://api.openai.com/v1";
const CODEX_TRANSPORT_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
  "content-encoding"
]);

export function resolveCodexGatewayTimeouts(options = {}) {
  return Object.freeze({
    responseHeadersMs: resolvePositiveDuration(
      options.upstreamTimeoutMs,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      "Codex upstream response-header timeout"
    ),
    responseIdleMs: resolvePositiveDuration(
      options.upstreamIdleTimeoutMs,
      DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
      "Codex upstream idle timeout"
    )
  });
}

export async function startCodexProviderGateway(options = {}) {
  if (typeof options.sanitizer !== "function") {
    throw new TypeError("Codex provider gateway requires a local sanitizer function.");
  }

  const timeouts = resolveCodexGatewayTimeouts(options);
  const nonce = options.nonce || randomBytes(24).toString("hex");
  const identityRoot = await openInstallationPrivacyIdentity(options);
  const vault = options.vault || new SessionVault({ ...options, identityRoot });
  const imageSanitizer = options.imageSanitizer || createCodexImageSanitizer(options.imageSanitizerOptions);
  const ownsImageSanitizer = !options.imageSanitizer;
  let verificationStore;
  try {
    verificationStore = await openContextVerificationStore(options);
  } catch (error) {
    await closeGatewayResources({
      imageSanitizer,
      ownsImageSanitizer,
      primaryError: error
    });
    throw error;
  }
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
  const maintenance = { verificationRequestCount: 0 };
  const reportDiagnostic = createGatewayDiagnosticReporter(options.onGatewayError, {
    maxEntries: options.diagnosticDedupMaxEntries,
    windowMs: options.diagnosticDedupWindowMs,
    now: options.diagnosticNow
  });
  const sharedContext = {
    ...options,
    nonce,
    identityRoot,
    vault,
    imageSanitizer,
    verificationStore,
    policyFingerprint,
    serial,
    sessionCaches,
    maintenance,
    reportDiagnostic,
    upstreamTimeoutMs: timeouts.responseHeadersMs,
    upstreamIdleTimeoutMs: timeouts.responseIdleMs,
    verificationRetryTimeoutMs: resolvePositiveDuration(
      options.verificationRetryTimeoutMs,
      DEFAULT_VERIFICATION_RETRY_TIMEOUT_MS,
      "context-store retry timeout"
    )
  };
  const server = http.createServer((request, response) => {
    handleRequest(request, response, sharedContext).catch(error => {
      writeGatewayFailure(response, error);
    });
  });
  trackServerSockets(server, sockets);
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
  });

  try {
    await listenOnHost(server, options.port || 0, LOOPBACK_HOST);
  } catch (error) {
    await closeGatewayResources({
      imageSanitizer,
      ownsImageSanitizer,
      verificationStore,
      ownsVerificationStore,
      primaryError: error
    });
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    const error = new Error("PrivacyAI could not determine the Codex gateway address.");
    await closeGatewayResources({
      server,
      sockets,
      imageSanitizer,
      ownsImageSanitizer,
      verificationStore,
      ownsVerificationStore,
      primaryError: error
    });
    throw error;
  }

  let closePromise = null;
  return {
    host: LOOPBACK_HOST,
    port: address.port,
    nonce,
    baseURL: "http://" + LOOPBACK_HOST + ":" + address.port + "/" + nonce,
    close() {
      closePromise ||= (async () => {
        sessionCaches.clear();
        await closeGatewayResources({
          server,
          sockets,
          imageSanitizer,
          ownsImageSanitizer,
          verificationStore,
          ownsVerificationStore
        });
      })();
      return closePromise;
    }
  };
}


async function handleRequest(request, response, context) {
  const lifecycle = codexDownstreamLifecycle(request, response);
  const requestContext = {
    ...context,
    requestSignal: lifecycle.signal
  };
  try {
    return await handleRequestCore(request, response, requestContext);
  } catch (error) {
    const failure = lifecycle.downstreamClosed() && !isCancellationError(error)
      ? gatewayError("PRIVACYAI_CODEX_CLIENT_DISCONNECTED", "PrivacyAI stopped the Codex request because the client disconnected.")
      : error;
    if (!isCancellationError(failure)) {
      reportGatewayError(requestContext, failure, {
        route: requestContext.route,
        phase: requestContext.phase || "request",
        retryCount: 0,
        downstreamClosed: lifecycle.downstreamClosed()
      });
    }
    throw failure;
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
  context.route = safeRouteIdentifier(suffix);
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

  const rawBody = await readBoundedHttpBody(
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
  const privacyIdentity = sessionPrivacyIdentity(context.identityRoot, identity.sessionKey);
  const transformed = await context.serial.run(identity.sessionKey, async () => {
    throwIfAborted(context.requestSignal);
    const currentVault = await context.vault.load(identity.sessionKey);
    const currentThread = await runVerificationStoreOperation(
      context,
      () => context.verificationStore.loadThread(identity.sessionKey)
    );
    const currentSessionMap = mergeInheritedSessionMap(
      currentVault?.sessionMap || {},
      currentThread.sessionMap || {}
    );
    let sessionMap = { ...currentSessionMap };
    for (const parentSessionKey of identity.parentSessionKeys) {
      const parentVault = await context.vault.load(parentSessionKey);
      const parentThread = await runVerificationStoreOperation(
        context,
        () => context.verificationStore.loadThread(parentSessionKey)
      );
      if (parentVault?.sessionMap) {
        sessionMap = mergeInheritedSessionMap(sessionMap, parentVault.sessionMap);
      }
      if (parentThread?.sessionMap) {
        sessionMap = mergeInheritedSessionMap(sessionMap, parentThread.sessionMap);
      }
    }
    sessionMap = pruneCodexArgumentKeyMappings(body, sessionMap);

    await commitCodexMutationHistory(body, identity.sessionKey, sessionMap, context);

    const cache = sessionCache(context, identity.sessionKey);
    const result = await sanitizeCodexRequestBody(body, {
      sanitizer: context.sanitizer,
      imageSanitizer: context.imageSanitizer,
      identity: privacyIdentity,
      identityRoot: context.identityRoot,
      sessionMap,
      cache,
      policyFingerprint: context.policyFingerprint,
      maxContextChars: context.maxContextChars,
      maxContextTokens: context.maxContextTokens,
      tokenCounter: context.tokenCounter,
      headers: request.headers,
      signal: context.requestSignal,
      onBatchComplete: context.onSanitizerBatchComplete,
      onArtifactComplete: context.onSanitizerArtifactComplete,
      onSchemaTrace: context.onSchemaTrace
    });
    const completeMap = { ...sessionMap, ...result.sessionMapAdditions };
    const lineageHandle = await recordLineageBestEffort(context.lineageRecorder, "protectedRequest", {
      sessionKey: identity.sessionKey, provider: "codex", operation: "responses.create",
      model: typeof body.model === "string" ? body.model : undefined,
      placeholders: Object.keys(completeMap), cacheActivity: { hits: result.metrics?.cacheHitCount, misses: result.metrics?.uncachedSlotCount, writes: result.cacheWrites.length }, signal: context.requestSignal
    });
    throwIfAborted(context.requestSignal);
    if (!sessionMapsEqual(currentVault?.sessionMap || {}, completeMap)) {
      await context.vault.save(identity.sessionKey, completeMap);
    }
    await runVerificationStoreOperation(context, () =>
      updateRepositoryThread(context.verificationStore, identity.sessionKey, () => ({
        baseSessionMap: currentThread.sessionMap || {},
        parentSessionKeys: identity.parentSessionKeys,
        sessionMap: completeMap,
        policyFingerprint: context.policyFingerprint,
        ...privacyIdentityMetadata(privacyIdentity, completeMap)
      }))
    );
    if (typeof context.onSanitizedRequest === "function") {
      await context.onSanitizedRequest(result.body, {
        sessionKey: identity.sessionKey,
        route: suffix
      });
    }
    await runVerificationStoreOperation(context, () => commitCacheWrites(
      cache,
      result.cacheWrites,
      Number(context.maxCacheEntriesPerSession || 2048),
      context.verificationStore
    ));
    for (const item of result.itemRecords || []) {
      await runVerificationStoreOperation(context, () =>
        context.verificationStore.recordThreadItem({
          ...item,
          sessionKey: identity.sessionKey
        })
      );
    }
    context.maintenance.verificationRequestCount += 1;
    if (context.maintenance.verificationRequestCount % 100 === 0) {
      await runVerificationStoreOperation(context, () => context.verificationStore.prune());
    }
    return {
      body: result.body,
      sessionMap: completeMap,
      sessionKey: identity.sessionKey,
      lineageHandle
    };
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
    transformed.body.stream === true,
    transformed.sessionKey,
    transformed.lineageHandle
  );
}

async function proxyModels(request, response, context, suffix, search) {
  const upstream = upstreamUrl(request.headers, context, suffix, search);
  const sanitizedHeaders = sanitizeCodexMetadataHeaders(request.headers);
  const headers = upstreamHeaders(sanitizedHeaders, upstream, null);
  context.phase = "upstream_connect";
  const upstreamResponse = await requestCodexUpstream(upstream, request.method, headers, null, {
    signal: context.requestSignal,
    timeoutMs: context.upstreamTimeoutMs
  });
  context.phase = "upstream_response";
  assertIdentityResponseEncoding(upstreamResponse);
  const statusCode = upstreamResponse.statusCode || 502;
  const raw = await readBoundedHttpBody(
    upstreamResponse,
    Number(context.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES),
    { destroyOnLimit: true, idleTimeoutMs: context.upstreamIdleTimeoutMs }
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
  expectsSse,
  sessionKey,
  lineageHandle
) {
  const upstream = upstreamUrl(request.headers, context, suffix, search);
  const sanitizedHeaders = sanitizeCodexMetadataHeaders(request.headers);
  const headers = upstreamHeaders(sanitizedHeaders, upstream, body.length);
  context.phase = "upstream_connect";
  let upstreamSent = false;
  let upstreamResponse;
  try {
    upstreamResponse = await requestCodexUpstream(upstream, "POST", headers, body, {
      signal: context.requestSignal,
      timeoutMs: context.upstreamTimeoutMs,
      onRequestSent: () => { upstreamSent = true; }
    });
  } catch (error) {
    if (upstreamSent) await recordFailedProviderResponse(context.lineageRecorder, lineageHandle);
    throw error;
  }
  context.phase = "upstream_response";

  assertIdentityResponseEncoding(upstreamResponse);

  const contentType = String(upstreamResponse.headers["content-type"] || "").toLowerCase();
  const statusCode = upstreamResponse.statusCode || 502;
  await recordLineageBestEffort(context.lineageRecorder, "providerResponse", lineageHandle, {
    success: statusCode >= 200 && statusCode < 300
  });
  const headerlessExpectedSse =
    expectsSse && contentType.trim() === "" && statusCode >= 200 && statusCode < 300;
  if (contentType.includes("text/event-stream") || headerlessExpectedSse) {
    context.phase = "sse";
    await proxySseResponse(response, upstreamResponse, context, sessionMap, statusCode, {
      forceContentType: headerlessExpectedSse,
      sessionKey
    });
    await recordLineageBestEffort(context.lineageRecorder, "restoration", lineageHandle);
    return;
  }

  if (statusCode >= 400 && contentType.trim() === "") {
    const raw = await readBoundedHttpBody(
      upstreamResponse,
      Number(context.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES),
      { destroyOnLimit: true, idleTimeoutMs: context.upstreamIdleTimeoutMs }
    );
    forwardResponseHeaders(response, upstreamResponse.headers, true);
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.writeHead(statusCode);
    response.end(restoreText(raw.toString("utf8"), sessionMap));
    await recordLineageBestEffort(context.lineageRecorder, "restoration", lineageHandle);
    return;
  }

  if (!contentType.includes("application/json") && !contentType.startsWith("text/")) {
    upstreamResponse.destroy();
    throw gatewayError(
      "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_TYPE",
      `PrivacyAI blocked an unsupported Codex provider response type (status=${statusCode}, content-type=${safeContentType(contentType)}).`
    );
  }

  const raw = await readBoundedHttpBody(
    upstreamResponse,
    Number(context.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES),
    { destroyOnLimit: true, idleTimeoutMs: context.upstreamIdleTimeoutMs }
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
  await recordLineageBestEffort(context.lineageRecorder, "restoration", lineageHandle);
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
    const next = await nextHttpChunk(
      iterator,
      upstreamResponse,
      context.upstreamIdleTimeoutMs
    );
    done = Boolean(next.done);
    if (done) {
      staged.push(...restorer.end());
      await stageCompletedCodexToolCalls(
        restorer.drainCompletedToolCalls(),
        options.sessionKey,
        sessionMap,
        context
      );
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
    await stageCompletedCodexToolCalls(
      restorer.drainCompletedToolCalls(),
      options.sessionKey,
      sessionMap,
      context
    );
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
      const next = await nextHttpChunk(
        iterator,
        upstreamResponse,
        context.upstreamIdleTimeoutMs
      );
      done = Boolean(next.done);
      if (!done) {
        const outputs = restorer.write(next.value);
        await stageCompletedCodexToolCalls(
          restorer.drainCompletedToolCalls(),
          options.sessionKey,
          sessionMap,
          context
        );
        for (const output of outputs) {
          await writeWithBackpressure(response, output);
        }
      }
    }
    const finalOutputs = restorer.end();
    await stageCompletedCodexToolCalls(
      restorer.drainCompletedToolCalls(),
      options.sessionKey,
      sessionMap,
      context
    );
    for (const output of finalOutputs) await writeWithBackpressure(response, output);
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
  const headers = copyHttpHeaders(source, CODEX_TRANSPORT_HEADERS, {
    excludedPrefixes: ["x-forwarded-"]
  });
  headers.host = upstream.host;
  headers["accept-encoding"] = "identity";
  if (contentLength != null) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(contentLength);
  }
  return headers;
}

function forwardResponseHeaders(response, headers, transformed) {
  forwardHttpHeaders(response, headers, CODEX_TRANSPORT_HEADERS);
  if (transformed) {
    response.removeHeader("content-length");
    response.removeHeader("content-encoding");
  }
}

function applyLocalResponseSecurityHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
}

function codexDownstreamLifecycle(request, response) {
  return createDownstreamLifecycle(request, response, () => gatewayError(
    "PRIVACYAI_CODEX_CLIENT_DISCONNECTED",
    "PrivacyAI stopped the Codex request because the client disconnected."
  ));
}

function throwIfAborted(signal) {
  throwIfRuntimeAborted(signal, () => gatewayError(
    "PRIVACYAI_REQUEST_ABORTED",
    "PrivacyAI stopped the Codex request because the client disconnected."
  ));
}

function isCancellationError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "PRIVACYAI_REQUEST_ABORTED" ||
    error?.code === "PRIVACYAI_CODEX_CLIENT_DISCONNECTED"
  );
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

function reportGatewayError(context, error, metadata) {
  context?.reportDiagnostic?.(error, metadata);
}

function safeRouteIdentifier(suffix) {
  if (suffix === "/responses") return "responses";
  if (suffix === "/responses/compact") return "responses_compact";
  if (suffix === "/models") return "models";
  return "gateway";
}

function writeGatewayFailure(response, error) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const { code } = publicGatewayFailure(error);
  const status = publicGatewayHttpStatus(error);
  writeJson(response, status, {
    error: {
      type: "privacyai_gateway_error",
      code,
      message: publicGatewayMessage(error)
    }
  });
}

function writeWithBackpressure(stream, value) {
  return writeRuntimeWithBackpressure(stream, value, () => gatewayError(
    "PRIVACYAI_CODEX_CLIENT_DISCONNECTED",
    "PrivacyAI stopped writing because the Codex client disconnected."
  ));
}

async function closeGatewayResources(options) {
  await runCleanupSteps([
    {
      name: "server",
      run: () => options.server ? closeHttpServer(options.server, options.sockets || new Set()) : undefined
    },
    {
      name: "image-sanitizer",
      run: () => options.ownsImageSanitizer ? options.imageSanitizer?.close() : undefined
    },
    {
      name: "verification-store",
      run: () => options.ownsVerificationStore ? Promise.resolve(options.verificationStore?.close()) : undefined
    }
  ], {
    primaryError: options.primaryError,
    message: "PrivacyAI could not fully close the Codex provider gateway."
  });
}

function runVerificationStoreOperation(context, operation) {
  return retryContextStoreOperation(operation, {
    signal: context.requestSignal,
    timeoutMs: context.verificationRetryTimeoutMs
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
