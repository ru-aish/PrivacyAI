import assert from "node:assert/strict";
import test from "node:test";

import {
  PrivacyError,
  PrivacyGuardianError,
  ProviderError,
  createPrivacyError,
  isPrivacyError,
  sanitizePrivacyDiagnostics,
  serializePrivacyError
} from "../src/index.js";

const SECRET = "sk-private-test-token";
const PRIVATE_PROMPT = "classify alice.private@example.test";

test("canonical errors preserve Error behavior and explicit policy fields", () => {
  const cause = new Error(`upstream exposed ${SECRET}`);
  const error = createPrivacyError({
    code: "PRIVACYAI_TEST_TIMEOUT",
    category: "timeout",
    phase: "upstream_connect",
    message: "Internal timeout context.",
    publicMessage: "PrivacyAI timed out while completing the test request.",
    cause,
    diagnostics: { networkCode: "ETIMEDOUT", retryCount: 2 }
  });

  assert.ok(error instanceof Error);
  assert.ok(error instanceof PrivacyError);
  assert.equal(isPrivacyError(error), true);
  assert.equal(error.name, "PrivacyError");
  assert.equal(error.code, "PRIVACYAI_TEST_TIMEOUT");
  assert.equal(error.message, "Internal timeout context.");
  assert.equal(error.category, "timeout");
  assert.equal(error.phase, "upstream_connect");
  assert.equal(error.status, 504);
  assert.equal(error.retryable, true);
  assert.equal(error.publicMessage, "PrivacyAI timed out while completing the test request.");
  assert.equal(error.cause, cause);
  assert.deepEqual(error.diagnostics, { networkCode: "ETIMEDOUT", retryCount: 2 });
});

test("safe serialization excludes causes, internal messages, and legacy details", () => {
  const error = createPrivacyError({
    code: "PRIVACYAI_TEST_STORAGE_FAILURE",
    category: "storage",
    phase: "storage_write",
    message: `failed to write ${PRIVATE_PROMPT}`,
    publicMessage: "PrivacyAI could not write required local state.",
    cause: new Error(`filesystem contained ${SECRET}`),
    diagnostics: { attempt: 1, statusCode: 500 }
  });

  const serialized = serializePrivacyError(error);
  assert.deepEqual(serialized, {
    code: "PRIVACYAI_TEST_STORAGE_FAILURE",
    category: "storage",
    phase: "storage_write",
    status: 500,
    retryable: false,
    message: "PrivacyAI could not write required local state.",
    diagnostics: { attempt: 1, statusCode: 500 }
  });
  const json = JSON.stringify(serialized);
  assert.equal(json.includes(PRIVATE_PROMPT), false);
  assert.equal(json.includes(SECRET), false);
  assert.equal(Object.hasOwn(serialized, "cause"), false);
});

test("unknown values serialize to a closed generic internal failure", () => {
  const unknown = Object.assign(new Error(`secret ${SECRET}`), {
    code: `PRIVACYAI_${SECRET}`,
    details: PRIVATE_PROMPT
  });
  assert.deepEqual(serializePrivacyError(unknown), {
    code: "PRIVACYAI_INTERNAL_FAILURE",
    category: "internal",
    phase: null,
    status: 500,
    retryable: false,
    message: "PrivacyAI encountered an internal failure.",
    diagnostics: {}
  });
});

test("unknown categories cannot override the closed internal policy", () => {
  const error = createPrivacyError({
    code: "PRIVACYAI_TEST_UNKNOWN_CATEGORY",
    category: "future_category",
    status: 418,
    retryable: true,
    message: `internal ${PRIVATE_PROMPT}`,
    publicMessage: `public ${SECRET}`
  });

  assert.equal(error.category, "internal");
  assert.equal(error.status, 500);
  assert.equal(error.retryable, false);
  assert.equal(error.publicMessage, "PrivacyAI encountered an internal failure.");
  assert.throws(() => { error.publicMessage = SECRET; }, TypeError);

  error.code = "PRIVACYAI_MUTATED_COMPATIBILITY_CODE";
  assert.deepEqual(serializePrivacyError(error), {
    code: "PRIVACYAI_TEST_UNKNOWN_CATEGORY",
    category: "internal",
    phase: null,
    status: 500,
    retryable: false,
    message: "PrivacyAI encountered an internal failure.",
    diagnostics: {}
  });
});

