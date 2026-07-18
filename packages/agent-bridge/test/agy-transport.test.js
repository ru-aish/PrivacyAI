import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import tls from "node:tls";
import test from "node:test";

import {
  normalizeAgySessionMap,
  sanitizeAgyRequestBody
} from "../src/agy-request-transform.js";
import { createAgySessionController } from "../src/agy-session-controller.js";
import { AgySseRestorer, restoreAgySseEvent } from "../src/agy-sse-transform.js";
import { buildAgyUpstreamHeaders } from "../src/agy-transport-proxy.js";
import { startAgyTransportRuntime } from "../src/agy-transport-runtime.js";
import { MemoryContextVerificationStore } from "../src/context-verification-store.js";
import { hookFileMutationId } from "../src/hook-file-mutation.js";
import { createEphemeralTlsAuthority } from "../src/ephemeral-tls-authority.js";
import { mergeSessionMaps } from "../src/model-session-state.js";
import { SessionVault } from "../src/session-vault.js";

const PRIVATE_EMAIL = "alice.private@example.test";
const PRIVATE_KEY = "agy-local-secret-key";
const MODEL_SSE_PATH = "/v1internal:streamGenerateContent?alt=sse";
const MODEL_SSE_PATH_WITH_EXTRA_QUERY = `${MODEL_SSE_PATH}&client=agy-test`;
const SESSION_MAP = {
  "[EMAIL_1]": PRIVATE_EMAIL,
  "[API_KEY_1]": PRIVATE_KEY,
  "[TOOL_1]": "send_private_email"
};

async function deterministicSanitizer(text) {
  let sanitizedPrompt = text;
  const additions = {};
  for (const [placeholder, original] of Object.entries(SESSION_MAP)) {
    if (!sanitizedPrompt.toLowerCase().includes(original.toLowerCase())) continue;
    sanitizedPrompt = sanitizedPrompt.replace(new RegExp(escapeRegExp(original), "gi"), placeholder);
    additions[placeholder] = original;
  }
  return { sanitizedPrompt, sessionMap: additions };
}

