import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError, createPrivacyError } from "@privacy-ai/sdk";
import {
  createGatewayDiagnosticReporter,
  gatewayError,
  publicGatewayFailure,
  publicGatewayHttpStatus,
  publicGatewayMessage,
  safeGatewayDiagnostic
} from "../src/gateway-error.js";
import {
  createGatewayContractError,
  normalizeGatewayContractError
} from "../src/errors/gateway-policy.js";

const SECRET = "sk-private-gateway-token";
const PRIVATE_PROMPT = "send alice.private@example.test to the model";

const EXPECTED_MESSAGES = Object.freeze({
  timeout: "PrivacyAI timed out waiting for the upstream Codex service.",
  dns: "PrivacyAI could not resolve the upstream Codex service.",
  upstream: "PrivacyAI lost its connection to the upstream Codex service.",
  protocol: "PrivacyAI could not safely process the upstream Codex response protocol.",
  localModel: "PrivacyAI could not complete local privacy classification.",
  requestLimit: "PrivacyAI blocked an oversized Codex request.",
  cancelled: "Codex disconnected before PrivacyAI completed the request.",
  boundary: "PrivacyAI stopped this Codex request because its privacy boundary could not be verified.",
  fallback: "PrivacyAI stopped this Codex request because the local gateway failed."
});

test("gateway factories normalize explicit null options", () => {
  const error = createGatewayContractError(
    "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT",
    "Internal timeout.",
    null
  );

  assert.equal(error.code, "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT");
  assert.equal(error.category, "timeout");
  assert.equal(error.status, 504);
  assert.equal(error.retryable, true);
});

test("gatewayError preserves representative codes and internal messages", () => {
  const error = gatewayError(
    "PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT",
    "PrivacyAI blocked an unsupported Codex SSE event."
  );

  assert.ok(error instanceof Error);
  assert.equal(error.code, "PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT");
  assert.equal(error.message, "PrivacyAI blocked an unsupported Codex SSE event.");
  assert.equal(error.category, "protocol");
  assert.equal(error.status, 502);
  assert.equal(error.retryable, false);
  assert.equal(error.publicMessage, EXPECTED_MESSAGES.protocol);
  assert.equal(JSON.stringify(error), '{"code":"PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT"}');
});

test("gateway policies distinguish network failures without message inspection", () => {
  const cases = [
    ["ETIMEDOUT", "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT", "timeout", 504, EXPECTED_MESSAGES.timeout],
    ["ENOTFOUND", "PRIVACYAI_CODEX_UPSTREAM_DNS", "dns", 502, EXPECTED_MESSAGES.dns],
    ["EAI_AGAIN", "PRIVACYAI_CODEX_UPSTREAM_DNS", "dns", 502, EXPECTED_MESSAGES.dns],
    ["ECONNRESET", "PRIVACYAI_CODEX_UPSTREAM_RESET", "upstream_reset", 502, EXPECTED_MESSAGES.upstream],
    ["EPIPE", "PRIVACYAI_CODEX_UPSTREAM_BROKEN_PIPE", "broken_pipe", 502, EXPECTED_MESSAGES.upstream]
  ];

  for (const [networkCode, code, category, status, message] of cases) {
    const source = Object.assign(new Error(`network error ${SECRET}`), { code: networkCode });
    const normalized = normalizeGatewayContractError(source);
    assert.equal(normalized.code, code, networkCode);
    assert.equal(normalized.category, category, networkCode);
    assert.equal(normalized.status, status, networkCode);
    assert.equal(normalized.retryable, true, networkCode);
    assert.equal(normalized.publicMessage, message, networkCode);
    assert.equal(normalized.cause, source, networkCode);
  }
});

test("gateway policies cover limits, cancellation, local models, protocol, and boundaries", () => {
  const cases = [
    [gatewayError("PRIVACYAI_CODEX_BODY_TOO_LARGE", "oversized"), "request_limit", 413, false, EXPECTED_MESSAGES.requestLimit],
    [gatewayError("PRIVACYAI_CODEX_CLIENT_DISCONNECTED", "disconnected"), "client_cancelled", 502, false, EXPECTED_MESSAGES.cancelled],
    [gatewayError("PRIVACYAI_CODEX_INVALID_SSE", "invalid SSE"), "protocol", 502, false, EXPECTED_MESSAGES.protocol],
    [gatewayError("PRIVACYAI_INVALID_CLASSIFIER_SPAN", "invalid span"), "privacy_boundary", 422, false, EXPECTED_MESSAGES.boundary],
    [new ProviderError("Provider returned HTTP 400", { status: 400, bodyText: PRIVATE_PROMPT }), "local_model", 502, false, EXPECTED_MESSAGES.localModel],
    [new ProviderError("Provider returned HTTP 503", { status: 503, bodyText: PRIVATE_PROMPT }), "local_model", 502, true, EXPECTED_MESSAGES.localModel]
  ];

  for (const [source, category, status, retryable, message] of cases) {
    const normalized = normalizeGatewayContractError(source);
    assert.equal(normalized.category, category);
    assert.equal(normalized.status, status);
    assert.equal(normalized.retryable, retryable);
    assert.equal(normalized.publicMessage, message);
  }
});