test("diagnostic metadata accepts only bounded allowlisted fields", () => {
  assert.deepEqual(sanitizePrivacyDiagnostics({
    networkCode: "econnreset",
    retryCount: 1,
    attempt: 2,
    downstreamClosed: false,
    timeoutMs: 1000,
    statusCode: 502
  }), {
    networkCode: "ECONNRESET",
    retryCount: 1,
    attempt: 2,
    downstreamClosed: false,
    timeoutMs: 1000,
    statusCode: 502
  });

  assert.throws(
    () => sanitizePrivacyDiagnostics({ prompt: PRIVATE_PROMPT }),
    /does not allow prompt/
  );
  assert.throws(
    () => sanitizePrivacyDiagnostics({ arbitrary: { secret: SECRET } }),
    /does not allow arbitrary/
  );
  assert.throws(
    () => sanitizePrivacyDiagnostics({ retryCount: 100 }),
    /between 0 and 99/
  );
});

test("nullable compatibility options normalize without changing legacy behavior", () => {
  const guardian = new PrivacyGuardianError("Legacy guardian failure.", undefined, null);
  const provider = new ProviderError("Provider returned HTTP 503", { status: 503 }, null);

  assert.equal(guardian.name, "PrivacyGuardianError");
  assert.equal(guardian.code, undefined);
  assert.equal(provider.name, "ProviderError");
  assert.equal(provider.status, 503);
  assert.equal(provider.retryable, true);
  assert.throws(
    () => createPrivacyError(null),
    /stable PRIVACYAI_\* code/
  );
  assert.throws(
    () => new PrivacyError("Invalid options.", []),
    /options must be a plain object/
  );
});

test("legacy guardian and provider errors retain their public surface", () => {
  const guardianDetails = { reason: "legacy" };
  const guardian = new PrivacyGuardianError("Legacy guardian failure.", guardianDetails);
  assert.ok(guardian instanceof Error);
  assert.ok(guardian instanceof PrivacyError);
  assert.equal(guardian.name, "PrivacyGuardianError");
  assert.equal(guardian.message, "Legacy guardian failure.");
  assert.equal(guardian.details, guardianDetails);
  assert.equal(guardian.code, undefined);

  const providerCause = new Error(`provider body ${SECRET}`);
  const provider = new ProviderError("Provider returned HTTP 503", {
    status: 503,
    bodyText: PRIVATE_PROMPT,
    error: providerCause
  });
  assert.ok(provider instanceof PrivacyGuardianError);
  assert.equal(provider.name, "ProviderError");
  assert.equal(provider.message, "Provider returned HTTP 503");
  assert.equal(provider.details.status, 503);
  assert.equal(provider.code, undefined, "legacy transient retry checks must not see a PRIVACYAI_* code");
  assert.equal(provider.category, "local_model");
  assert.equal(provider.status, 503);
  assert.equal(provider.retryable, true);
  assert.equal(provider.cause, providerCause);
  const serialized = JSON.stringify(serializePrivacyError(provider));
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(PRIVATE_PROMPT), false);
});

test("representative policies cover cancellation and privacy-boundary failures", () => {
  const cancelled = createPrivacyError({
    code: "PRIVACYAI_REQUEST_ABORTED",
    category: "client_cancelled",
    message: "Client disconnected."
  });
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.retryable, false);

  const boundary = createPrivacyError({
    code: "PRIVACYAI_PROVIDER_PAYLOAD_LEAK",
    category: "privacy_boundary",
    phase: "sanitization",
    message: "Protected content remained."
  });
  assert.equal(boundary.status, 422);
  assert.equal(boundary.retryable, false);
});

test("direct and explicit serialization remain stable for CLI and JSON consumers", () => {
  const error = createPrivacyError({
    code: "PRIVACYAI_TEST_PROTOCOL_FAILURE",
    category: "protocol",
    phase: "sse",
    message: "Malformed upstream event.",
    publicMessage: "PrivacyAI could not safely process the upstream protocol.",
    diagnostics: { networkCode: "NONE", retryCount: 0, downstreamClosed: false }
  });

  assert.equal(JSON.stringify(error), '{"code":"PRIVACYAI_TEST_PROTOCOL_FAILURE"}');
  assert.equal(
    JSON.stringify(serializePrivacyError(error)),
    '{"code":"PRIVACYAI_TEST_PROTOCOL_FAILURE","category":"protocol","phase":"sse","status":502,"retryable":false,"message":"PrivacyAI could not safely process the upstream protocol.","diagnostics":{"networkCode":"NONE","retryCount":0,"downstreamClosed":false}}'
  );
});