test("AGY request transformation sanitizes per-item artifacts and preserves the envelope", async () => {
  const body = sampleRequest();
  const result = await sanitizeAgyRequestBody(body, { sanitizer: deterministicSanitizer });

  assert.equal(result.sessionKey, "agy:session-123");
  assert.equal(result.body.project, body.project);
  assert.equal(result.body.requestId, body.requestId);
  assert.equal(result.body.model, body.model);
  assert.equal(JSON.stringify(result.body).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(result.body).includes(PRIVATE_KEY), false);
  assert.match(result.body.request.contents[0].parts[0].text, /\[EMAIL_1\]/);
  assert.match(result.body.request.contents[1].parts[0].functionResponse.response.output, /\[API_KEY_1\]/);
  const toolAlias = result.body.request.tools[0].functionDeclarations[0].name;
  assert.match(toolAlias, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
  assert.notEqual(toolAlias, "send_private_email");
  assert.equal(result.sessionMapAdditions[toolAlias], "send_private_email");
  assert.match(result.body.request.tools[0].functionDeclarations[0].description, /\[EMAIL_1\]/);
  assert.equal(result.sessionMapAdditions["[EMAIL_1]"], PRIVATE_EMAIL);
  assert.equal(result.sessionMapAdditions["[API_KEY_1]"], PRIVATE_KEY);
  assert.equal(Object.hasOwn(result.sessionMapAdditions, "[TOOL_1]"), false);
  assert.equal(result.itemRecords.length, 6);
  assert.equal(result.schemaTraces.length, 1);
  assert.equal(result.schemaTraces[0].structurePreserved, true);
  assert.equal(result.schemaTraces[0].sanitizedAnnotationCount, 0);
});

test("AGY tool schemas sanitize only prose annotations and preserve future structure", async () => {
  const body = sampleRequest();
  const declaration = body.request.tools[0].functionDeclarations[0];
  declaration.parameters = {
    type: "OBJECT",
    description: `Parameters for ${PRIVATE_EMAIL}`,
    properties: {
      recipient: {
        type: "STRING",
        title: `Recipient ${PRIVATE_KEY}`,
        enum: ["primary", "secondary"],
        default: { description: "DEFAULT_DESCRIPTION_SENTINEL" }
      }
    },
    required: ["recipient"],
    $defs: { Output: { type: "STRING" } },
    allOf: [{ $ref: "#/$defs/Output" }],
    "x-future-provider-control": {
      description: "EXTENSION_DESCRIPTION_SENTINEL"
    }
  };
  body.request.generationConfig.responseSchema = {
    type: "object",
    description: `Output for ${PRIVATE_EMAIL}`,
    properties: { status: { type: "string" } },
    required: ["status"]
  };

  const sanitizerInputs = [];
  const traces = [];
  const result = await sanitizeAgyRequestBody(body, {
    sanitizer: async text => {
      sanitizerInputs.push(text);
      return deterministicSanitizer(text);
    },
    onSchemaTrace: trace => traces.push(trace)
  });

  const schema = result.body.request.tools[0].functionDeclarations[0].parameters;
  assert.equal(schema.description, "Parameters for [EMAIL_1]");
  assert.equal(schema.properties.recipient.title, "Recipient [API_KEY_1]");
  assert.deepEqual(schema.properties.recipient.enum, ["primary", "secondary"]);
  assert.deepEqual(schema.required, ["recipient"]);
  assert.equal(schema.allOf[0].$ref, "#/$defs/Output");
  assert.deepEqual(schema.$defs, { Output: { type: "STRING" } });
  assert.deepEqual(schema.properties.recipient.default, {
    description: "DEFAULT_DESCRIPTION_SENTINEL"
  });
  assert.deepEqual(schema["x-future-provider-control"], {
    description: "EXTENSION_DESCRIPTION_SENTINEL"
  });
  assert.equal(
    result.body.request.generationConfig.responseSchema.description,
    "Output for [EMAIL_1]"
  );

  const inspected = JSON.stringify(sanitizerInputs);
  for (const immutableValue of [
    "#/$defs/Output",
    "DEFAULT_DESCRIPTION_SENTINEL",
    "EXTENSION_DESCRIPTION_SENTINEL",
    "primary",
    "secondary"
  ]) {
    assert.equal(inspected.includes(immutableValue), false);
  }
  assert.equal(traces.length, 2);
  assert.equal(traces.every(trace => trace.structurePreserved), true);
  assert.equal(traces.reduce((count, trace) => count + trace.sanitizedAnnotationCount, 0), 3);
  assert.deepEqual(result.schemaTraces, traces);

  const protectedIdentifier = sampleRequest();
  protectedIdentifier.request.tools[0].functionDeclarations[0].parameters = {
    type: "object",
    properties: { [PRIVATE_EMAIL]: { type: "string" } }
  };
  await assert.rejects(
    sanitizeAgyRequestBody(protectedIdentifier, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_AGY_TOOL_STRUCTURE_IMMUTABLE_PROTECTED_VALUE" &&
      !error.message.includes(PRIVATE_EMAIL)
  );

  const protectedFutureField = sampleRequest();
  protectedFutureField.request.tools[0].functionDeclarations[0].parameters = {
    type: "object",
    "x-future-provider-control": { token: PRIVATE_KEY }
  };
  await assert.rejects(
    sanitizeAgyRequestBody(protectedFutureField, {
      sanitizer: deterministicSanitizer,
      sessionMap: { "[API_KEY_1]": PRIVATE_KEY }
    }),
    error => error?.code === "PRIVACYAI_AGY_TOOL_STRUCTURE_IMMUTABLE_PROTECTED_VALUE" &&
      !error.message.includes(PRIVATE_KEY)
  );
});

test("AGY session-map migration replaces stale bracket tool placeholders", () => {
  const body = sampleRequest();
  const migrated = normalizeAgySessionMap(body, {
    "[TOOL_9]": "send_private_email",
    "[EMAIL_1]": PRIVATE_EMAIL
  });
  const toolAlias = Object.entries(migrated)
    .find(([, original]) => original === "send_private_email")?.[0];

  assert.match(toolAlias, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
  assert.notEqual(toolAlias, "[TOOL_9]");
  assert.equal(migrated[toolAlias], "send_private_email");
  assert.equal(migrated["[EMAIL_1]"], PRIVATE_EMAIL);
});

test("shared session-map merging rejects case-insensitive aliases from separate maps", () => {
  assert.throws(
    () => mergeSessionMaps(
      { "[EMAIL_1]": "first@example.test" },
      { "[email_1]": "second@example.test" },
      { maxAliasesPerOriginal: 8 }
    ),
    error => error?.code === "PRIVACYAI_SESSION_MAP_COLLISION"
  );
});

test("AGY image additions reject case-insensitive alias collisions", async () => {
  await assert.rejects(
    sanitizeAgyRequestBody(minimalImageRequest("case-map-session", "case-map-request"), {
      sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
      sessionMap: { "[EMAIL_1]": "first@example.test" },
      imageSanitizer: {
        async sanitize(inlineData) {
          return {
            inlineData,
            changed: false,
            sessionMapAdditions: { "[email_1]": "second@example.test" }
          };
        }
      }
    }),
    error => error?.code === "PRIVACYAI_AGY_SESSION_MAP_COLLISION"
  );
});

test("AGY request transformation leaves protocol identities outside the sanitizer", async () => {
  const body = sampleRequest();
  body.request.contents[1].parts[0].thoughtSignature = "opaque-signature";
  body.request.contents[1].parts[0].thought = true;
  const observed = [];
  const sanitizer = async text => {
    observed.push(text);
    return deterministicSanitizer(text);
  };

  const result = await sanitizeAgyRequestBody(body, { sanitizer });
  const inspected = observed.join("\n");

  assert.doesNotMatch(inspected, /session-123|request-123|call-1|opaque-signature/);
  assert.equal(result.body.request.sessionId, "session-123");
  assert.equal(result.body.requestId, "request-123");
  assert.equal(result.body.request.contents[1].parts[0].functionResponse.id, "call-1");
  assert.equal(result.body.request.contents[1].parts[0].thoughtSignature, "opaque-signature");
  assert.equal(result.body.request.contents[1].parts[0].thought, true);
  assert.equal(result.body.request.contents[0].role, "user");
});

test("AGY request transformation aliases native MCP names before provider validation", async () => {
  const nativeName = "stealth-browser/browser_status";
  const body = sampleRequest();
  body.request.tools[0].functionDeclarations[0].name = nativeName;
  body.request.contents[1].parts[0].functionResponse.name = nativeName;
  body.request.toolConfig.functionCallingConfig.allowedFunctionNames = [nativeName, "public_tool"];

  const result = await sanitizeAgyRequestBody(body, {
    sanitizer: deterministicSanitizer
  });
  const declarationName = result.body.request.tools[0].functionDeclarations[0].name;
  const responseName = result.body.request.contents[1].parts[0].functionResponse.name;

  assert.equal(declarationName, responseName);
  assert.match(declarationName, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
  assert.doesNotMatch(declarationName, /\//);
  assert.equal(result.sessionMapAdditions[declarationName], nativeName);
  assert.deepEqual(
    result.body.request.toolConfig.functionCallingConfig.allowedFunctionNames,
    [declarationName, "public_tool"]
  );
});

test("AGY request transformation rejects malformed native function names", async () => {
  const body = sampleRequest();
  body.request.tools[0].functionDeclarations[0].name = "stealth browser/browser_status";

  await assert.rejects(
    sanitizeAgyRequestBody(body, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_AGY_INVALID_FUNCTION_NAME"
  );
});

test("AGY request transformation rejects non-boolean thought metadata", async t => {
  for (const invalidThought of ["true", null]) {
    await t.test(String(invalidThought), async () => {
      const body = sampleRequest();
      body.request.contents[1].parts[0].thought = invalidThought;

      await assert.rejects(
        sanitizeAgyRequestBody(body, { sanitizer: deterministicSanitizer }),
        error => error?.code === "PRIVACYAI_AGY_INVALID_PART"
      );
    });
  }
});

test("AGY request cache reuses unchanged history and tools after session-map growth", async () => {
  const cache = new Map();
  let calls = 0;
  const sanitizer = async text => {
    calls += 1;
    return deterministicSanitizer(text);
  };

  const first = await sanitizeAgyRequestBody(sampleRequest(), { sanitizer, cache });
  for (const [key, record] of first.cacheWrites) cache.set(key, record);
  const firstCalls = calls;
  assert.equal(firstCalls, 1, "uncached artifacts should share one bounded classifier batch");
  assert.equal(first.metrics.modelCallCount, 1);

  const second = await sanitizeAgyRequestBody(sampleRequest(), {
    sanitizer,
    cache,
    sessionMap: first.sessionMapAdditions
  });

  assert.equal(calls, firstCalls);
  assert.equal(second.cacheWrites.length, 0);
  assert.deepEqual(second.body, first.body);
});

test("AGY controller stages function calls and commits matching next-turn responses", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-mutation-"));
  const target = join(root, "owner.txt");
  const vaultDir = join(root, "vault");
  await writeFile(target, "before\n");
  const store = new MemoryContextVerificationStore();
  const vault = new SessionVault({ baseDir: vaultDir });
  const sessionKey = "agy:mutation-session";
  await vault.save(sessionKey, { "[EMAIL_1]": PRIVATE_EMAIL });
  const controller = await createAgySessionController({
    sanitizer: deterministicSanitizer,
    imageSanitizer: { sanitize: async value => ({ inlineData: value, changed: false, sessionMapAdditions: {} }) },
    verificationStore: store,
    vault,
    cwd: root,
    policyFingerprint: "sha256:agy-mutation-policy"
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });

  const call = {
    id: "agy-mutation-call",
    name: "apply_patch",
    args: {
      patch: "*** Begin Patch\n*** Update File: owner.txt\n@@\n-before\n+" + PRIVATE_EMAIL + "\n*** End Patch"
    }
  };
  const staged = await controller.stageToolCalls(sessionKey, [call]);
  assert.equal(staged.stagedCount, 1);
  await writeFile(target, PRIVATE_EMAIL + "\n");

  const body = sampleRequest();
  body.request.sessionId = "mutation-session";
  body.request.contents = [
    { role: "model", parts: [{ functionCall: call }] },
    {
      role: "user",
      parts: [{
        functionResponse: {
          id: call.id,
          name: call.name,
          response: { output: "Done" }
        }
      }]
    }
  ];
  await controller.transform(body);

  const mutation = store.getFileMutation(hookFileMutationId({
    session_id: sessionKey,
    tool_use_id: call.id
  }, target));
  assert.equal(mutation.status, "committed");
  assert.equal(mutation.operationType, "apply_patch");
  assert.equal(store.getPrivacyPlan(
    mutation.nextContentHash,
    controller.policyFingerprint
  ).spans.length, 1);
});

test("AGY session controllers atomically merge concurrent mappings", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-session-race-"));
  const sessionId = "shared-concurrent-session";
  const firstOriginal = "first.concurrent@example.test";
  const secondOriginal = "second.concurrent@example.test";
  let arrivals = 0;
  let release;
  const bothSanitizersReady = new Promise(resolve => { release = resolve; });
  const sanitizerFor = (original, placeholder) => async text => {
    if (!text.includes(original)) return { sanitizedPrompt: text, sessionMap: {} };
    arrivals += 1;
    if (arrivals === 2) release();
    await bothSanitizersReady;
    return {
      sanitizedPrompt: text.replaceAll(original, placeholder),
      sessionMap: { [placeholder]: original }
    };
  };
  const first = await createAgySessionController({
    sanitizer: sanitizerFor(firstOriginal, "[EMAIL_101]"),
    baseDir: root,
    verificationStore: new MemoryContextVerificationStore()
  });
  const second = await createAgySessionController({
    sanitizer: sanitizerFor(secondOriginal, "[EMAIL_102]"),
    baseDir: root,
    verificationStore: new MemoryContextVerificationStore()
  });
  t.after(async () => {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  });

  await Promise.all([
    first.transform(minimalRequest(firstOriginal, sessionId, "request-a")),
    second.transform(minimalRequest(secondOriginal, sessionId, "request-b"))
  ]);

  const stored = await new SessionVault({ baseDir: root }).load(`agy:${sessionId}`);
  assert.deepEqual(stored.sessionMap, {
    "[EMAIL_101]": firstOriginal,
    "[EMAIL_102]": secondOriginal
  });
});

test("AGY controller keeps image dependencies lazy and closes owned image workers", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-image-lifecycle-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let loads = 0;
  let sanitizations = 0;
  let closes = 0;
  const imageSanitizerOptions = {
    async loadImageModule() {
      loads += 1;
      return {
        createImageSanitizer() {
          return {
            async sanitize(dataUrl) {
              sanitizations += 1;
              return { dataUrl, changed: false, sessionMapAdditions: {} };
            },
            async close() {
              closes += 1;
            }
          };
        }
      };
    }
  };

  const textOnly = await createAgySessionController({
    sanitizer: deterministicSanitizer,
    baseDir: join(root, "text"),
    verificationStore: new MemoryContextVerificationStore(),
    imageSanitizerOptions
  });
  await textOnly.transform(minimalRequest("public text", "text-session", "text-request"));
  await textOnly.close();
  assert.equal(loads, 0);
  assert.equal(closes, 0);

  const withImage = await createAgySessionController({
    sanitizer: deterministicSanitizer,
    baseDir: join(root, "image"),
    verificationStore: new MemoryContextVerificationStore(),
    imageSanitizerOptions
  });
  await withImage.transform(minimalImageRequest("image-session", "image-request"));
  assert.equal(loads, 1);
  assert.equal(sanitizations, 1);
  await withImage.close();
  await withImage.close();
  assert.equal(closes, 1);
});

test("AGY controller drains accepted transformations before closing dependencies", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-controller-drain-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let releaseSanitizer;
  const sanitizerGate = new Promise(resolve => { releaseSanitizer = resolve; });
  let closes = 0;
  const controller = await createAgySessionController({
    sanitizer: deterministicSanitizer,
    baseDir: root,
    verificationStore: new MemoryContextVerificationStore(),
    imageSanitizerOptions: {
      async loadImageModule() {
        return {
          createImageSanitizer() {
            return {
              async sanitize(dataUrl) {
                markStarted();
                await sanitizerGate;
                return { dataUrl, changed: false, sessionMapAdditions: {} };
              },
              async close() {
                closes += 1;
              }
            };
          }
        };
      }
    }
  });

  const transformation = controller.transform(
    minimalImageRequest("drain-session", "drain-request")
  );
  await started;
  const closing = controller.close();
  let closeSettled = false;
  closing.then(() => { closeSettled = true; });

  await assert.rejects(
    controller.transform(minimalRequest("new work", "new-session", "new-request")),
    error => error?.code === "PRIVACYAI_AGY_CONTROLLER_CLOSED"
  );
  await assert.rejects(
    controller.loadSessionMap("agy:drain-session"),
    error => error?.code === "PRIVACYAI_AGY_CONTROLLER_CLOSED"
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeSettled, false);
  assert.equal(closes, 0);

  releaseSanitizer();
  await transformation;
  await closing;
  assert.equal(closeSettled, true);
  assert.equal(closes, 1);
  await controller.close();
  assert.equal(closes, 1);
});

test("AGY controller retries only an owned dependency whose close failed", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-controller-close-retry-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  let closeCalls = 0;
  const failure = new Error("image worker close failed");
  const controller = await createAgySessionController({
    sanitizer: deterministicSanitizer,
    baseDir: root,
    verificationStore: new MemoryContextVerificationStore(),
    imageSanitizerOptions: {
      async loadImageModule() {
        return {
          createImageSanitizer() {
            return {
              async sanitize(dataUrl) {
                return { dataUrl, changed: false, sessionMapAdditions: {} };
              },
              async close() {
                closeCalls += 1;
                if (closeCalls === 1) throw failure;
              }
            };
          }
        };
      }
    }
  });

  await controller.transform(minimalImageRequest("close-retry-session", "close-retry-request"));
  await assert.rejects(controller.close(), error => error === failure);
  assert.equal(closeCalls, 1);
  await controller.close();
  assert.equal(closeCalls, 2);
  await controller.close();
  assert.equal(closeCalls, 2);
});

test("AGY images in prompts and tool results share mappings with text", async () => {
  const body = sampleRequest();
  body.request.contents[0].parts.push({
    inlineData: { mimeType: "image/png", data: "AAAA" }
  });
  body.request.contents[1].parts[0].functionResponse.parts = [{
    inlineData: { mimeType: "image/webp", data: "CCCC" }
  }];

  const imageCalls = [];
  const artifacts = [];
  const result = await sanitizeAgyRequestBody(body, {
    sanitizer: deterministicSanitizer,
    imageSanitizer: {
      async sanitize(inlineData, context) {
        imageCalls.push({ inlineData, sessionMap: { ...context.sessionMap } });
        if (imageCalls.length === 1) {
          return {
            inlineData: { mimeType: "image/png", data: "BBBB" },
            sessionMapAdditions: { "[EMAIL_1]": PRIVATE_EMAIL },
            changed: true
          };
        }
        assert.equal(context.sessionMap["[EMAIL_1]"], PRIVATE_EMAIL);
        return {
          inlineData: { mimeType: "image/png", data: "DDDD" },
          sessionMapAdditions: {},
          changed: true
        };
      }
    },
    onArtifactComplete(details) {
      artifacts.push(details);
    }
  });

  assert.equal(imageCalls.length, 2);
  assert.deepEqual(imageCalls[0].sessionMap, {});
  assert.equal(imageCalls[1].sessionMap["[EMAIL_1]"], PRIVATE_EMAIL);
  assert.deepEqual(result.body.request.contents[0].parts[1].inlineData, {
    mimeType: "image/png",
    data: "BBBB"
  });
  assert.deepEqual(
    result.body.request.contents[1].parts[0].functionResponse.parts[0].inlineData,
    { mimeType: "image/png", data: "DDDD" }
  );
  assert.match(result.body.request.contents[0].parts[0].text, /\[EMAIL_1\]/);
  assert.equal(result.sessionMapAdditions["[EMAIL_1]"], PRIVATE_EMAIL);
  assert.equal(result.itemRecords.some(record => record.artifactType === "image"), false);
  assert.equal(artifacts.filter(item => item.artifactType === "image").length, 2);
});

test("AGY permits a text placeholder and provider-safe tool alias for one private value", async () => {
  const nativeToolName = "private-mcp/read_secret_image";
  const body = sampleRequest();
  body.request.tools[0].functionDeclarations[0].name = nativeToolName;
  body.request.contents[1].parts[0].functionResponse.name = nativeToolName;
  body.request.contents[0].parts.push({
    inlineData: { mimeType: "image/png", data: "AAAA" }
  });

  const result = await sanitizeAgyRequestBody(body, {
    sanitizer: deterministicSanitizer,
    imageSanitizer: {
      async sanitize() {
        return {
          inlineData: { mimeType: "image/png", data: "BBBB" },
          sessionMapAdditions: { "[PRIVATE_IDENTIFIER_1]": nativeToolName },
          changed: true
        };
      }
    }
  });

  const providerAlias = result.body.request.tools[0].functionDeclarations[0].name;
  assert.match(providerAlias, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
  assert.notEqual(providerAlias, nativeToolName);
  assert.equal(result.body.request.contents[1].parts[0].functionResponse.name, providerAlias);
  assert.equal(result.sessionMapAdditions["[PRIVATE_IDENTIFIER_1]"], nativeToolName);
  assert.equal(result.sessionMapAdditions[providerAlias], nativeToolName);
});

test("AGY image validation and limits fail closed before provider forwarding", async () => {
  const required = sampleRequest();
  required.request.contents[0].parts.push({
    inlineData: { mimeType: "image/png", data: "AAAA" }
  });
  await assert.rejects(
    sanitizeAgyRequestBody(required, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_AGY_IMAGE_SANITIZER_REQUIRED"
  );

  let calls = 0;
  const tooMany = sampleRequest();
  tooMany.request.contents[0].parts.push(
    { inlineData: { mimeType: "image/png", data: "AAAA" } },
    { inlineData: { mimeType: "image/png", data: "BBBB" } }
  );
  await assert.rejects(
    sanitizeAgyRequestBody(tooMany, {
      sanitizer: deterministicSanitizer,
      maxImagesPerRequest: 1,
      imageSanitizer: { async sanitize() { calls += 1; } }
    }),
    error => error?.code === "PRIVACYAI_AGY_TOO_MANY_IMAGES"
  );
  assert.equal(calls, 0);

  for (const part of [
    { fileData: { mimeType: "image/png", fileUri: "https://example.test/image.png" } },
    { inlineData: { mimeType: "application/pdf", data: "AAAA" } },
    { inlineData: { mimeType: "image/png", data: "" } },
    { inlineData: { mimeType: "image/png", data: "AAAA", future: true } }
  ]) {
    const malformed = sampleRequest();
    malformed.request.contents[0].parts = [part];
    await assert.rejects(
      sanitizeAgyRequestBody(malformed, {
        sanitizer: deterministicSanitizer,
        imageSanitizer: { async sanitize() { throw new Error("must not run"); } }
      }),
      error => [
        "PRIVACYAI_AGY_UNSUPPORTED_IMAGE_URL",
        "PRIVACYAI_AGY_UNSUPPORTED_MEDIA_TYPE",
        "PRIVACYAI_AGY_INVALID_IMAGE",
        "PRIVACYAI_AGY_UNSUPPORTED_FIELD"
      ].includes(error?.code)
    );
  }

  const nestedRemote = sampleRequest();
  nestedRemote.request.contents[1].parts[0].functionResponse.parts = [{
    fileData: { mimeType: "image/png", fileUri: "gs://private/image.png" }
  }];
  await assert.rejects(
    sanitizeAgyRequestBody(nestedRemote, {
      sanitizer: deterministicSanitizer,
      imageSanitizer: { async sanitize() {} }
    }),
    error => error?.code === "PRIVACYAI_AGY_UNSUPPORTED_IMAGE_URL"
  );
});

test("AGY image and text sanitizer failures preserve fail-closed error boundaries", async () => {
  const imageBody = sampleRequest();
  imageBody.request.contents[0].parts.push({
    inlineData: { mimeType: "image/png", data: "AAAA" }
  });
  await assert.rejects(
    sanitizeAgyRequestBody(imageBody, {
      sanitizer: deterministicSanitizer,
      imageSanitizer: { async sanitize() { throw new Error("image provider failed"); } }
    }),
    error => error?.code === "PRIVACYAI_AGY_IMAGE_SANITIZER_FAILURE" &&
      error.cause?.message === "image provider failed"
  );
  await assert.rejects(
    sanitizeAgyRequestBody(imageBody, {
      sanitizer: deterministicSanitizer,
      imageSanitizer: { async sanitize() { return { inlineData: null }; } }
    }),
    error => error?.code === "PRIVACYAI_AGY_INVALID_SANITIZED_IMAGE"
  );

  const future = sampleRequest();
  future.request.futureContext = { value: PRIVATE_EMAIL };
  await assert.rejects(
    sanitizeAgyRequestBody(future, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_AGY_UNSUPPORTED_FIELD"
  );

  await assert.rejects(
    sanitizeAgyRequestBody(sampleRequest(), {
      sanitizer: async () => { throw new Error("local provider failed"); }
    }),
    error => error?.code === "PRIVACYAI_AGY_SANITIZER_FAILURE" &&
      error.cause?.message === "local provider failed"
  );
});

test("AGY upstream headers preserve opaque encodings and normalize transformed model traffic", () => {
  const input = {
    host: "original.example",
    "content-length": "7",
    "content-encoding": "gzip",
    "accept-encoding": "gzip, br",
    "x-request-id": "request-1"
  };

  const opaque = buildAgyUpstreamHeaders(input, "daily-cloudcode-pa.googleapis.com", 7, {
    modelRoute: false
  });
  assert.equal(opaque["content-encoding"], "gzip");
  assert.equal(opaque["accept-encoding"], "gzip, br");
  assert.equal(opaque["content-length"], "7");
  assert.equal(opaque.host, "daily-cloudcode-pa.googleapis.com");

  const transformed = buildAgyUpstreamHeaders(input, "daily-cloudcode-pa.googleapis.com", 11, {
    modelRoute: true
  });
  assert.equal(Object.hasOwn(transformed, "content-encoding"), false);
  assert.equal(transformed["accept-encoding"], "identity");
  assert.equal(transformed["content-length"], "11");
  assert.equal(transformed["x-request-id"], "request-1");
});

test("AGY transport proxy sanitizes a real CONNECT request and restores streamed output", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-transport-"));
  const mutationTarget = join(root, "owner.txt");
  await writeFile(mutationTarget, "before\n");
  const nativeToolName = "stealth-browser/browser_status";
  const requestBody = sampleRequest();
  requestBody.request.tools[0].functionDeclarations[0].name = nativeToolName;
  requestBody.request.contents[1].parts[0].functionResponse.name = nativeToolName;
  requestBody.request.contents[1].parts[0].thought = true;
  requestBody.request.contents[0].parts.push({
    inlineData: { mimeType: "image/png", data: "AAAA" }
  });
  requestBody.request.contents[1].parts[0].functionResponse.parts = [{
    inlineData: { mimeType: "image/webp", data: "CCCC" }
  }];
  const observed = [];
  const observedPaths = [];
  const imageCalls = [];
  const stagedTransportCalls = [];
  const verificationStore = new MemoryContextVerificationStore();
  const runtime = await startAgyTransportRuntime({
    sanitizer: deterministicSanitizer,
    imageSanitizer: {
      async sanitize(inlineData, context) {
        imageCalls.push({ inlineData, sessionMap: { ...context.sessionMap } });
        const first = inlineData.data === "AAAA";
        return {
          inlineData: first
            ? { mimeType: "image/png", data: "BBBB" }
            : { mimeType: "image/png", data: "DDDD" },
          sessionMapAdditions: first ? { "[EMAIL_1]": PRIVATE_EMAIL } : {},
          changed: true
        };
      }
    },
    baseEnv: {},
    baseDir: join(root, "vault"),
    tmpDir: root,
    cwd: root,
    verificationStore,
    createSessionController: async controllerOptions => {
      const controller = await createAgySessionController(controllerOptions);
      const stageToolCalls = controller.stageToolCalls.bind(controller);
      controller.stageToolCalls = async (sessionKey, calls) => {
        stagedTransportCalls.push(...calls);
        return stageToolCalls(sessionKey, calls);
      };
      return controller;
    },
    requestUpstream: async request => {
      const parsed = JSON.parse(request.body.toString("utf8"));
      observed.push(parsed);
      observedPaths.push(request.path);
      assert.equal(JSON.stringify(parsed).includes(PRIVATE_EMAIL), false);
      assert.match(parsed.request.contents[0].parts[0].text, /\[EMAIL_1\]/);
      assert.deepEqual(parsed.request.contents[0].parts[1].inlineData, {
        mimeType: "image/png",
        data: "BBBB"
      });
      assert.deepEqual(
        parsed.request.contents[1].parts[0].functionResponse.parts[0].inlineData,
        { mimeType: "image/png", data: "DDDD" }
      );
      assert.equal(JSON.stringify(parsed).includes('"data":"AAAA"'), false);
      assert.equal(JSON.stringify(parsed).includes('"data":"CCCC"'), false);
      const toolAlias = parsed.request.tools[0].functionDeclarations[0].name;
      assert.match(toolAlias, /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/);
      assert.doesNotMatch(toolAlias, /\//);
      assert.notEqual(toolAlias, nativeToolName);
      assert.equal(parsed.request.contents[1].parts[0].functionResponse.name, toolAlias);
      assert.equal(parsed.request.contents[1].parts[0].thought, true);
      assert.equal(JSON.stringify(parsed).includes(nativeToolName), false);

      const upstream = observed.length === 1
        ? Readable.from([
            Buffer.from(sseEvent(textEvent("result for [EMAIL_1]"))),
            Buffer.from(sseEvent({
              response: {
                candidates: [{
                  content: {
                    role: "model",
                    parts: [
                      {
                        functionCall: {
                          name: toolAlias,
                          args: { "[EMAIL_1]": { nested: ["[EMAIL_1]"] } }
                        }
                      },
                      {
                        functionCall: {
                          id: "transport-patch-call",
                          name: "apply_patch",
                          args: {
                            patch: "*** Begin Patch\n*** Update File: owner.txt\n@@\n-before\n+[EMAIL_1]\n*** End Patch"
                          }
                        }
                      }
                    ]
                  }
                }]
              },
              traceId: "transport-patch-trace",
              metadata: {}
            })),
            Buffer.from(sseEvent(finishEvent()))
          ])
        : Readable.from([Buffer.from('{"unexpected":"success"}')]);
      upstream.statusCode = 200;
      upstream.headers = {
        "content-type": observed.length === 1
          ? "text/event-stream; charset=utf-8"
          : "application/json",
        "content-encoding": "identity"
      };
      return upstream;
    }
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal(Object.hasOwn(runtime.env, "HTTP_PROXY"), false);
  assert.match(runtime.env.HTTPS_PROXY, /^http:\/\/privacyai:/);

  const response = await proxyHttpRequest(runtime, requestBody, MODEL_SSE_PATH_WITH_EXTRA_QUERY);
  assert.match(response.statusLine, /^HTTP\/1\.1 200/);
  assert.equal(observed.length, 1);
  assert.equal(observedPaths[0], MODEL_SSE_PATH_WITH_EXTRA_QUERY);
  const events = parseEvents(response.body);
  const text = events
    .flatMap(event => event.response?.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text)
    .filter(value => typeof value === "string")
    .join("");
  assert.equal(text, `result for ${PRIVATE_EMAIL}`);
  const currentRequestCall = events
    .flatMap(event => event.response?.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .find(part => part.functionCall)?.functionCall;
  assert.equal(currentRequestCall.name, nativeToolName);
  assert.deepEqual(currentRequestCall.args, {
    [PRIVATE_EMAIL]: { nested: [PRIVATE_EMAIL] }
  });
  assert.equal(imageCalls.length, 2);
  assert.deepEqual(imageCalls[0].sessionMap, {});
  assert.equal(imageCalls[1].sessionMap["[EMAIL_1]"], PRIVATE_EMAIL);
  assert.equal(stagedTransportCalls.length, 2);
  const stagedPatchCall = stagedTransportCalls.find(call => call.id === "transport-patch-call");
  assert.equal(stagedPatchCall.args.patch.includes(PRIVATE_EMAIL), true);
  const transportMutation = verificationStore.getFileMutation(hookFileMutationId({
    session_id: "agy:session-123",
    tool_use_id: "transport-patch-call"
  }, mutationTarget));
  assert.equal(transportMutation.status, "pending");

  const unexpected = await proxyHttpRequest(runtime, requestBody);
  assert.match(unexpected.statusLine, /^HTTP\/1\.1 502/);
  assert.match(unexpected.body, /PRIVACYAI_AGY_UNSUPPORTED_SUCCESS_RESPONSE/);
  assert.equal(observed.length, 2);
  assert.equal(imageCalls.length, 4);
  assert.equal(imageCalls[2].sessionMap["[EMAIL_1]"], PRIVATE_EMAIL);
  assert.equal(imageCalls[3].sessionMap["[EMAIL_1]"], PRIVATE_EMAIL);
  assert.equal(
    observed[0].request.tools[0].functionDeclarations[0].name,
    observed[1].request.tools[0].functionDeclarations[0].name
  );

  const unsupported = await proxyHttpRequest(
    runtime,
    requestBody,
    "/v1internal:streamGenerateContent?alt=json"
  );
  assert.match(unsupported.statusLine, /^HTTP\/1\.1 502/);
  assert.match(unsupported.body, /PRIVACYAI_AGY_UNSUPPORTED_MODEL_ROUTE/);
  assert.equal(observed.length, 2);
  assert.equal(imageCalls.length, 4);

  const unknownRoute = await proxyHttpRequest(
    runtime,
    requestBody,
    "/v1internal:newGenerateContent?alt=sse"
  );
  assert.match(unknownRoute.statusLine, /^HTTP\/1\.1 502/);
  assert.match(unknownRoute.body, /PRIVACYAI_AGY_UNSUPPORTED_HOST_ROUTE/);
  assert.equal(observed.length, 2);
  assert.equal(imageCalls.length, 4);
});

test("AGY transport proxy forwards the audited metrics route opaquely", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-metrics-route-"));
  const observed = {};
  const runtime = await startAgyTransportRuntime({
    sanitizer: deterministicSanitizer,
    baseEnv: {},
    baseDir: join(root, "vault"),
    tmpDir: root,
    verificationStore: new MemoryContextVerificationStore(),
    requestOpaqueUpstream: (options, onResponse) => {
      observed.options = options;
      const upstreamRequest = new PassThrough();
      const chunks = [];
      upstreamRequest.on("data", chunk => chunks.push(chunk));
      upstreamRequest.once("finish", () => {
        observed.body = Buffer.concat(chunks).toString("utf8");
        const upstreamResponse = Readable.from([Buffer.from("{}")]);
        upstreamResponse.statusCode = 200;
        upstreamResponse.headers = {
          "content-type": "application/json",
          "content-encoding": "identity"
        };
        onResponse(upstreamResponse);
      });
      return upstreamRequest;
    }
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const metrics = {
    project: "project-123",
    requestId: "request-123",
    metadata: {},
    metrics: []
  };
  const response = await proxyHttpRequest(
    runtime,
    metrics,
    "/v1internal:recordCodeAssistMetrics"
  );

  assert.match(response.statusLine, /^HTTP\/1\.1 200/);
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.path, "/v1internal:recordCodeAssistMetrics");
  assert.deepEqual(JSON.parse(observed.body), metrics);
});

test("AGY opaque forwarding cancels upstream work after downstream disconnect", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-opaque-cancel-"));
  let upstreamRequest;
  let upstreamResponse;
  let markResponseReady;
  let markLateErrorEmitted;
  const responseReady = new Promise(resolve => { markResponseReady = resolve; });
  const lateErrorEmitted = new Promise(resolve => { markLateErrorEmitted = resolve; });
  const runtime = await startAgyTransportRuntime({
    sanitizer: deterministicSanitizer,
    baseEnv: {},
    baseDir: join(root, "vault"),
    tmpDir: root,
    verificationStore: new MemoryContextVerificationStore(),
    requestOpaqueUpstream: (_options, onResponse) => {
      upstreamRequest = new PassThrough();
      const destroy = upstreamRequest.destroy.bind(upstreamRequest);
      let simulatedLateError = false;
      upstreamRequest.destroy = (...args) => {
        const result = destroy(...args);
        if (!simulatedLateError) {
          simulatedLateError = true;
          setImmediate(() => {
            const error = new Error("socket hang up");
            error.code = "ECONNRESET";
            upstreamRequest.emit("error", error);
            markLateErrorEmitted();
          });
        }
        return result;
      };
      upstreamRequest.once("finish", () => {
        upstreamResponse = new PassThrough();
        upstreamResponse.statusCode = 200;
        upstreamResponse.headers = {
          "content-type": "text/plain",
          "content-encoding": "identity"
        };
        onResponse(upstreamResponse);
        upstreamResponse.write("partial response");
        markResponseReady();
      });
      return upstreamRequest;
    }
  });
  t.after(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  const secureSocket = await connectProxyTls(runtime);
  secureSocket.write(
    "GET /oauth/status HTTP/1.1\r\n" +
    `Host: ${runtime.modelHost}\r\n` +
    "Connection: keep-alive\r\n\r\n"
  );
  const responseHead = await readConnectResponse(secureSocket);
  assert.match(responseHead, /^HTTP\/1\.1 200/);
  await responseReady;

  const upstreamClosed = once(upstreamResponse, "close");
  secureSocket.destroy();
  await Promise.all([upstreamClosed, lateErrorEmitted]);
  assert.equal(upstreamResponse.destroyed, true);
  assert.equal(upstreamRequest.destroyed, true);
});

test("ephemeral AGY authority removes only its owned child directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-authority-root-"));
  const marker = join(root, "caller-owned.txt");
  await writeFile(marker, "keep\n");
  try {
    const authority = await createEphemeralTlsAuthority(
      "daily-cloudcode-pa.googleapis.com",
      { runtimeDir: root }
    );
    assert.notEqual(authority.runtimeDir, root);
    await authority.close();
    await access(marker);
    await assert.rejects(access(authority.runtimeDir), error => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ephemeral AGY authority shares failed closes and remains retryable", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-authority-retry-"));
  let removeCalls = 0;
  let markRemovalStarted;
  const removalStarted = new Promise(resolve => { markRemovalStarted = resolve; });
  let releaseRemoval;
  const removalGate = new Promise(resolve => { releaseRemoval = resolve; });
  const removalFailure = new Error("temporary removal failure");
  try {
    const authority = await createEphemeralTlsAuthority(
      "daily-cloudcode-pa.googleapis.com",
      {
        runtimeDir: root,
        async removeRuntimeDir(path, options) {
          removeCalls += 1;
          if (removeCalls === 1) {
            markRemovalStarted();
            await removalGate;
            throw removalFailure;
          }
          return rm(path, options);
        }
      }
    );

    const firstClose = authority.close();
    await removalStarted;
    const concurrentClose = authority.close();
    assert.equal(concurrentClose, firstClose);
    releaseRemoval();
    await assert.rejects(firstClose, error => error === removalFailure);
    await assert.rejects(concurrentClose, error => error === removalFailure);
    assert.equal(removeCalls, 1);
    await access(authority.runtimeDir);

    await authority.close();
    assert.equal(removeCalls, 2);
    await assert.rejects(access(authority.runtimeDir), error => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ephemeral AGY authority preserves a child-specific CA bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-agy-authority-ca-"));
  const customBundle = join(root, "enterprise-ca.pem");
  const marker = "CUSTOM-ENTERPRISE-CA-BUNDLE";
  await writeFile(customBundle, `${marker}\n`);
  try {
    const authority = await createEphemeralTlsAuthority(
      "daily-cloudcode-pa.googleapis.com",
      { runtimeDir: root, baseEnv: { SSL_CERT_FILE: customBundle } }
    );
    const trustBundle = await readFile(authority.trustBundlePath, "utf8");
    assert.equal(trustBundle.startsWith(`${marker}\n`), true);
    await authority.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AGY transport runtime retries only resources whose cleanup failed", async () => {
  const calls = [];
  let proxyAttempts = 0;
  let authorityAttempts = 0;
  const runtime = await startAgyTransportRuntime({
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    baseEnv: {},
    createAuthority: async () => ({
      runtimeDir: "/tmp/privacyai-test-authority",
      async close() {
        authorityAttempts += 1;
        calls.push(`authority-${authorityAttempts}`);
        if (authorityAttempts === 1) throw new Error("authority close failed");
      }
    }),
    createSessionController: async () => ({
      close() {
        calls.push("controller-1");
      }
    }),
    startProxy: async () => ({
      env: {},
      proxyURL: "http://127.0.0.1:1",
      async close() {
        proxyAttempts += 1;
        calls.push(`proxy-${proxyAttempts}`);
        if (proxyAttempts === 1) throw new Error("proxy close failed");
      }
    })
  });

  await assert.rejects(
    runtime.close(),
    error =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.cause?.message === "proxy close failed"
  );
  assert.deepEqual(calls, ["proxy-1", "controller-1", "authority-1"]);

  await runtime.close();
  assert.deepEqual(calls, ["proxy-1", "controller-1", "authority-1", "proxy-2", "authority-2"]);
  await runtime.close();
  assert.deepEqual(calls, ["proxy-1", "controller-1", "authority-1", "proxy-2", "authority-2"]);
});

test("AGY transport runtime surfaces partial-start cleanup failures", async () => {
  const initializationError = new Error("proxy initialization failed");
  const controllerCleanupError = new Error("controller cleanup failed");
  const authorityCleanupError = new Error("authority cleanup failed");
  const calls = [];

  await assert.rejects(
    startAgyTransportRuntime({
      sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
      baseEnv: {},
      createAuthority: async () => ({
        runtimeDir: "/tmp/privacyai-test-authority",
        async close() {
          calls.push("authority");
          throw authorityCleanupError;
        }
      }),
      createSessionController: async () => ({
        async close() {
          calls.push("controller");
          throw controllerCleanupError;
        }
      }),
      startProxy: async () => {
        throw initializationError;
      }
    }),
    error =>
      error instanceof AggregateError &&
      error.cause === initializationError &&
      error.errors[0] === initializationError &&
      error.errors.includes(controllerCleanupError) &&
      error.errors.includes(authorityCleanupError)
  );
  assert.deepEqual(calls.sort(), ["authority", "controller"]);
});

test("AGY SSE restoration handles placeholders split across text events", () => {
  const restorer = new AgySseRestorer({ "[EMAIL_1]": PRIVATE_EMAIL });
  const outputs = [];
  outputs.push(...restorer.write(Buffer.from(sseEvent(textEvent("contact [EMAIL_")))));
  outputs.push(...restorer.write(Buffer.from(sseEvent(textEvent("1] now")))));
  outputs.push(...restorer.write(Buffer.from(sseEvent(finishEvent()))));
  outputs.push(...restorer.end());

  const events = outputs.flatMap(parseEvents);
  const text = events
    .flatMap(event => event.response?.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text)
    .filter(value => typeof value === "string")
    .join("");

  assert.equal(text, `contact ${PRIVATE_EMAIL} now`);
});

test("AGY SSE processes a finish event's final text chunk before flushing", () => {
  const restorer = new AgySseRestorer({ "[EMAIL_1]": PRIVATE_EMAIL });
  const outputs = [];
  outputs.push(...restorer.write(Buffer.from(sseEvent(textEvent("contact [EMAIL_")))));
  const final = finishEvent();
  final.response.candidates[0].content.parts[0].text = "1]";
  outputs.push(...restorer.write(Buffer.from(sseEvent(final))));
  outputs.push(...restorer.end());

  const events = outputs.flatMap(parseEvents);
  const text = events
    .flatMap(event => event.response?.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text)
    .filter(value => typeof value === "string")
    .join("");
  assert.equal(text, `contact ${PRIVATE_EMAIL}`);
  assert.equal(events.at(-1).response.candidates[0].finishReason, "STOP");
});

test("AGY SSE preserves text order when a finish event ends with a partial placeholder", () => {
  const restorer = new AgySseRestorer({ "[EMAIL_1]": PRIVATE_EMAIL });
  const final = finishEvent();
  final.response.candidates[0].content.parts[0].text = "abc [EMAIL_";
  const outputs = [
    ...restorer.write(Buffer.from(sseEvent(final))),
    ...restorer.end()
  ];

  const events = outputs.flatMap(parseEvents);
  const text = events
    .flatMap(event => event.response?.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text)
    .filter(value => typeof value === "string")
    .join("");
  assert.equal(text, "abc [EMAIL_");
  assert.equal(events.at(-1).response.candidates[0].finishReason, "STOP");
});

test("standalone AGY SSE restoration finalizes buffered placeholder prefixes", () => {
  const restored = restoreAgySseEvent(
    textEvent("prefix [EMAIL_"),
    { "[EMAIL_1]": PRIVATE_EMAIL }
  );
  const text = restored
    .flatMap(event => event.response?.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text)
    .filter(value => typeof value === "string")
    .join("");
  assert.equal(text, "prefix [EMAIL_");
});

test("AGY SSE avoids cloning stream templates for every text chunk", () => {
  const clone = globalThis.structuredClone;
  let cloneCount = 0;
  globalThis.structuredClone = value => {
    cloneCount += 1;
    return clone(value);
  };

  try {
    const restorer = new AgySseRestorer({ "[EMAIL_1]": PRIVATE_EMAIL });
    restorer.write(Buffer.from(sseEvent(textEvent("contact [EMAIL_"))));
    restorer.write(Buffer.from(sseEvent(textEvent("1] now"))));
    restorer.write(Buffer.from(sseEvent(finishEvent())));
    restorer.end();
    assert.ok(cloneCount <= 4, `expected at most four structured clones, received ${cloneCount}`);
  } finally {
    globalThis.structuredClone = clone;
  }
});

test("AGY SSE restorer exposes each restored function call once", () => {
  const alias = "privacyai_tool_apply_patch";
  const restorer = new AgySseRestorer({
    "[EMAIL_1]": PRIVATE_EMAIL,
    [alias]: "apply_patch"
  });
  const event = {
    response: {
      candidates: [{
        content: {
          role: "model",
          parts: [{
            functionCall: {
              id: "agy-patch-call",
              name: alias,
              args: {
                patch: "*** Begin Patch\n*** Add File: owner.txt\n+[EMAIL_1]\n*** End Patch"
              }
            }
          }]
        }
      }]
    },
    traceId: "trace-call",
    metadata: {}
  };

  restorer.write(Buffer.from(sseEvent(event)));
  const calls = restorer.drainCompletedToolCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "apply_patch");
  assert.equal(calls[0].args.patch.includes(PRIVATE_EMAIL), true);
  restorer.write(Buffer.from(sseEvent(event)));
  assert.deepEqual(restorer.drainCompletedToolCalls(), []);
});

test("AGY SSE restoration restores native function names, argument keys, and values", () => {
  const toolAlias = "privacyai_tool_46e0293a1cab";
  const restorer = new AgySseRestorer({
    "[EMAIL_1]": PRIVATE_EMAIL,
    "[API_KEY_1]": PRIVATE_KEY,
    "[PRIVATE_VALUE_89]": "deep-private-value",
    [toolAlias]: "send_private_email"
  });
  const event = {
    response: {
      candidates: [{
        content: {
          role: "model",
          parts: [{
            functionCall: {
              id: "call-1",
              name: toolAlias,
              args: {
                "[EMAIL_1]": {
                  nested: [{ token: "[API_KEY_1]" }, "[PRIVATE_VALUE_89]"]
                }
              }
            },
            thoughtSignature: "opaque-signature"
          }]
        }
      }]
    },
    traceId: "trace-1",
    metadata: {}
  };

  const outputs = restorer.write(Buffer.from(sseEvent(event)));
  const restored = parseEvents(outputs[0])[0];
  const call = restored.response.candidates[0].content.parts[0].functionCall;
  assert.equal(call.name, "send_private_email");
  assert.deepEqual(call.args, {
    [PRIVATE_EMAIL]: {
      nested: [{ token: PRIVATE_KEY }, "deep-private-value"]
    }
  });
  assert.equal(restored.response.candidates[0].content.parts[0].thoughtSignature, "opaque-signature");
});

test("AGY SSE blocks unresolved private placeholders and internal aliases in function calls", () => {
  for (const functionCall of [
    { name: "public_tool", args: { nested: { value: "[PRIVATE_VALUE_404]" } } },
    { name: "public_tool", args: { nested: { privacyai_tool_46e0293a1cab: "value" } } },
    { name: "privacyai_tool_46e0293a1cab", args: {} }
  ]) {
    const restorer = new AgySseRestorer();
    assert.throws(
      () => restorer.write(Buffer.from(sseEvent({
        response: { candidates: [{ content: { role: "model", parts: [{ functionCall }] } }] }
      }))),
      error =>
        error?.code === "PRIVACYAI_AGY_UNRESOLVED_TOOL_CALL" &&
        !error.message.includes("PRIVATE_VALUE_404") &&
        !error.message.includes("privacyai_tool_")
    );
  }

  const normal = restoreAgySseEvent({
    response: { candidates: [{ content: { role: "model", parts: [{
      functionCall: { name: "public_tool", args: { note: "Use [BUILD_1] normally" } }
    }] } }] }
  });
  assert.equal(
    normal[0].response.candidates[0].content.parts[0].functionCall.args.note,
    "Use [BUILD_1] normally"
  );
});

test("AGY SSE recursively restores and blocks function responses", () => {
  const restored = restoreAgySseEvent({
    response: { candidates: [{ content: { role: "model", parts: [{
      functionResponse: {
        name: "privacyai_tool_46e0293a1cab",
        response: { "[EMAIL_1]": { nested: ["[PRIVATE_VALUE_89]"] } }
      }
    }] } }] }
  }, {
    privacyai_tool_46e0293a1cab: "send_private_email",
    "[EMAIL_1]": PRIVATE_EMAIL,
    "[PRIVATE_VALUE_89]": "deep-private-value"
  });
  assert.deepEqual(restored[0].response.candidates[0].content.parts[0].functionResponse, {
    name: "send_private_email",
    response: { [PRIVATE_EMAIL]: { nested: ["deep-private-value"] } }
  });

  for (const functionResponse of [
    { name: "public_tool", response: { nested: { value: "[PRIVATE_VALUE_405]" } } },
    { name: "public_tool", response: { privacyai_tool_46e0293a1cab: "value" } }
  ]) {
    assert.throws(
      () => restoreAgySseEvent({
        response: { candidates: [{ content: { role: "model", parts: [{ functionResponse }] } }] }
      }),
      error =>
        error?.code === "PRIVACYAI_AGY_UNRESOLVED_TOOL_RESPONSE" &&
        !error.message.includes("PRIVATE_VALUE_405") &&
        !error.message.includes("privacyai_tool_")
    );
  }
});

test("AGY SSE flushes fragmented candidates without duplicating unrelated content", () => {
  const restorer = new AgySseRestorer({ "[EMAIL_1]": PRIVATE_EMAIL });
  restorer.write(Buffer.from(sseEvent({
    response: {
      candidates: [
        { content: { role: "model", parts: [{ text: "contact [EMAIL_" }] } },
        { content: { role: "model", parts: [{ text: "other [EMAIL_" }] } }
      ]
    },
    traceId: "trace",
    metadata: {}
  })));

  const flushed = restorer.write(Buffer.from(sseEvent(finishEvent()))).flatMap(parseEvents);
  const flushEvents = flushed.filter(event =>
    !event.response?.candidates?.some(candidate => candidate.finishReason != null)
  );

  assert.equal(flushEvents.length, 2);
  assert.equal(flushEvents.every(event => event.response.candidates.length === 1), true);
  assert.deepEqual(
    flushEvents.map(event => event.response.candidates[0].content.parts[0].text).sort(),
    ["[EMAIL_", "[EMAIL_"].sort()
  );
});

async function connectProxyTls(runtime) {
  const proxy = new URL(runtime.proxyURL);
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  await once(socket, "connect");

  const proxyAuthorization = `Basic ${Buffer.from(
    `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  ).toString("base64")}`;
  socket.write(
    `CONNECT ${runtime.modelHost}:443 HTTP/1.1\r\n` +
    `Host: ${runtime.modelHost}:443\r\n` +
    `Proxy-Authorization: ${proxyAuthorization}\r\n` +
    "Connection: keep-alive\r\n\r\n"
  );
  const connectResponse = await readConnectResponse(socket);
  assert.match(connectResponse, /^HTTP\/1\.1 200/);

  const secureSocket = tls.connect({
    socket,
    servername: runtime.modelHost,
    ca: await readFile(runtime.env.SSL_CERT_FILE)
  });
  await once(secureSocket, "secureConnect");
  return secureSocket;
}

async function proxyHttpRequest(runtime, body, path = MODEL_SSE_PATH) {
  const secureSocket = await connectProxyTls(runtime);

  const payload = Buffer.from(JSON.stringify(body));
  secureSocket.write(Buffer.concat([
    Buffer.from(
      `POST ${path} HTTP/1.1\r\n` +
      `Host: ${runtime.modelHost}\r\n` +
      "Authorization: Bearer fixture-token\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${payload.length}\r\n` +
      "Connection: close\r\n\r\n"
    ),
    payload
  ]));

  const chunks = [];
  for await (const chunk of secureSocket) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const boundary = raw.indexOf("\r\n\r\n");
  assert.notEqual(boundary, -1);
  const head = raw.subarray(0, boundary).toString("latin1");
  const headers = Object.fromEntries(
    head.split("\r\n").slice(1).map(line => {
      const separator = line.indexOf(":");
      return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
    })
  );
  const rawBody = raw.subarray(boundary + 4);
  const decodedBody = headers["transfer-encoding"]?.toLowerCase() === "chunked"
    ? decodeChunkedBody(rawBody)
    : rawBody;
  return {
    statusLine: head.split("\r\n", 1)[0],
    headers,
    body: decodedBody.toString("utf8")
  };
}