test("public gateway helpers preserve existing external status and messages", () => {
  assert.deepEqual(publicGatewayFailure({ code: "ETIMEDOUT" }), {
    code: "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT",
    category: "timeout"
  });
  assert.deepEqual(publicGatewayFailure({ code: "PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT" }), {
    code: "PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT",
    category: "protocol"
  });
  assert.deepEqual(publicGatewayFailure({ code: "PRIVACYAI_CODEX_COMPRESSED_RESPONSE" }), {
    code: "PRIVACYAI_CODEX_COMPRESSED_RESPONSE",
    category: "upstream"
  });
  assert.deepEqual(publicGatewayFailure({ code: "PRIVACYAI_IMAGE_INVALID" }), {
    code: "PRIVACYAI_IMAGE_INVALID",
    category: "privacy_boundary"
  });
  assert.equal(publicGatewayHttpStatus({ code: "PRIVACYAI_CODEX_BODY_TOO_LARGE" }), 413);
  assert.equal(publicGatewayHttpStatus({ code: "PRIVACYAI_INVALID_CLASSIFIER_SPAN" }), 422);
  assert.equal(publicGatewayHttpStatus({ code: "ETIMEDOUT" }), 504);
  assert.equal(publicGatewayMessage({ code: "ETIMEDOUT" }), EXPECTED_MESSAGES.timeout);
  assert.equal(publicGatewayMessage({ code: "PRIVACYAI_INVALID_CLASSIFIER_SPAN" }), EXPECTED_MESSAGES.boundary);
  assert.equal(publicGatewayMessage({ code: "PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT" }), EXPECTED_MESSAGES.protocol);
});

test("unknown raw and factory codes fail closed to a safe gateway failure", () => {
  const unknown = Object.assign(new Error(`failed for ${PRIVATE_PROMPT}`), {
    name: SECRET,
    code: `PRIVACYAI_${SECRET}`,
    metadata: { token: SECRET }
  });
  assert.deepEqual(publicGatewayFailure(unknown), {
    code: "PRIVACYAI_CODEX_GATEWAY_FAILURE",
    category: "gateway"
  });
  assert.equal(publicGatewayMessage(unknown), EXPECTED_MESSAGES.fallback);

  const factoryUnknown = gatewayError("PRIVACYAI_FUTURE_EXTENSION_FAILURE", PRIVATE_PROMPT);
  assert.equal(factoryUnknown.code, "PRIVACYAI_CODEX_GATEWAY_FAILURE");
  assert.equal(factoryUnknown.category, "gateway");
  assert.equal(factoryUnknown.message, EXPECTED_MESSAGES.fallback);
});

test("known repository and runtime codes retain legacy gateway compatibility", () => {
  const codes = [
    "PRIVACYAI_CONTEXT_DB_UNAVAILABLE",
    "PRIVACYAI_CONTEXT_DB_WRITE_FAILED",
    "PRIVACYAI_CONTEXT_DB_CLOSED",
    "PRIVACYAI_CONTEXT_DB_SCHEMA_UNSUPPORTED",
    "PRIVACYAI_CONTEXT_DB_CORRUPT",
    "PRIVACYAI_CONTEXT_DB_RETRY_TIMEOUT",
    "PRIVACYAI_SESSION_MAP_FILE_CORRUPT",
    "PRIVACYAI_VAULT_CORRUPT",
    "PRIVACYAI_VAULT_LOCK_TIMEOUT",
    "PRIVACYAI_SERVER_CLOSE_TIMEOUT"
  ];

  for (const code of codes) {
    const source = Object.assign(new Error(`internal ${PRIVATE_PROMPT}`), { code });
    const normalized = normalizeGatewayContractError(source);
    assert.equal(normalized.code, code, code);
    assert.equal(normalized.category, "privacy_boundary", code);
    assert.equal(normalized.status, 422, code);
    assert.equal(normalized.retryable, false, code);
    assert.equal(normalized.publicMessage, EXPECTED_MESSAGES.boundary, code);
    assert.equal(normalized.cause, source, code);
  }

  assert.deepEqual(publicGatewayFailure({ code: "PRIVACYAI_CONTEXT_DB_FUTURE_FAILURE" }), {
    code: "PRIVACYAI_CODEX_GATEWAY_FAILURE",
    category: "gateway"
  });
});