function decodeChunkedBody(value) {
  const chunks = [];
  let offset = 0;
  while (offset < value.length) {
    const lineEnd = value.indexOf("\r\n", offset);
    if (lineEnd < 0) throw new Error("invalid chunked response");
    const size = Number.parseInt(value.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0], 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid chunk size");
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    const end = offset + size;
    if (end + 2 > value.length) throw new Error("truncated chunked response");
    chunks.push(value.subarray(offset, end));
    if (value.subarray(end, end + 2).toString("ascii") !== "\r\n") {
      throw new Error("invalid chunk terminator");
    }
    offset = end + 2;
  }
  throw new Error("missing final response chunk");
}

function readConnectResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const remainder = buffered.subarray(boundary + 4);
      cleanup();
      if (remainder.length > 0) socket.unshift(remainder);
      resolve(buffered.subarray(0, boundary + 4).toString("latin1"));
    };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("proxy tunnel closed before CONNECT completed")); };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function minimalRequest(text, sessionId, requestId) {
  return {
    project: "project-123",
    requestId,
    model: "gemini-test",
    userAgent: "agy-test",
    requestType: "agent",
    request: {
      sessionId,
      contents: [{ role: "user", parts: [{ text }] }]
    }
  };
}

function minimalImageRequest(sessionId, requestId) {
  const body = minimalRequest("placeholder", sessionId, requestId);
  body.request.contents[0].parts = [{
    inlineData: { mimeType: "image/png", data: "AAAA" }
  }];
  return body;
}