test("canonical normalization keeps stable identity, phase, and safe diagnostics", () => {
  const storage = createPrivacyError({
    code: "PRIVACYAI_STORAGE_FAILURE",
    category: "storage",
    phase: "storage_write",
    message: `sqlite failure ${SECRET}`,
    publicMessage: "PrivacyAI could not access required local storage.",
    cause: new Error(PRIVATE_PROMPT),
    diagnostics: { attempt: 1, statusCode: 500 }
  });
  storage.code = "PRIVACYAI_CODEX_BODY_TOO_LARGE";

  const normalized = normalizeGatewayContractError(storage);
  assert.equal(normalized.code, "PRIVACYAI_STORAGE_FAILURE");
  assert.equal(normalized.category, "storage");
  assert.equal(normalized.phase, "storage_write");
  assert.equal(normalized.status, 500);
  assert.equal(normalized.retryable, false);
  assert.equal(normalized.publicMessage, "PrivacyAI could not access required local storage.");
  assert.deepEqual(normalized.diagnostics, { attempt: 1, statusCode: 500 });
  assert.equal(normalized.cause, storage);
});

test("legacy provider cancellation keeps its exposed compatibility code", () => {
  const cancelled = new ProviderError("Provider request cancelled.");
  cancelled.code = "PRIVACYAI_REQUEST_ABORTED";

  const normalized = normalizeGatewayContractError(cancelled);
  assert.equal(normalized.code, "PRIVACYAI_REQUEST_ABORTED");
  assert.equal(normalized.category, "client_cancelled");
  assert.equal(normalized.retryable, false);
});

test("gateway diagnostics are allowlisted, stable, and secret-free", () => {
  const cause = Object.assign(new Error(`reset during ${PRIVATE_PROMPT}`), {
    code: "ECONNRESET",
    authorization: `Bearer ${SECRET}`,
    output: SECRET
  });
  const diagnostic = safeGatewayDiagnostic(cause, {
    now: 1000,
    route: "responses",
    phase: "upstream_connect",
    retryCount: 1,
    downstreamClosed: false
  });

  assert.deepEqual(diagnostic, {
    timestamp: "1970-01-01T00:00:01.000Z",
    route: "responses",
    phase: "upstream_connect",
    networkCode: "ECONNRESET",
    retryCount: 1,
    downstreamClosed: false,
    code: "PRIVACYAI_CODEX_UPSTREAM_RESET",
    category: "upstream_reset"
  });
  const json = JSON.stringify(diagnostic);
  assert.equal(json.includes(SECRET), false);
  assert.equal(json.includes(PRIVATE_PROMPT), false);
  assert.deepEqual(Object.keys(diagnostic), [
    "timestamp",
    "route",
    "phase",
    "networkCode",
    "retryCount",
    "downstreamClosed",
    "code",
    "category"
  ]);

  const beforeFallback = Date.now();
  const fallbackTimestamp = Date.parse(safeGatewayDiagnostic(cause, { now: 1e20 }).timestamp);
  const afterFallback = Date.now();
  assert.ok(fallbackTimestamp >= beforeFallback && fallbackTimestamp <= afterFallback);

  assert.throws(
    () => safeGatewayDiagnostic(cause, { prompt: PRIVATE_PROMPT }),
    /do not allow prompt/
  );
  assert.throws(
    () => safeGatewayDiagnostic(cause, { metadata: { token: SECRET } }),
    /do not allow metadata/
  );
});

test("diagnostic reporters reject unsafe metadata observationally", () => {
  const diagnostics = [];
  const report = createGatewayDiagnosticReporter(value => diagnostics.push(value), {
    now: () => 1000
  });
  assert.equal(report({ code: "EPIPE" }, { route: "responses", prompt: PRIVATE_PROMPT }), false);
  assert.deepEqual(diagnostics, []);
  assert.equal(report({ code: "EPIPE" }, { route: "responses" }), true);
  assert.equal(diagnostics.length, 1);
  assert.equal(JSON.stringify(diagnostics).includes(PRIVATE_PROMPT), false);
});