function sampleRequest() {
  return {
    project: "project-123",
    requestId: "request-123",
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: `Email ${PRIVATE_EMAIL} about the build.` }]
        },
        {
          role: "user",
          parts: [{
            functionResponse: {
              id: "call-1",
              name: "run_command",
              response: { output: `token=${PRIVATE_KEY}` }
            }
          }]
        }
      ],
      systemInstruction: {
        role: "user",
        parts: [{ text: "You are the native AGY coding agent." }]
      },
      tools: [{
        functionDeclarations: [{
          name: "send_private_email",
          description: `Send a message for ${PRIVATE_EMAIL}`,
          parameters: {
            type: "object",
            properties: {
              recipient: { type: "string" }
            },
            required: ["recipient"]
          }
        }]
      }],
      toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
      labels: { trajectory_id: "trajectory-123" },
      generationConfig: {
        maxOutputTokens: 1024,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 128 }
      },
      sessionId: "session-123"
    },
    model: "MODEL_PLACEHOLDER_M18",
    userAgent: "antigravity",
    requestType: "agent"
  };
}

function textEvent(text) {
  return {
    response: {
      candidates: [{ content: { role: "model", parts: [{ text }] } }]
    },
    traceId: "trace",
    metadata: {}
  };
}

function finishEvent() {
  return {
    response: {
      candidates: [{
        content: { role: "model", parts: [{ text: "" }] },
        finishReason: "STOP"
      }]
    },
    traceId: "trace",
    metadata: {}
  };
}

function sseEvent(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function parseEvents(serialized) {
  return String(serialized)
    .trim()
    .split(/\r?\n\r?\n/)
    .map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n"))
    .filter(data => data && data !== "[DONE]")
    .map(data => JSON.parse(data));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
