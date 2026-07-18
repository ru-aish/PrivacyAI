import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { restoreValue } from "@privacy-ai/sdk";
import {
  createGatewayDiagnosticReporter,
  publicGatewayFailure,
  publicGatewayHttpStatus
} from "../src/gateway-error.js";
import { createTestTempDir } from "./test-temp-dir.js";

import {
  CodexSseRestorer,
  MemoryContextVerificationStore,
  buildCodexProviderArgs,
  buildCodexRequestVerificationSeed,
  codexSessionContext,
  hookFileMutationId,
  parseCodexPrivacyMode,
  pruneCodexArgumentKeyMappings,
  resolveCodexGatewayTimeouts,
  restoreResponseItem,
  sanitizeCodexMetadataHeaders,
  sanitizeCodexRequestBody,
  startCodexProviderGateway
} from "../src/index.js";

const PRIVATE_EMAIL = "alice.private@example.test";
const PRIVATE_KEY = "sk-test-local-secret-123456";
const sessionMap = {
  "[EMAIL_1]": PRIVATE_EMAIL,
  "[API_KEY_1]": PRIVATE_KEY
};

function deterministicSanitizer(text) {
  let sanitizedPrompt = text;
  const additions = {};
  for (const [placeholder, original] of Object.entries(sessionMap)) {
    if (sanitizedPrompt.toLowerCase().includes(original.toLowerCase())) {
      sanitizedPrompt = sanitizedPrompt.replace(new RegExp(escapeRegExp(original), "gi"), placeholder);
      additions[placeholder] = original;
    }
  }
  return Promise.resolve({ sanitizedPrompt, sessionMap: additions });
}

test("Codex request header policy forwards only required stock and OpenAI headers", () => {
  const headers = sanitizeCodexMetadataHeaders({
    accept: "text/event-stream",
    authorization: "Bearer test-token",
    "chatgpt-account-id": "account-test",
    "content-type": "application/json",
    originator: "codex_cli_rs",
    "session-id": "session-123",
    "thread-id": "thread-123",
    "user-agent": "codex_cli_rs/0.144.1",
    "x-client-request-id": "thread-123",
    "x-codex-beta-features": "hooks,plugins",
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread-123",
      request_kind: "turn",
      workspaces: { private: PRIVATE_EMAIL },
      extra: { private: PRIVATE_KEY }
    }),
    "x-codex-window-id": "window-123",
    cookie: `session=${PRIVATE_KEY}`,
    "x-private-note": PRIVATE_EMAIL,
    traceparent: "00-private-trace",
    "x-forwarded-for": "203.0.113.10"
  });

  assert.equal(headers.authorization, "Bearer test-token");
  assert.equal(headers["chatgpt-account-id"], "account-test");
  assert.equal(headers.cookie, undefined);
  assert.equal(headers["x-private-note"], undefined);
  assert.equal(headers.traceparent, undefined);
  assert.equal(headers["x-forwarded-for"], undefined);
  const metadata = JSON.parse(headers["x-codex-turn-metadata"]);
  assert.deepEqual(metadata, { thread_id: "thread-123", request_kind: "turn" });
  assert.equal(JSON.stringify(headers).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(headers).includes(PRIVATE_KEY), false);

  assert.equal(
    sanitizeCodexMetadataHeaders({ originator: PRIVATE_EMAIL }).originator,
    undefined
  );
  assert.equal(
    sanitizeCodexMetadataHeaders({ "content-type": "multipart/form-data" })["content-type"],
    undefined
  );
});

test("Codex body metadata drops private IDs, nested analytics, and WebSocket traces", async () => {
  const body = sampleRequest();
  body.client_metadata = {
    thread_id: PRIVATE_EMAIL,
    session_id: "safe-session",
    turn_id: "safe-turn",
    "x-codex-turn-state": "opaque-state-token",
    "x-codex-ws-stream-request-start-ms": "123",
    ws_request_header_traceparent: PRIVATE_KEY,
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: PRIVATE_EMAIL,
      session_id: "safe-session",
      request_kind: "turn",
      subagent_kind: "worker",
      turn_started_at_unix_ms: 123456,
      thread_source: { private: PRIVATE_EMAIL },
      sandbox: { cwd: `/private/${PRIVATE_EMAIL}` },
      compaction: { private: PRIVATE_KEY }
    })
  };

  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: deterministicSanitizer,
    fallbackSessionId: "fallback-session"
  });
  assert.equal(result.sessionKey, "codex-provider:safe-session");
  assert.equal(result.body.client_metadata.thread_id, undefined);
  assert.equal(result.body.client_metadata.session_id, "safe-session");
  assert.equal(result.body.client_metadata["x-codex-turn-state"], "opaque-state-token");
  assert.equal(result.body.client_metadata["x-codex-ws-stream-request-start-ms"], undefined);
  assert.equal(result.body.client_metadata.ws_request_header_traceparent, undefined);
  assert.deepEqual(
    JSON.parse(result.body.client_metadata["x-codex-turn-metadata"]),
    {
      session_id: "safe-session",
      request_kind: "turn",
      subagent_kind: "worker",
      turn_started_at_unix_ms: 123456
    }
  );
  assert.equal(JSON.stringify(result.body.client_metadata).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(result.body.client_metadata).includes(PRIVATE_KEY), false);
});

test("Codex request transformation sanitizes model-visible fields and preserves protocol identity", async () => {
  const body = sampleRequest();
  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: deterministicSanitizer,
    fallbackSessionId: "fallback"
  });

  assert.equal(result.sessionKey, "codex-provider:thread-123");
  assert.deepEqual(result.sessionMapAdditions, sessionMap);
  assert.equal(result.body.model, "gpt-5.4-mini");
  assert.equal(result.body.input[1].call_id, "call-unchanged");
  assert.equal(result.body.input[1].output.includes(PRIVATE_EMAIL), false);
  assert.equal(result.body.input[1].output.includes("[EMAIL_1]"), true);
  assert.equal(result.body.input[2].arguments.includes(PRIVATE_KEY), false);
  assert.equal(result.body.input[2].arguments.includes("[API_KEY_1]"), true);
  assert.equal(result.body.instructions.includes(PRIVATE_EMAIL), false);
  assert.equal(result.body.tools[0].description.includes("[EMAIL_1]"), true);
  assert.match(result.body.prompt_cache_key, /^privacyai:[a-f0-9]{64}$/);
  assert.equal(result.body.client_metadata.thread_id, "thread-123");

  const metadata = JSON.parse(result.body.client_metadata["x-codex-turn-metadata"]);
  assert.equal(metadata.thread_id, "thread-123");
  assert.equal(Object.hasOwn(metadata, "workspaces"), false);
  assert.equal(Object.hasOwn(metadata, "extra"), false);
  assert.equal(JSON.stringify(result.body).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(result.body).includes(PRIVATE_KEY), false);
});

test("Codex function-call argument keys remain structural while leaf values are sanitized", async () => {
  const body = sampleRequest();
  body.instructions = "Use the wait tool safely.";
  body.input = [{
    type: "function_call",
    call_id: "wait-call",
    name: "wait",
    arguments: JSON.stringify({
      cell_id: "3",
      nested: { owner: PRIVATE_EMAIL },
      dynamic: { [PRIVATE_EMAIL]: "public" }
    })
  }];
  body.tools = [{
    type: "function",
    name: "wait",
    description: "Wait for a running cell.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        cell_id: { type: "string" },
        nested: {
          type: "object",
          properties: { owner: { type: "string" } },
          required: ["owner"]
        },
        dynamic: {
          type: "object",
          additionalProperties: { type: "string" }
        }
      },
      required: ["cell_id"]
    }
  }];

  let sawCellId = false;
  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: async text => {
      sawCellId ||= text.includes("cell_id");
      let sanitizedPrompt = text;
      const mapped = {};
      if (text.includes("cell_id")) {
        sanitizedPrompt = sanitizedPrompt.replaceAll("cell_id", "[PRIVATE_VALUE_9]");
        mapped["[PRIVATE_VALUE_9]"] = "cell_id";
      }
      if (text.includes(PRIVATE_EMAIL)) {
        sanitizedPrompt = sanitizedPrompt.replaceAll(PRIVATE_EMAIL, "[EMAIL_1]");
        mapped["[EMAIL_1]"] = PRIVATE_EMAIL;
      }
      return { sanitizedPrompt, sessionMap: mapped };
    }
  });

  assert.equal(sawCellId, false);
  assert.deepEqual(JSON.parse(result.body.input[0].arguments), {
    cell_id: "3",
    nested: { owner: "[EMAIL_1]" },
    dynamic: { "[EMAIL_1]": "public" }
  });
  assert.equal(Object.values(result.sessionMapAdditions).includes("cell_id"), false);
  assert.equal(result.sessionMapAdditions["[EMAIL_1]"], PRIVATE_EMAIL);
});

test("Codex drops schema-identifier false positives learned from prose", async () => {
  const body = sampleRequest();
  body.instructions = "safe";
  body.input = [{
    type: "function_call",
    call_id: "wait-prose-call",
    name: "wait",
    arguments: JSON.stringify({ cell_id: "3" })
  }];
  body.tools = [{
    type: "function",
    name: "wait",
    description: "Wait using cell_id until completion.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        cell_id: { type: "string" },
        internal_customer_field: { type: "string" }
      },
      required: ["cell_id"]
    }
  }];

  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: async text => text.includes("cell_id")
      ? {
          sanitizedPrompt: text.replaceAll("cell_id", "[PRIVATE_VALUE_9]"),
          sessionMap: { "[PRIVATE_VALUE_9]": "cell_id" }
        }
      : { sanitizedPrompt: text, sessionMap: {} }
  });

  assert.equal(result.body.tools[0].description, "Wait using cell_id until completion.");
  assert.equal(Object.values(result.sessionMapAdditions).includes("cell_id"), false);
  assert.equal(result.cacheWrites.some(([, record]) =>
    Object.values(record.sessionMapAdditions || {}).includes("cell_id")
  ), false);
});

test("Codex ignores legacy cached mappings for safe schema identifiers", async () => {
  const body = sampleRequest();
  body.instructions = "safe";
  body.prompt_cache_key = "safe-cache-key";
  body.input = [{
    type: "function_call",
    call_id: "wait-cache-call",
    name: "wait",
    arguments: JSON.stringify({ cell_id: "3" })
  }];
  body.tools = [{
    type: "function",
    name: "wait",
    description: "Wait for a running cell.",
    strict: true,
    parameters: {
      type: "object",
      properties: { cell_id: { type: "string" } },
      required: ["cell_id"]
    }
  }];

  const policyFingerprint = "legacy-schema-key-cache";
  const seed = buildCodexRequestVerificationSeed(body, {}, { policyFingerprint });
  const cache = new Map(seed.cacheWrites.map(([key, verification]) => [key, {
    ...verification,
    sessionMapAdditions: {
      ...(verification.sessionMapAdditions || {}),
      "[PRIVATE_VALUE_9]": "cell_id"
    }
  }]));
  let sanitizerCalls = 0;
  const result = await sanitizeCodexRequestBody(body, {
    cache,
    policyFingerprint,
    sanitizer: async text => {
      sanitizerCalls += 1;
      return { sanitizedPrompt: text, sessionMap: {} };
    }
  });

  assert.equal(sanitizerCalls, 0);
  assert.equal(Object.values(result.sessionMapAdditions).includes("cell_id"), false);
  assert.deepEqual(JSON.parse(result.body.input[0].arguments), { cell_id: "3" });
});

test("Codex verification seeding preserves argument keys and matches protocol-key cache policy", async () => {
  const body = sampleRequest();
  body.instructions = "safe";
  body.prompt_cache_key = "safe-cache-key";
  body.input = [{
    type: "function_call",
    call_id: "wait-seed-call",
    name: "wait",
    arguments: JSON.stringify({ cell_id: "3", note: PRIVATE_EMAIL })
  }];
  body.tools = [{
    type: "function",
    name: "wait",
    description: "Wait for a running cell.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        cell_id: { type: "string" },
        note: { type: "string" }
      },
      required: ["cell_id"]
    }
  }];

  const policyFingerprint = "seed-values-only-policy";
  const seed = buildCodexRequestVerificationSeed(body, sessionMap, { policyFingerprint });
  const argumentRecord = seed.itemRecords.find(record => record.slotKey === "input/0/arguments");
  assert.ok(argumentRecord);
  const argumentVerification = seed.cacheWrites.find(([key]) => key === argumentRecord.cacheKey)?.[1];
  assert.ok(argumentVerification);
  assert.equal(Object.values(argumentVerification.sessionMapAdditions).includes("cell_id"), false);
  assert.equal(argumentVerification.sessionMapAdditions["[EMAIL_1]"], PRIVATE_EMAIL);

  const cache = new Map(seed.cacheWrites);
  let sanitizerCalls = 0;
  const result = await sanitizeCodexRequestBody(body, {
    cache,
    policyFingerprint,
    sessionMap,
    sanitizer: async text => {
      sanitizerCalls += 1;
      return { sanitizedPrompt: text, sessionMap: {} };
    }
  });

  assert.equal(sanitizerCalls, 0);
  assert.deepEqual(JSON.parse(result.body.input[0].arguments), {
    cell_id: "3",
    note: "[EMAIL_1]"
  });
  assert.equal(result.metrics.cacheHitCount > 0, true);
});

test("Codex prunes only safe schema-declared argument-key mappings from poisoned sessions", () => {
  const body = sampleRequest();
  body.input = [{
    type: "function_call",
    call_id: "wait-call",
    name: "wait",
    arguments: JSON.stringify({
      cell_id: "3",
      unrelated_key: "kept",
      internal_customer_field: "private"
    })
  }];
  body.tools = [{
    type: "function",
    name: "wait",
    description: "Wait for a running cell.",
    strict: true,
    parameters: {
      type: "object",
      properties: { cell_id: { type: "string" } },
      required: ["cell_id"]
    }
  }];

  const poisoned = {
    "[PRIVATE_VALUE_9]": "cell_id",
    "[PRIVATE_VALUE_10]": "unrelated_key",
    "[PRIVATE_VALUE_11]": "internal_customer_field",
    "[EMAIL_1]": PRIVATE_EMAIL
  };
  const pruned = pruneCodexArgumentKeyMappings(body, poisoned);
  assert.equal(Object.values(pruned).includes("cell_id"), false);
  assert.equal(pruned["[PRIVATE_VALUE_10]"], "unrelated_key");
  assert.equal(pruned["[PRIVATE_VALUE_11]"], "internal_customer_field");
  assert.equal(pruned["[EMAIL_1]"], PRIVATE_EMAIL);

  const noSchema = { ...body, tools: [] };
  assert.equal(
    pruneCodexArgumentKeyMappings(noSchema, poisoned)["[PRIVATE_VALUE_9]"],
    "cell_id"
  );

  const sensitiveKeyBody = { ...body };
  sensitiveKeyBody.input = [{
    type: "function_call",
    call_id: "sensitive-call",
    name: "sensitive_tool",
    arguments: JSON.stringify({ [PRIVATE_EMAIL]: "value" })
  }];
  sensitiveKeyBody.tools = [{
    type: "function",
    name: "sensitive_tool",
    description: "Test sensitive schema keys.",
    strict: true,
    parameters: {
      type: "object",
      properties: { [PRIVATE_EMAIL]: { type: "string" } }
    }
  }];
  assert.equal(
    pruneCodexArgumentKeyMappings(sensitiveKeyBody, poisoned)["[EMAIL_1]"],
    PRIVATE_EMAIL
  );
});

test("Codex request transformation rejects unknown fields, media, unknown items, and leaked no-op mappings", async () => {
  await assert.rejects(
    sanitizeCodexRequestBody({ ...sampleRequest(), future_private_field: PRIVATE_EMAIL }, {
      sanitizer: deterministicSanitizer
    }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD"
  );

  const media = sampleRequest();
  media.input = [{ type: "message", role: "user", content: [{ type: "output_image", image_url: "data:x" }] }];
  await assert.rejects(
    sanitizeCodexRequestBody(media, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_MEDIA"
  );

  const unknown = sampleRequest();
  unknown.input = [{ type: "future_tool_call", secret: PRIVATE_EMAIL }];
  await assert.rejects(
    sanitizeCodexRequestBody(unknown, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_INPUT"
  );

  const futureContent = sampleRequest();
  futureContent.input = [{
    type: "message",
    role: "user",
    content: [{ type: "future_text", payload: PRIVATE_EMAIL }]
  }];
  await assert.rejects(
    sanitizeCodexRequestBody(futureContent, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_CONTENT"
  );

  const malformedText = sampleRequest();
  malformedText.input = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: { private: PRIVATE_EMAIL } }]
  }];
  await assert.rejects(
    sanitizeCodexRequestBody(malformedText, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_CONTENT"
  );

  await assert.rejects(
    sanitizeCodexRequestBody(sampleRequest(), {
      sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: { "[EMAIL_1]": PRIVATE_EMAIL } })
    }),
    error => new Set([
      "PRIVACYAI_INVALID_SANITIZED_CONTEXT",
      "PRIVACYAI_PROVIDER_PAYLOAD_LEAK"
    ]).has(error?.code)
  );
});

test("Codex request controls reject private or unsupported protocol values", async () => {
  const cases = [
    [request => { request.model = PRIVATE_EMAIL; }, "PRIVACYAI_CODEX_INVALID_PROTOCOL_TOKEN"],
    [request => { request.tool_choice = PRIVATE_EMAIL; }, "PRIVACYAI_CODEX_UNSUPPORTED_TOOL_CHOICE"],
    [request => { request.reasoning = { effort: PRIVATE_EMAIL }; }, "PRIVACYAI_CODEX_UNSUPPORTED_REASONING"],
    [request => { request.reasoning = { effort: "medium", private: PRIVATE_EMAIL }; }, "PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD"],
    [request => { request.stream_options = { reasoning_summary_delivery: PRIVATE_EMAIL }; }, "PRIVACYAI_CODEX_UNSUPPORTED_STREAM_OPTIONS"],
    [request => { request.include = [PRIVATE_EMAIL]; }, "PRIVACYAI_CODEX_UNSUPPORTED_INCLUDE"],
    [request => { request.service_tier = PRIVATE_EMAIL; }, "PRIVACYAI_CODEX_UNSUPPORTED_SERVICE_TIER"],
    [request => {
      request.text = {
        verbosity: "medium",
        format: { type: "json_schema", strict: true, schema: {}, name: PRIVATE_EMAIL }
      };
    }, "PRIVACYAI_CODEX_UNSUPPORTED_TEXT_CONTROL"]
  ];

  for (const [mutate, code] of cases) {
    const request = sampleRequest();
    mutate(request);
    await assert.rejects(
      sanitizeCodexRequestBody(request, { sanitizer: deterministicSanitizer }),
      error => error?.code === code
    );
  }
});

test("Codex rejects invalid provider identifiers before forwarding", async () => {
  const body = sampleRequest();
  body.tools[0].name = "invalid.tool.name";
  await assert.rejects(
    sanitizeCodexRequestBody(body, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_INVALID_TOOL_IDENTIFIER"
  );
});

test("Codex tool and history shapes reject unknown keys while preserving local custom tools", async () => {
  const unknownToolKey = sampleRequest();
  unknownToolKey.tools[0][PRIVATE_EMAIL] = PRIVATE_KEY;
  await assert.rejects(
    sanitizeCodexRequestBody(unknownToolKey, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD"
  );

  const unknownItemKey = sampleRequest();
  unknownItemKey.input[0][PRIVATE_EMAIL] = PRIVATE_KEY;
  await assert.rejects(
    sanitizeCodexRequestBody(unknownItemKey, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD"
  );

  const hosted = sampleRequest();
  hosted.tools = [{ type: "web_search", external_web_access: true }];
  await assert.rejects(
    sanitizeCodexRequestBody(hosted, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_PROVIDER_TOOL"
  );

  const custom = sampleRequest();
  custom.instructions = "Safe instructions";
  custom.input = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Safe request" }]
  }];
  custom.prompt_cache_key = "cache:safe";
  custom.client_metadata = { session_id: "custom-grammar-session" };
  const grammar = [
    "start: pragma_source | plain_source",
    "pragma_source: PRAGMA_LINE NEWLINE SOURCE",
    "plain_source: SOURCE",
    "PRAGMA_LINE: /[ \\t]*\/\/ @exec:[^\r\n]*/",
    "SOURCE: /(.|\n)+/",
    "%import common.NEWLINE"
  ].join("\n");
  const sanitizerInputs = [];
  custom.tools = [{
    type: "custom",
    name: "apply_patch",
    description: "Maintain a patch for " + PRIVATE_EMAIL,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: grammar
    }
  }];
  const customResult = await sanitizeCodexRequestBody(custom, {
    sanitizer: async text => {
      sanitizerInputs.push(text);
      return {
        sanitizedPrompt: text.replace(/ai/gi, "[PRIVATE_VALUE_7]"),
        sessionMap: { "[PRIVATE_VALUE_7]": "ai" }
      };
    }
  });
  assert.match(customResult.body.tools[0].description, /\[PRIVATE_VALUE_7\]/);
  assert.equal(customResult.sessionMapAdditions["[PRIVATE_VALUE_7]"], "ai");
  assert.equal(customResult.body.tools[0].format.definition, grammar);
  assert.equal(sanitizerInputs.some(text => text.includes("plain_source: SOURCE")), false);

  const protectedGrammar = sampleRequest();
  protectedGrammar.tools = [{
    type: "custom",
    name: "apply_patch",
    description: "Apply a patch",
    format: {
      type: "grammar",
      syntax: "lark",
      definition: 'start: "' + PRIVATE_KEY + '"'
    }
  }];
  await assert.rejects(
    sanitizeCodexRequestBody(protectedGrammar, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_TOOL_STRUCTURE_IMMUTABLE_PROTECTED_VALUE" &&
      !error.message.includes(PRIVATE_KEY)
  );

  const localShell = sampleRequest();
  localShell.input = [{
    type: "local_shell_call",
    call_id: "local-shell-1",
    status: "completed",
    action: {
      type: "exec",
      command: ["printf", PRIVATE_EMAIL],
      timeout_ms: 1000,
      working_directory: `/tmp/${PRIVATE_EMAIL}`,
      env: { [PRIVATE_EMAIL]: PRIVATE_KEY },
      user: PRIVATE_EMAIL
    }
  }];
  const shellResult = await sanitizeCodexRequestBody(localShell, { sanitizer: deterministicSanitizer });
  const action = shellResult.body.input[0].action;
  assert.deepEqual(action.command, ["printf", "[EMAIL_1]"]);
  assert.equal(action.working_directory, "/tmp/[EMAIL_1]");
  assert.deepEqual(action.env, { "[EMAIL_1]": "[API_KEY_1]" });
  assert.equal(action.user, "[EMAIL_1]");
});

test("additional-tools accepts Codex roles while sanitizing definitions", async () => {
  for (const role of ["assistant", "developer", "user"]) {
    const body = sampleRequest();
    body.input = [{
      type: "additional_tools",
      id: "additional-tools-1",
      role,
      tools: [{
        type: "function",
        name: "local_lookup",
        description: `Look up ${PRIVATE_EMAIL}`,
        strict: false,
        parameters: { type: "object", properties: { key: { type: "string" } } }
      }]
    }];
    const result = await sanitizeCodexRequestBody(body, { sanitizer: deterministicSanitizer });
    assert.equal(result.body.input[0].tools[0].description.includes(PRIVATE_EMAIL), false);
    assert.match(result.body.input[0].tools[0].description, /\[EMAIL_1\]/);
  }

  const invalid = sampleRequest();
  invalid.input = [{ type: "additional_tools", role: "system", tools: [] }];
  await assert.rejects(
    sanitizeCodexRequestBody(invalid, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_INPUT"
  );
});

test("protected tool-search names use reversible provider-safe aliases", async () => {
  const privateToolName = "browser_toggle_visibility";
  const body = sampleRequest();
  body.instructions = `Use ${privateToolName} when needed.`;
  body.tools = [];
  body.input = [{
    type: "tool_search_output",
    call_id: "tool-search-alias",
    status: "completed",
    execution: "client",
    tools: [{
      type: "namespace",
      name: "stealth-browser",
      description: `Browser tools including ${privateToolName}`,
      tools: [{
        type: "function",
        name: privateToolName,
        description: `Call ${privateToolName}`,
        strict: false,
        parameters: { type: "object", properties: {} }
      }]
    }]
  }];

  const sanitizer = async text => {
    const found = text.includes(privateToolName);
    return {
      sanitizedPrompt: found ? text.replaceAll(privateToolName, "[PRIVATE_VALUE_5]") : text,
      sessionMap: found ? { "[PRIVATE_VALUE_5]": privateToolName } : {}
    };
  };
  const result = await sanitizeCodexRequestBody(body, { sanitizer });
  const providerName = result.body.input[0].tools[0].tools[0].name;

  assert.equal(providerName, "PRIVATE_VALUE_5");
  assert.match(providerName, /^[A-Za-z0-9_-]+$/);
  assert.equal(result.body.instructions.includes("[PRIVATE_VALUE_5]"), true);
  assert.equal(result.body.input[0].tools[0].tools[0].description.includes("[PRIVATE_VALUE_5]"), true);
  assert.equal(result.sessionMapAdditions["[PRIVATE_VALUE_5]"], privateToolName);
  assert.equal(result.sessionMapAdditions[providerName], privateToolName);

  const call = {
    type: "function_call",
    call_id: "tool-search-alias-call",
    name: providerName,
    arguments: "{}"
  };
  restoreResponseItem(call, result.sessionMapAdditions);
  assert.equal(call.name, privateToolName);
});

test("provider identifier aliases survive repeated gateway turns", async t => {
  const privateToolName = "browser_toggle_visibility";
  const root = await createTestTempDir("privacyai-identifier-alias-");
  const seenNames = [];
  const upstream = await startServer(async (request, response) => {
    const body = await readRequestJson(request);
    seenNames.push(body.input[0].tools[0].tools[0].name);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse({ type: "response.completed", response: { id: "identifier-alias", usage: null } }) +
      "data: [DONE]\n\n"
    );
  });
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    baseDir: root,
    verificationDbPath: join(root, "context.sqlite3"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true,
    sanitizer: async text => {
      const found = text.includes(privateToolName);
      return {
        sanitizedPrompt: found ? text.replaceAll(privateToolName, "[PRIVATE_VALUE_5]") : text,
        sessionMap: found ? { "[PRIVATE_VALUE_5]": privateToolName } : {}
      };
    }
  });
  t.after(() => gateway.close());

  const body = sampleRequest();
  body.instructions = `Use ${privateToolName}.`;
  body.tools = [];
  body.input = [{
    type: "tool_search_output",
    call_id: "tool-search-repeat",
    status: "completed",
    execution: "client",
    tools: [{
      type: "namespace",
      name: "stealth-browser",
      description: "Browser tools",
      tools: [{
        type: "function",
        name: privateToolName,
        description: `Call ${privateToolName}`,
        strict: false,
        parameters: { type: "object", properties: {} }
      }]
    }]
  }];
  body.client_metadata = { thread_id: "identifier-alias-thread" };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${gateway.baseURL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200);
    await response.text();
  }

  assert.deepEqual(seenNames, ["PRIVATE_VALUE_5", "PRIVATE_VALUE_5"]);
});

test("provider-safe tool aliases avoid collisions with real tool names", async () => {
  const privateToolName = "browser_toggle_visibility";
  const body = sampleRequest();
  body.instructions = "safe";
  body.tools = [{
    type: "function",
    name: "PRIVATE_VALUE_5",
    description: "existing tool",
    strict: false,
    parameters: { type: "object", properties: {} }
  }, {
    type: "function",
    name: privateToolName,
    description: "protected tool",
    strict: false,
    parameters: { type: "object", properties: {} }
  }];
  body.input = [];

  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: async text => {
      const found = text.includes(privateToolName);
      return {
        sanitizedPrompt: found ? text.replaceAll(privateToolName, "[PRIVATE_VALUE_5]") : text,
        sessionMap: found ? { "[PRIVATE_VALUE_5]": privateToolName } : {}
      };
    }
  });
  const alias = result.body.tools[1].name;

  assert.notEqual(alias, "PRIVATE_VALUE_5");
  assert.match(alias, /^privacyai_[a-f0-9]{24}(?:_\d+)?$/);
  assert.match(alias, /^[A-Za-z0-9_-]+$/);
  assert.equal(result.sessionMapAdditions[alias], privateToolName);

  const call = { type: "function_call", call_id: "collision-call", name: alias, arguments: "{}" };
  restoreResponseItem(call, result.sessionMapAdditions);
  assert.equal(call.name, privateToolName);
});

test("Codex function-call arguments sanitize values without classifying protocol keys", async () => {
  const body = sampleRequest();
  const calls = [];
  body.instructions = "safe";
  body.tools = [];
  body.prompt_cache_key = "safe-cache-key";
  body.input = [{
    type: "additional_tools",
    role: "developer",
    tools: [{
      type: "function",
      name: "wait",
      description: "Wait for a running cell.",
      strict: false,
      parameters: {
        type: "object",
        properties: {
          cell_id: { type: "string" },
          yield_time_ms: { type: "integer" }
        },
        required: ["cell_id"]
      }
    }]
  }, {
    type: "function_call",
    call_id: "call-wait",
    name: "wait",
    arguments: JSON.stringify({ cell_id: "3", yield_time_ms: 10000, note: PRIVATE_EMAIL })
  }];

  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: async text => {
      calls.push(text);
      return deterministicSanitizer(text);
    }
  });
  const args = JSON.parse(result.body.input[1].arguments);

  assert.equal(calls.some(text => text.includes("cell_id")), false);
  assert.equal(calls.some(text => text.includes("yield_time_ms")), false);
  assert.deepEqual(args, { cell_id: "3", yield_time_ms: 10000, note: "[EMAIL_1]" });
  assert.equal(result.sessionMapAdditions["[EMAIL_1]"], PRIVATE_EMAIL);
  assert.equal(Object.values(result.sessionMapAdditions).includes("cell_id"), false);
});

test("Codex JSON Schema policy preserves protocol fields and only sanitizes prose annotations", async () => {
  const body = sampleRequest();
  const sanitizerCalls = [];
  const emailField = "owner_email";
  const credentialField = "credential_hint";
  body.tools[0].parameters = {
    $id: "urn:privacyai:tool",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $anchor: "tool-root",
    $dynamicAnchor: "dynamic-tool-root",
    type: "object",
    properties: {
      [emailField]: {
        type: "string",
        description: `value for ${PRIVATE_EMAIL}`,
        title: `Title ${PRIVATE_KEY}`
      },
      nested: {
        type: "object",
        properties: {
          [credentialField]: { type: "string", $comment: `Comment ${PRIVATE_EMAIL}` }
        },
        required: [credentialField]
      }
    },
    patternProperties: { "^private_[0-9]+$": { type: "string" } },
    dependentSchemas: { dependent: { const: credentialField } },
    required: [emailField],
    $defs: { ScreenshotOutputFormat: { enum: ["image", "text"] } },
    definitions: { LegacyOutput: { type: "boolean" } },
    allOf: [{ $ref: "#/$defs/ScreenshotOutputFormat" }],
    default: { description: "DEFAULT_DESCRIPTION_SENTINEL" },
    const: { title: "CONST_TITLE_SENTINEL" },
    examples: [{ $comment: "EXAMPLE_COMMENT_SENTINEL" }],
    "x-provider-metadata": { description: "EXTENSION_DESCRIPTION_SENTINEL" }
  };

  const traces = [];
  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: async text => {
      sanitizerCalls.push(text);
      return deterministicSanitizer(text);
    },
    onSchemaTrace: trace => traces.push(trace)
  });
  const schema = result.body.tools[0].parameters;
  assert.equal(Object.hasOwn(schema.properties, emailField), true);
  assert.deepEqual(schema.required, [emailField]);
  assert.equal(Object.hasOwn(schema.properties.nested.properties, credentialField), true);
  assert.deepEqual(schema.properties.nested.required, [credentialField]);
  assert.equal(schema.allOf[0].$ref, "#/$defs/ScreenshotOutputFormat");
  assert.deepEqual(schema.$defs.ScreenshotOutputFormat.enum, ["image", "text"]);
  assert.equal(schema.dependentSchemas.dependent.const, credentialField);
  assert.deepEqual(schema.default, { description: "DEFAULT_DESCRIPTION_SENTINEL" });
  assert.deepEqual(schema.const, { title: "CONST_TITLE_SENTINEL" });
  assert.deepEqual(schema.examples, [{ $comment: "EXAMPLE_COMMENT_SENTINEL" }]);
  assert.deepEqual(schema["x-provider-metadata"], {
    description: "EXTENSION_DESCRIPTION_SENTINEL"
  });
  assert.equal(schema.properties[emailField].description, "value for [EMAIL_1]");
  assert.equal(schema.properties[emailField].title, "Title [API_KEY_1]");
  assert.equal(schema.properties.nested.properties[credentialField].$comment, "Comment [EMAIL_1]");
  assert.equal(sanitizerCalls.some(value => value.includes("#/$defs/ScreenshotOutputFormat")), false);
  assert.equal(sanitizerCalls.some(value => value === PRIVATE_EMAIL || value === PRIVATE_KEY), false);
  const serializedSanitizerCalls = JSON.stringify(sanitizerCalls);
  for (const sentinel of [
    "DEFAULT_DESCRIPTION_SENTINEL",
    "CONST_TITLE_SENTINEL",
    "EXAMPLE_COMMENT_SENTINEL",
    "EXTENSION_DESCRIPTION_SENTINEL"
  ]) {
    assert.equal(serializedSanitizerCalls.includes(sentinel), false);
  }
  assert.deepEqual(restoreValue(schema, sessionMap), body.tools[0].parameters);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].structurePreserved, true);
  assert.equal(traces[0].sanitizedAnnotationCount, 3);
  assert.equal(traces[0].schemaKind, "tool_parameters");
  const serializedTrace = JSON.stringify(traces);
  assert.equal(serializedTrace.includes(PRIVATE_EMAIL), false);
  assert.equal(serializedTrace.includes(PRIVATE_KEY), false);
  assert.equal(serializedTrace.includes("ScreenshotOutputFormat"), false);

  const call = {
    type: "function_call",
    call_id: "schema-call",
    name: "shell_command",
    arguments: JSON.stringify({
      [PRIVATE_EMAIL]: "visible",
      nested: { [PRIVATE_KEY]: "value" }
    })
  };
  restoreResponseItem(call, sessionMap);
  assert.deepEqual(JSON.parse(call.arguments), {
    [PRIVATE_EMAIL]: "visible",
    nested: { [PRIVATE_KEY]: "value" }
  });
});

test("Codex schema traces report warm cache hits without reclassifying structure", async () => {
  const body = sampleRequest();
  body.tools[0].parameters = {
    type: "object",
    description: "Owner " + PRIVATE_EMAIL,
    properties: {}
  };
  const cache = new Map();
  let calls = 0;
  const sanitizer = async text => {
    calls += 1;
    return deterministicSanitizer(text);
  };

  const first = await sanitizeCodexRequestBody(body, { cache, sanitizer });
  for (const [key, record] of first.cacheWrites) cache.set(key, record);
  const firstCalls = calls;
  assert.equal(first.schemaTraces[0].cacheHitCount, 0);

  const second = await sanitizeCodexRequestBody(body, { cache, sanitizer });
  assert.equal(calls, firstCalls);
  assert.equal(second.schemaTraces[0].cacheHitCount, 1);
  assert.equal(second.schemaTraces[0].structurePreserved, true);
});

test("Codex text.format schema uses the same immutable policy, including boolean schemas", async () => {
  const body = sampleRequest();
  body.text = { format: {
    type: "json_schema",
    strict: true,
    name: "codex_output_schema",
    schema: {
      $defs: { ScreenshotOutputFormat: { type: "string" } },
      $ref: "#/$defs/ScreenshotOutputFormat",
      description: `Output for ${PRIVATE_EMAIL}`,
      properties: {},
      required: ["__proto__"]
    }
  } };
  Object.defineProperty(body.text.format.schema.properties, "__proto__", {
    value: { title: `Owner ${PRIVATE_KEY}`, type: "string" },
    enumerable: true,
    configurable: true,
    writable: true
  });
  const calls = [];
  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: async value => {
      calls.push(value);
      return deterministicSanitizer(value);
    }
  });
  const schema = result.body.text.format.schema;
  assert.equal(schema.$ref, "#/$defs/ScreenshotOutputFormat");
  assert.equal(Object.hasOwn(schema.properties, "__proto__"), true);
  assert.deepEqual(schema.required, ["__proto__"]);
  assert.equal(schema.description, "Output for [EMAIL_1]");
  assert.equal(schema.properties.__proto__.title, "Owner [API_KEY_1]");
  assert.equal(calls.some(value => value.includes("ScreenshotOutputFormat")), false);
  assert.equal(result.schemaTraces.find(trace => trace.schemaKind === "text_format")?.structurePreserved, true);

  body.text.format.schema = true;
  const booleanResult = await sanitizeCodexRequestBody(body, { sanitizer: deterministicSanitizer });
  assert.equal(booleanResult.body.text.format.schema, true);
});

test("Codex schema policy fails closed for detectable or known protected immutable identifiers and malformed schemas", async () => {
  const body = sampleRequest();
  body.tools[0].parameters = {
    type: "object",
    $defs: { [PRIVATE_EMAIL]: { type: "string" } }
  };
  await assert.rejects(
    sanitizeCodexRequestBody(body, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_SCHEMA_IMMUTABLE_PROTECTED_VALUE" && !error.message.includes(PRIVATE_EMAIL)
  );

  for (const knownPrivateIdentifier of [
    "internal-customer-field",
    "internal_customer_field"
  ]) {
    body.tools[0].parameters = {
      type: "object",
      properties: { [knownPrivateIdentifier]: { type: "string" } }
    };
    await assert.rejects(
      sanitizeCodexRequestBody(body, {
        sanitizer: deterministicSanitizer,
        sessionMap: { "[PRIVATE_VALUE_99]": knownPrivateIdentifier }
      }),
      error => error?.code === "PRIVACYAI_CODEX_SCHEMA_IMMUTABLE_PROTECTED_VALUE" &&
        !error.message.includes(knownPrivateIdentifier)
    );
  }
  for (const malformedSchema of [
    [],
    { type: "object", properties: [] },
    { type: "object", allOf: {} },
    { type: "object", required: [7] },
    { type: "invalid-type" }
  ]) {
    body.tools[0].parameters = malformedSchema;
    await assert.rejects(
      sanitizeCodexRequestBody(body, { sanitizer: deterministicSanitizer }),
      error => error?.code === "PRIVACYAI_CODEX_INVALID_TOOL_DEFINITION"
    );
  }
});

test("restoreResponseItem rejects unknown and provider-hosted response items", () => {
  for (const item of [
    { type: "future_provider_tool", private: "[EMAIL_1]" },
    { type: "web_search_call", action: { query: "[EMAIL_1]" } },
    { type: "image_generation_call", revised_prompt: "[EMAIL_1]" },
    { type: "other", value: "[EMAIL_1]" }
  ]) {
    assert.throws(
      () => restoreResponseItem(item, sessionMap),
      error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_ITEM"
    );
  }

  assert.throws(
    () =>
      restoreResponseItem(
        {
          type: "message",
          role: "assistant",
          content: [{ type: "future_text", payload: "[EMAIL_1]" }]
        },
        sessionMap
      ),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_CONTENT"
  );
});

test("restoreResponseItem restores string outputs and JSON-sensitive function arguments", () => {
  const output = { type: "function_call_output", call_id: "call-1", output: "owner=[EMAIL_1]" };
  restoreResponseItem(output, sessionMap);
  assert.equal(output.output, `owner=${PRIVATE_EMAIL}`);

  const functionCall = {
    type: "function_call",
    call_id: "call-2",
    name: "shell_command",
    arguments: JSON.stringify({ command: "printf '%s' '[API_KEY_1]'" })
  };
  restoreResponseItem(functionCall, sessionMap);
  assert.deepEqual(JSON.parse(functionCall.arguments), { command: `printf '%s' '${PRIVATE_KEY}'` });

  const localShell = {
    type: "local_shell_call",
    call_id: "shell-1",
    status: "completed",
    action: {
      type: "exec",
      command: ["printf", "[EMAIL_1]"],
      timeout_ms: 1000,
      working_directory: "/tmp/[EMAIL_1]",
      env: { "[EMAIL_1]": "[API_KEY_1]" },
      user: "[EMAIL_1]"
    }
  };
  restoreResponseItem(localShell, sessionMap);
  assert.deepEqual(localShell.action, {
    type: "exec",
    command: ["printf", PRIVATE_EMAIL],
    timeout_ms: 1000,
    working_directory: `/tmp/${PRIVATE_EMAIL}`,
    env: { [PRIVATE_EMAIL]: PRIVATE_KEY },
    user: PRIVATE_EMAIL
  });
});

test("Codex SSE restorer exposes complete restored structured tool calls once", () => {
  const restorer = new CodexSseRestorer(sessionMap);
  const patch = "*** Begin Patch\n*** Add File: owner.txt\n+[EMAIL_1]\n*** End Patch";
  const output = restorer.write(Buffer.from(sse({
    type: "response.output_item.done",
    item: {
      id: "tool-item",
      type: "custom_tool_call",
      status: "completed",
      call_id: "call-patch",
      name: "apply_patch",
      input: patch
    }
  })));
  assert.equal(output.length, 1);
  const calls = restorer.drainCompletedToolCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.includes(PRIVATE_EMAIL), true);
  assert.deepEqual(restorer.drainCompletedToolCalls(), []);
});

test("Codex SSE restoration survives network and event fragmentation without corrupting JSON", () => {
  const original = 'line "one"\nline two@example.test';
  const restorer = new CodexSseRestorer({ "[PRIVATE_VALUE_1]": original });
  const frames = [
    sse({ type: "response.output_text.delta", item_id: "msg-1", delta: "Use [PRIVATE_" }),
    sse({ type: "response.output_text.delta", item_id: "msg-1", delta: "VALUE_1] now" }),
    sse({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call-1",
        name: "shell_command",
        arguments: JSON.stringify({ command: "printf '%s' '[PRIVATE_VALUE_1]'" })
      }
    }),
    sse({ type: "response.completed", response: { id: "resp-1", usage: null } })
  ].join("");
  const bytes = Buffer.from(frames);
  const outputs = [];
  for (let index = 0; index < bytes.length; index += 3) {
    outputs.push(...restorer.write(bytes.subarray(index, index + 3)));
  }
  outputs.push(...restorer.end());

  const events = parseSse(outputs.join(""));
  const deltas = events.filter(event => event.type === "response.output_text.delta");
  assert.equal(deltas.map(event => event.delta).join(""), `Use ${original} now`);
  const call = events.find(event => event.type === "response.output_item.done");
  assert.deepEqual(JSON.parse(call.item.arguments), { command: `printf '%s' '${original}'` });
});

test("Codex SSE reconstructs streamed function arguments before local restoration", () => {
  const restorer = new CodexSseRestorer(sessionMap);
  const frames = [
    sse({
      type: "response.output_item.added",
      item: {
        id: "fc-streamed",
        type: "function_call",
        call_id: "call-streamed",
        name: "shell_command",
        arguments: ""
      }
    }),
    sse({
      type: "response.function_call_arguments.delta",
      item_id: "fc-streamed",
      delta: '{"command":"printf %s ',
    }),
    sse({
      type: "response.function_call_arguments.delta",
      item_id: "fc-streamed",
      delta: '[EMAIL_1]","[API_KEY_1]":"value"}'
    }),
    sse({
      type: "response.function_call_arguments.done",
      item_id: "fc-streamed",
      arguments: '{"command":"printf %s [EMAIL_1]","[API_KEY_1]":"value"}'
    }),
    sse({
      type: "response.output_item.done",
      item: {
        id: "fc-streamed",
        type: "function_call",
        call_id: "call-streamed",
        name: "shell_command",
        arguments: ""
      }
    }),
    sse({ type: "response.completed", response: { id: "response-streamed", usage: null } })
  ].join("");

  const output = [...restorer.write(Buffer.from(frames)), ...restorer.end()].join("");
  const events = parseSse(output);
  assert.equal(events.some(event => event.type === "response.function_call_arguments.delta"), false);
  assert.equal(events.some(event => event.type === "response.function_call_arguments.done"), false);
  const started = events.find(event => event.type === "response.output_item.added");
  assert.equal(started.item.arguments, "");
  const completed = events.find(event => event.type === "response.output_item.done");
  assert.deepEqual(JSON.parse(completed.item.arguments), {
    command: `printf %s ${PRIVATE_EMAIL}`,
    [PRIVATE_KEY]: "value"
  });
});

test("Codex SSE rejects incomplete and conflicting streamed function arguments", () => {
  const incomplete = new CodexSseRestorer(sessionMap);
  incomplete.write(Buffer.from([
    sse({
      type: "response.output_item.added",
      item: { id: "fc-incomplete", type: "function_call", call_id: "call-incomplete", name: "shell_command", arguments: "" }
    }),
    sse({ type: "response.function_call_arguments.delta", item_id: "fc-incomplete", delta: '{"command":"x"' })
  ].join("")));
  assert.throws(
    () => incomplete.end(),
    error => error?.code === "PRIVACYAI_CODEX_INCOMPLETE_TOOL_ARGUMENTS"
  );

  const conflicting = new CodexSseRestorer(sessionMap);
  assert.throws(
    () => conflicting.write(Buffer.from([
      sse({
        type: "response.output_item.added",
        item: { id: "fc-conflict", type: "function_call", call_id: "call-conflict", name: "shell_command", arguments: "" }
      }),
      sse({ type: "response.function_call_arguments.delta", item_id: "fc-conflict", delta: '{"command":"one"}' }),
      sse({
        type: "response.output_item.done",
        item: { id: "fc-conflict", type: "function_call", call_id: "call-conflict", name: "shell_command", arguments: '{"command":"two"}' }
      })
    ].join(""))),
    error => error?.code === "PRIVACYAI_CODEX_CONFLICTING_TOOL_ARGUMENTS"
  );
});

test("Codex SSE handles CRLF, multiline data, DONE flushing, and malformed endings", () => {
  const restorer = new CodexSseRestorer(sessionMap);
  const input = [
    "event: response.output_text.delta\r\n",
    'data: {"type":"response.output_text.delta",\r\n',
    'data: "item_id":"msg-crlf","delta":"Hello [EMAIL_"}\r\n\r\n',
    'data: {"type":"response.output_text.delta","item_id":"msg-crlf","delta":"1]"}\r\n\r\n',
    "data: [DONE]\r\n\r\n"
  ].join("");
  const output = [...restorer.write(Buffer.from(input)), ...restorer.end()].join("");
  const events = parseSse(output);
  assert.equal(events.map(event => event.delta || "").join(""), `Hello ${PRIVATE_EMAIL}`);
  assert.equal(output.includes("data: [DONE]"), true);

  const incomplete = new CodexSseRestorer(sessionMap);
  incomplete.write(Buffer.from('data: {"type":"response.output_text.delta"}'));
  assert.throws(
    () => incomplete.end(),
    error => error?.code === "PRIVACYAI_CODEX_INCOMPLETE_SSE"
  );

  const malformed = new CodexSseRestorer(sessionMap);
  assert.throws(
    () => malformed.write(Buffer.from("data: not-json\n\n")),
    error => error?.code === "PRIVACYAI_CODEX_INVALID_SSE"
  );

  const suppressed = new CodexSseRestorer(sessionMap);
  assert.deepEqual(
    suppressed.write(Buffer.from(sse({ type: "response.output_text.done", text: "ignored [EMAIL_1]" }))),
    []
  );
  assert.deepEqual(suppressed.end(), []);

  const reasoningDone = new CodexSseRestorer(sessionMap);
  const reasoningOutput = reasoningDone.write(Buffer.from(sse({
    type: "response.reasoning_summary_text.done",
    item_id: "reasoning-1",
    summary_index: 0,
    text: "Owner [EMAIL_1]"
  })));
  assert.equal(parseSse(reasoningOutput.join(""))[0].text, `Owner ${PRIVATE_EMAIL}`);
  assert.deepEqual(reasoningDone.end(), []);

  const unknown = new CodexSseRestorer(sessionMap);
  assert.throws(
    () => unknown.write(Buffer.from(sse({ type: "response.future_tool.delta", private: "[EMAIL_1]" }))),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_SSE_EVENT"
  );
});

test("localhost gateway sanitizes outbound requests and restores fragmented SSE inbound", async t => {
  const observed = [];
  const upstream = await startServer(async (request, response) => {
    const body = await readRequestJson(request);
    observed.push({ body, headers: request.headers, path: request.url });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "openai-model": "gpt-5.4-mini"
    });
    const events = [
      sse({ type: "response.created", response: { id: "resp-1" } }),
      sse({ type: "response.output_text.delta", item_id: "msg-1", delta: "Hello [EMAIL_" }),
      sse({ type: "response.output_text.delta", item_id: "msg-1", delta: "1]" }),
      sse({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "shell_command",
          arguments: JSON.stringify({ command: "printf '%s' '[API_KEY_1]'" })
        }
      }),
      sse({ type: "response.completed", response: { id: "resp-1", usage: null } })
    ].join("");
    const data = Buffer.from(events);
    for (let index = 0; index < data.length; index += 5) response.write(data.subarray(index, index + 5));
    response.end();
  });
  t.after(() => upstream.close());

  const vaultDir = await createTestTempDir("privacyai-codex-gateway-test-");
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: vaultDir,
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token-never-log",
      "content-type": "application/json"
    },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("openai-model"), "gpt-5.4-mini");
  const events = parseSse(await response.text());
  assert.equal(
    events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""),
    `Hello ${PRIVATE_EMAIL}`
  );
  const call = events.find(event => event.type === "response.output_item.done");
  assert.deepEqual(JSON.parse(call.item.arguments), { command: `printf '%s' '${PRIVATE_KEY}'` });

  assert.equal(observed.length, 1);
  assert.equal(observed[0].path, "/v1/responses");
  assert.equal(observed[0].headers.authorization, "Bearer test-token-never-log");
  assert.equal(observed[0].headers["accept-encoding"], "identity");
  assert.equal(JSON.stringify(observed[0].body).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(observed[0].body).includes(PRIVATE_KEY), false);
});

test("Codex gateway prunes legacy function-argument key mappings before schema validation", async t => {
  const observed = [];
  const upstream = await startServer(async (request, response) => {
    observed.push(await readRequestJson(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse({ type: "response.completed", response: { id: "legacy-key-cleanup", usage: null } }) +
      "data: [DONE]\n\n"
    );
  });
  t.after(() => upstream.close());

  const sessionKey = "codex-provider:legacy-argument-key-thread";
  const store = new MemoryContextVerificationStore();
  store.saveThread(sessionKey, {
    parentSessionKeys: [],
    sessionMap: { "[PRIVATE_VALUE_9]": "cell_id" },
    policyFingerprint: "legacy-policy"
  });

  const gateway = await startCodexProviderGateway({
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    verificationStore: store,
    policyFingerprint: "fixed-policy",
    baseDir: await createTestTempDir("privacyai-codex-key-cleanup-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const body = sampleRequest();
  body.instructions = "safe";
  body.tools = [];
  body.prompt_cache_key = "safe-cache-key";
  body.client_metadata = {
    session_id: "legacy-argument-key-thread",
    thread_id: "legacy-argument-key-thread",
    turn_id: "legacy-turn"
  };
  body.input = [{
    type: "additional_tools",
    role: "developer",
    tools: [{
      type: "function",
      name: "wait",
      description: "Wait for a running cell.",
      strict: false,
      parameters: {
        type: "object",
        properties: { cell_id: { type: "string" } },
        required: ["cell_id"]
      }
    }]
  }, {
    type: "function_call",
    call_id: "call-wait-legacy",
    name: "wait",
    arguments: JSON.stringify({ cell_id: "3" })
  }];

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, await response.text());
  if (!response.bodyUsed) await response.text();

  assert.equal(observed.length, 1);
  assert.equal(
    Object.hasOwn(observed[0].input[0].tools[0].parameters.properties, "cell_id"),
    true
  );
  assert.deepEqual(observed[0].input[0].tools[0].parameters.required, ["cell_id"]);
  assert.deepEqual(JSON.parse(observed[0].input[1].arguments), { cell_id: "3" });
  assert.equal(
    Object.values(store.loadThread(sessionKey).sessionMap).includes("cell_id"),
    false
  );
});

test("Codex gateway stages apply_patch and commits it from next-turn tool history", async t => {
  const project = await createTestTempDir("privacyai-codex-mutation-project-");
  await mkdir(join(project, ".git"), { recursive: true });
  const target = join(project, "owner.txt");
  await writeFile(target, "before\n");
  const store = new MemoryContextVerificationStore();
  let requestCount = 0;
  const upstream = await startServer(async (request, response) => {
    await readRequestJson(request);
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (requestCount === 1) {
      response.end(
        sse({ type: "response.created", response: { id: "mutation-response" } }) +
        sse({
          type: "response.output_item.done",
          item: {
            id: "patch-item",
            type: "custom_tool_call",
            status: "completed",
            call_id: "call-patch",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Update File: owner.txt\n@@\n-before\n+[EMAIL_1]\n*** End Patch"
          }
        }) +
        sse({ type: "response.completed", response: { id: "mutation-response", usage: null } }) +
        "data: [DONE]\n\n"
      );
    } else {
      response.end(
        sse({ type: "response.completed", response: { id: "after-mutation", usage: null } }) +
        "data: [DONE]\n\n"
      );
    }
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    verificationStore: store,
    cwd: project,
    baseDir: await createTestTempDir("privacyai-codex-mutation-vault-"),
    policyFingerprint: "sha256:codex-mutation-policy",
    apiUpstream: "http://127.0.0.1:" + upstream.port + "/v1",
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const first = await fetch(gateway.baseURL + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(first.status, 200);
  const firstEvents = parseSse(await first.text());
  const call = firstEvents.find(event => event.type === "response.output_item.done").item;
  assert.equal(call.input.includes(PRIVATE_EMAIL), true);

  await writeFile(target, PRIVATE_EMAIL + "\n");
  const secondBody = sampleRequest();
  secondBody.input = [
    call,
    { type: "custom_tool_call_output", call_id: "call-patch", name: "apply_patch", output: "Done!" }
  ];
  const second = await fetch(gateway.baseURL + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(secondBody)
  });
  assert.equal(second.status, 200);
  await second.text();

  const synthetic = {
    session_id: "codex-provider:thread-123",
    tool_use_id: "call-patch"
  };
  const mutation = store.getFileMutation(hookFileMutationId(synthetic, target));
  assert.equal(mutation.status, "committed");
  assert.equal(mutation.operationType, "apply_patch");
  assert.equal(store.getPrivacyPlan(
    mutation.nextContentHash,
    "sha256:codex-mutation-policy"
  ).spans.length, 1);
});

test("localhost gateway forwards only SDK-sanitized image and synchronized prompt mappings", async t => {
  const observed = [];
  const sourceImage = "data:image/png;base64,AAAA";
  const safeImage = "data:image/png;base64,BBBB";
  const upstream = await startServer(async (request, response) => {
    observed.push(await readRequestJson(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse({ type: "response.completed", response: { id: "image-response", usage: null } }) +
      "data: [DONE]\n\n"
    );
  });
  t.after(() => upstream.close());

  let imageCalls = 0;
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    imageSanitizer: {
      async sanitize(value) {
        imageCalls += 1;
        assert.equal(value, sourceImage);
        return {
          imageUrl: safeImage,
          changed: true,
          sessionMapAdditions: { "[EMAIL_1]": PRIVATE_EMAIL }
        };
      }
    },
    baseDir: await createTestTempDir("privacyai-codex-image-gateway-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const body = sampleRequest();
  body.instructions = "Inspect the supplied form.";
  body.tools = [];
  body.prompt_cache_key = "image-gateway-cache";
  body.client_metadata = { thread_id: "image-gateway-thread" };
  body.input = [{
    type: "message",
    role: "user",
    content: [
      { type: "input_image", image_url: sourceImage, detail: "high" },
      { type: "input_text", text: `Inspect the form owned by ${PRIVATE_EMAIL}.` }
    ]
  }];

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token-never-log",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(imageCalls, 1);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].input[0].content[0].image_url, safeImage);
  assert.equal(observed[0].input[0].content[0].detail, "high");
  assert.equal(observed[0].input[0].content[1].text, "Inspect the form owned by [EMAIL_1].");
  assert.equal(JSON.stringify(observed[0]).includes(sourceImage), false);
  assert.equal(JSON.stringify(observed[0]).includes(PRIVATE_EMAIL), false);
});

test("gateway safely probes the real headerless SSE response shape", async t => {
  const upstream = await startServer(async (_request, response) => {
    response.writeHead(200);
    const payload = [
      sse({ type: "response.created", response: { id: "headerless" } }),
      sse({ type: "response.output_text.delta", item_id: "msg", delta: "Hello [EMAIL_1]" }),
      sse({ type: "response.completed", response: { id: "headerless", usage: null } })
    ].join("");
    for (const byte of Buffer.from(payload)) response.write(Buffer.from([byte]));
    response.end();
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-headerless-sse-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const events = parseSse(await response.text());
  assert.equal(events.find(event => event.type === "response.output_text.delta").delta, `Hello ${PRIVATE_EMAIL}`);
});

test("headerless non-SSE success fails before response commitment", async t => {
  const upstream = await startServer(async (_request, response) => {
    response.writeHead(200);
    response.end("not an SSE stream");
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-headerless-invalid-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PRIVACYAI_CODEX_INCOMPLETE_SSE");
});

test("downstream disconnect cancels the active upstream SSE request", async t => {
  const diagnostics = [];
  let closeUpstream;
  const upstreamClosed = new Promise(resolve => {
    closeUpstream = resolve;
  });
  const upstream = await startServer(async (request, response) => {
    await readRequestJson(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.created", response: { id: "disconnect-response" } }));
    response.write(sse({
      type: "response.output_text.delta",
      item_id: "disconnect-message",
      delta: "first"
    }));
    const interval = setInterval(() => {
      if (!response.destroyed) {
        response.write(sse({
          type: "response.output_text.delta",
          item_id: "disconnect-message",
          delta: "more"
        }));
      }
    }, 25);
    response.once("close", () => {
      clearInterval(interval);
      closeUpstream();
    });
  });
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    onGatewayError: diagnostic => diagnostics.push(diagnostic),
    baseDir: await createTestTempDir("privacyai-codex-disconnect-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  await new Promise((resolve, reject) => {
    const target = new URL(`${gateway.baseURL}/responses`);
    const request = http.request(target, {
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    request.once("error", error => {
      if (error?.code === "ECONNRESET") resolve();
      else reject(error);
    });
    request.once("response", response => {
      response.once("data", () => {
        response.destroy();
        request.destroy();
        resolve();
      });
      response.once("error", error => {
        if (error?.code === "ECONNRESET") resolve();
        else reject(error);
      });
    });
    request.end(JSON.stringify(sampleRequest()));
  });

  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("upstream stream remained open after client disconnect")), 1500)
    )
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(diagnostics, []);
});

test("idle loopback upstream reset is classified once without leaking endpoint details", async t => {
  const diagnostics = [];
  const upstream = await startServer((request, _response) => {
    request.resume();
    request.socket.destroy(Object.assign(new Error("private upstream endpoint"), { code: "ECONNRESET" }));
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    onGatewayError: diagnostic => diagnostics.push(diagnostic),
    baseDir: await createTestTempDir("privacyai-codex-idle-reset-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());
  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PRIVACYAI_CODEX_UPSTREAM_RESET");
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]).sort(), [
    "category", "code", "downstreamClosed", "networkCode", "phase", "retryCount", "route", "timestamp"
  ]);
  assert.equal(diagnostics[0].route, "responses");
  assert.equal(diagnostics[0].networkCode, "ECONNRESET");
  assert.equal(diagnostics[0].downstreamClosed, false);
  assert.equal(JSON.stringify(diagnostics).includes("127.0.0.1"), false);
});

test("loopback upstream timeout is reported with safe timeout metadata", async t => {
  const diagnostics = [];
  const upstream = await startServer(request => request.resume());
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    onGatewayError: value => diagnostics.push(value),
    upstreamTimeoutMs: 20,
    baseDir: await createTestTempDir("privacyai-codex-timeout-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`, allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());
  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sampleRequest())
  });
  assert.equal((await response.json()).error.code, "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT");
  assert.equal(diagnostics[0].networkCode, "ETIMEDOUT");
  assert.equal(diagnostics[0].phase, "upstream_connect");
});

test("Codex gateway terminates an upstream SSE stream that stops making progress", async t => {
  const diagnostics = [];
  const upstream = await startServer(async (request, response) => {
    await readRequestJson(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.created", response: { id: "idle-response" } }));
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    onGatewayError: value => diagnostics.push(value),
    upstreamIdleTimeoutMs: 30,
    baseDir: await createTestTempDir("privacyai-codex-sse-idle-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  await response.text().catch(() => "");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].networkCode, "ETIMEDOUT");
  assert.equal(diagnostics[0].phase, "sse");
});

test("network diagnostic codes and bounded expiry-aware deduplication remain distinct", () => {
  assert.deepEqual(publicGatewayFailure({ code: "ETIMEDOUT" }), {
    code: "PRIVACYAI_CODEX_UPSTREAM_TIMEOUT", category: "timeout"
  });
  assert.deepEqual(publicGatewayFailure({ code: "EPIPE" }), {
    code: "PRIVACYAI_CODEX_UPSTREAM_BROKEN_PIPE", category: "broken_pipe"
  });
  assert.deepEqual(publicGatewayFailure({ code: "EAI_AGAIN" }), {
    code: "PRIVACYAI_CODEX_UPSTREAM_DNS", category: "dns"
  });
  assert.deepEqual(publicGatewayFailure({ code: "PRIVACYAI_INVALID_CLASSIFIER_SPAN" }), {
    code: "PRIVACYAI_INVALID_CLASSIFIER_SPAN", category: "privacy_boundary"
  });
  assert.equal(publicGatewayHttpStatus({ code: "PRIVACYAI_INVALID_CLASSIFIER_SPAN" }), 422);
  assert.equal(publicGatewayHttpStatus({ code: "PRIVACYAI_CODEX_BODY_TOO_LARGE" }), 413);
  assert.equal(publicGatewayHttpStatus({ code: "ETIMEDOUT" }), 504);
  assert.equal(publicGatewayHttpStatus(new Error("unknown")), 502);
  let clock = 1_000;
  const diagnostics = [];
  const report = createGatewayDiagnosticReporter(value => diagnostics.push(value), {
    now: () => clock, windowMs: 10, maxEntries: 2
  });
  assert.equal(report({ code: "ECONNRESET", message: PRIVATE_EMAIL }, { route: "responses", phase: "upstream_connect" }), true);
  assert.equal(report({ code: "ECONNRESET" }, { route: "responses", phase: "upstream_connect" }), false);
  assert.equal(report({ code: "ECONNRESET" }, { route: "models", phase: "upstream_connect" }), true);
  assert.equal(report({ code: "EPIPE" }, { route: "responses", phase: "upstream_connect" }), true);
  assert.equal(diagnostics.length, 3, "bounded eviction keeps distinct events");
  clock += 11;
  assert.equal(report({ code: "ECONNRESET" }, { route: "responses", phase: "upstream_connect" }), true);
  assert.equal(diagnostics.length, 4, "expired events surface again");
  clock -= 20;
  assert.equal(report({ code: "ECONNRESET" }, { route: "responses", phase: "upstream_connect" }), true);
  assert.equal(diagnostics.length, 5, "backward clocks do not suppress future diagnostics");
  assert.equal(report({ code: "PRIVACYAI_CODEX_CLIENT_DISCONNECTED" }, { route: "responses" }), false);

  for (const failingClock of [
    () => { throw new Error("clock failure"); },
    () => Infinity
  ]) {
    const fallbackDiagnostics = [];
    const fallbackReport = createGatewayDiagnosticReporter(
      value => fallbackDiagnostics.push(value),
      { now: failingClock }
    );
    assert.doesNotThrow(() => fallbackReport({ code: "EPIPE" }, { route: "responses" }));
    assert.equal(fallbackDiagnostics.length, 1);
    assert.match(fallbackDiagnostics[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test("downstream disconnect aborts in-flight sanitization before any upstream request", async t => {
  let upstreamRequests = 0;
  const upstream = await startServer(async (_request, response) => {
    upstreamRequests += 1;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected upstream request" }));
  });
  t.after(() => upstream.close());

  let markStarted;
  const sanitizerStarted = new Promise(resolve => {
    markStarted = resolve;
  });
  let markAborted;
  const sanitizerAborted = new Promise(resolve => {
    markAborted = resolve;
  });
  const gateway = await startCodexProviderGateway({
    sanitizer: async (text, options = {}) => {
      markStarted();
      return new Promise((resolve, reject) => {
        const abort = () => {
          markAborted();
          reject(options.signal?.reason || new Error("sanitizer aborted"));
        };
        if (options.signal?.aborted) {
          abort();
          return;
        }
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    },
    baseDir: await createTestTempDir("privacyai-codex-sanitizer-disconnect-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const target = new URL(`${gateway.baseURL}/responses`);
  const request = http.request(target, {
    method: "POST",
    headers: { "content-type": "application/json" }
  });
  request.on("error", () => {});
  request.end(JSON.stringify(sampleRequest()));

  await sanitizerStarted;
  request.destroy();
  await Promise.race([
    sanitizerAborted,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("sanitizer did not abort after client disconnect")), 1500)
    )
  ]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(upstreamRequests, 0);
});

test("gateway protects compact requests and passes upstream status codes without retrying", async t => {
  let requests = 0;
  const upstream = await startServer(async (request, response) => {
    requests += 1;
    const body = await readRequestJson(request);
    assert.equal(JSON.stringify(body).includes(PRIVATE_EMAIL), false);
    response.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
    response.end(JSON.stringify({ error: { message: "rate limited [EMAIL_1]" } }));
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-compact-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const compactRequest = sampleRequest();
  delete compactRequest.stream;
  const response = await fetch(`${gateway.baseURL}/responses/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compactRequest)
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.deepEqual(await response.json(), { error: { message: `rate limited ${PRIVATE_EMAIL}` } });
  assert.equal(requests, 1);
});

test("gateway validates and restores successful compact output item-by-item", async t => {
  const upstream = await startServer(async (request, response) => {
    const body = await readRequestJson(request);
    assert.equal(body.stream, undefined);
    assert.equal(JSON.stringify(body).includes(PRIVATE_EMAIL), false);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      output: [
        {
          type: "message",
          id: "compact-message-1",
          role: "assistant",
          content: [{ type: "output_text", text: "Owner [EMAIL_1]" }]
        },
        {
          type: "compaction",
          id: "compact-state-1",
          encrypted_content: "opaque-provider-state"
        }
      ]
    }));
  });
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-compact-success-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const body = sampleRequest();
  delete body.stream;
  delete body.client_metadata;
  const response = await fetch(`${gateway.baseURL}/responses/compact`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "compact-session",
        thread_id: "compact-thread",
        request_kind: "compact"
      })
    },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  const compact = await response.json();
  assert.equal(compact.output[0].content[0].text, `Owner ${PRIVATE_EMAIL}`);
  assert.equal(compact.output[1].encrypted_content, "opaque-provider-state");

  const nonStreaming = sampleRequest();
  nonStreaming.stream = false;
  const blocked = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nonStreaming)
  });
  assert.equal(blocked.status, 422);
  assert.equal((await blocked.json()).error.code, "PRIVACYAI_CODEX_STREAM_REQUIRED");
});

test("gateway fails closed for wrong nonce, compression, oversized bodies, and sanitizer failure", async t => {
  let upstreamRequests = 0;
  const upstream = await startServer((_request, response) => {
    upstreamRequests += 1;
    response.end();
  });
  t.after(() => upstream.close());
  const baseOptions = {
    baseDir: await createTestTempDir("privacyai-codex-fail-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  };
  const gateway = await startCodexProviderGateway({
    ...baseOptions,
    sanitizer: deterministicSanitizer,
    maxRequestBytes: 64
  });
  t.after(() => gateway.close());

  assert.equal((await fetch(`http://${gateway.host}:${gateway.port}/wrong/responses`)).status, 404);
  assert.equal((await fetch(`${gateway.baseURL}/future-route`)).status, 404);

  const compressed = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: "not-really-gzip"
  });
  assert.equal(compressed.status, 415);

  const oversized = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(oversized.status, 413);
  assert.equal(upstreamRequests, 0);

  const failing = await startCodexProviderGateway({
    ...baseOptions,
    baseDir: await createTestTempDir("privacyai-codex-fail-sanitizer-"),
    sanitizer: async () => {
      throw new Error(`classifier failed around ${PRIVATE_EMAIL}`);
    }
  });
  t.after(() => failing.close());
  const failed = await fetch(`${failing.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(failed.status, 502);
  const failureBody = await failed.text();
  assert.equal(failureBody.includes(PRIVATE_EMAIL), false);
  assert.equal(upstreamRequests, 0);
});

test("models route allowlists headers and the client_version query", async t => {
  const seen = [];
  const upstream = await startServer(async (request, response) => {
    seen.push({ path: request.url, headers: request.headers });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [{ id: "gpt-test" }] }));
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-models-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/models?client_version=0.144.1`, {
    headers: {
      authorization: "Bearer model-test",
      cookie: `private=${PRIVATE_KEY}`,
      "x-private-note": PRIVATE_EMAIL
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: [{ id: "gpt-test" }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/v1/models?client_version=0.144.1");
  assert.equal(seen[0].headers.authorization, "Bearer model-test");
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers["x-private-note"], undefined);

  const invalid = await fetch(`${gateway.baseURL}/models?private=${encodeURIComponent(PRIVATE_EMAIL)}`);
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json()).error.code, "PRIVACYAI_CODEX_INVALID_MODELS_QUERY");
  assert.equal(seen.length, 1);
});

test("models route rejects malformed successful catalogs", async t => {
  const upstream = await startServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-json");
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-models-invalid-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/models`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PRIVACYAI_CODEX_INVALID_MODELS_RESPONSE");
});

test("gateway returns clean failures for compressed, malformed, and binary upstream responses", async t => {
  const upstream = await startServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    await readRequestJson(request);
    if (url.searchParams.get("case") === "compressed") {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip"
      });
      response.end("compressed-bytes");
      return;
    }
    if (url.searchParams.get("case") === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.from([0, 1, 2, 3]));
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-upstream-fail-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true,
    allowTestQueryParameters: true
  });
  t.after(() => gateway.close());

  for (const [name, code] of [
    ["compressed", "PRIVACYAI_CODEX_COMPRESSED_RESPONSE"],
    ["malformed", "PRIVACYAI_CODEX_INVALID_RESPONSE"],
    ["binary", "PRIVACYAI_CODEX_UNSUPPORTED_RESPONSE_TYPE"]
  ]) {
    const response = await fetch(`${gateway.baseURL}/responses?case=${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleRequest())
    });
    assert.equal(response.status, 502, name);
    const body = await response.json();
    assert.equal(body.error.code, code, name);
  }
});

test("gateway chooses ChatGPT or API upstream and strips forwarding headers", async t => {
  const seen = [];
  const api = await startServer(async (request, response) => {
    seen.push({ target: "api", path: request.url, headers: request.headers });
    await readRequestJson(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "api" }));
  });
  const chatgpt = await startServer(async (request, response) => {
    seen.push({ target: "chatgpt", path: request.url, headers: request.headers });
    await readRequestJson(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ text: "chatgpt" }));
  });
  t.after(() => api.close());
  t.after(() => chatgpt.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: await createTestTempDir("privacyai-codex-routing-"),
    apiUpstream: `http://127.0.0.1:${api.port}/v1`,
    chatgptUpstream: `http://127.0.0.1:${chatgpt.port}/backend-api/codex`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const common = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      "x-forwarded-host": "private.example.test",
      cookie: `session=${PRIVATE_KEY}`,
      "x-private-note": PRIVATE_EMAIL
    },
    body: JSON.stringify(sampleRequest())
  };
  const apiResponse = await fetch(`${gateway.baseURL}/responses`, common);
  assert.equal((await apiResponse.json()).text, "api");
  const chatResponse = await fetch(`${gateway.baseURL}/responses`, {
    ...common,
    headers: { ...common.headers, "chatgpt-account-id": "account-test" }
  });
  assert.equal((await chatResponse.json()).text, "chatgpt");

  assert.deepEqual(seen.map(entry => entry.target), ["api", "chatgpt"]);
  assert.equal(seen[0].path, "/v1/responses");
  assert.equal(seen[1].path, "/backend-api/codex/responses");
  for (const entry of seen) {
    assert.equal(entry.headers["x-forwarded-for"], undefined);
    assert.equal(entry.headers["x-forwarded-host"], undefined);
    assert.equal(entry.headers.cookie, undefined);
    assert.equal(entry.headers["x-private-note"], undefined);
    assert.equal(entry.headers["accept-encoding"], "identity");
  }
});

test("Codex sanitization batches independent model-visible artifacts", async () => {
  const seen = [];
  const body = {
    model: "gpt-5.4-mini",
    instructions: "INSTRUCTIONS_ARTIFACT",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "MESSAGE_ARTIFACT" }]
      },
      {
        type: "function_call_output",
        call_id: "call-artifact-isolation",
        output: "TOOL_OUTPUT_ARTIFACT"
      }
    ],
    stream: true,
    client_metadata: { session_id: "artifact-isolation" }
  };

  const result = await sanitizeCodexRequestBody(body, {
    maxContextChars: 2048,
    sanitizer: async text => {
      seen.push(text);
      return { sanitizedPrompt: text, sessionMap: {} };
    }
  });

  assert.deepEqual(result.body, body);
  assert.equal(seen.length, 1);
  assert.equal(
    ["INSTRUCTIONS_ARTIFACT", "MESSAGE_ARTIFACT", "TOOL_OUTPUT_ARTIFACT"]
      .every(marker => seen[0].includes(marker)),
    true
  );
  assert.equal(result.cacheWrites.length, 3);
  assert.equal(new Set(result.cacheWrites.map(([key]) => key)).size, 3);
  assert.equal(result.metrics.modelCallCount, 1);
});

test("Codex second-turn tool output recovers conservative classifier spans around known values", async () => {
  const secondPrivate = "bob.private@example.test";
  const originalOutput = `Known ${PRIVATE_EMAIL}; new ${secondPrivate}`;
  const body = sampleRequest();
  body.instructions = "safe instructions";
  body.input = [{
    type: "function_call_output",
    call_id: "call-second-turn-boundary",
    output: originalOutput
  }];
  body.tools = [];
  body.prompt_cache_key = "safe-second-turn-cache";
  body.client_metadata = { session_id: "second-turn-boundary" };

  const result = await sanitizeCodexRequestBody(body, {
    sessionMap: { "[EMAIL_1]": PRIVATE_EMAIL },
    sanitizer: async text => {
      const token = text.match(/__PRIVACYAI_BOUNDARY_\d+__/)?.[0];
      assert.ok(token, "the known first-turn value should be shielded");
      const mixedSpan = `${token}; new ${secondPrivate}`;
      assert.equal(text.includes(mixedSpan), true);
      return {
        sanitizedPrompt: text.replace(mixedSpan, "[PRIVATE_VALUE_1]"),
        sessionMap: { "[PRIVATE_VALUE_1]": mixedSpan }
      };
    }
  });

  assert.equal(result.body.input[0].output, "Known [PRIVATE_VALUE_1]");
  assert.deepEqual(result.sessionMapAdditions, {
    "[PRIVATE_VALUE_1]": `${PRIVATE_EMAIL}; new ${secondPrivate}`
  });
  assert.equal(
    restoreValue(result.body.input[0].output, {
      "[EMAIL_1]": PRIVATE_EMAIL,
      ...result.sessionMapAdditions
    }),
    originalOutput
  );
});

test("Codex leak verification ignores protocol booleans while protecting matching text", async () => {
  const body = sampleRequest();
  body.instructions = "safe instructions";
  body.input = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "the private text is false" }]
  }];
  body.tools = [];
  body.prompt_cache_key = "safe-cache-key";

  const result = await sanitizeCodexRequestBody(body, {
    sanitizer: async text => {
      const found = text.includes("false");
      return {
        sanitizedPrompt: found ? text.split("false").join("[PRIVATE_VALUE_1]") : text,
        sessionMap: found ? { "[PRIVATE_VALUE_1]": "false" } : {}
      };
    }
  });

  assert.equal(result.body.store, false);
  assert.equal(result.body.parallel_tool_calls, false);
  assert.equal(result.body.input[0].content[0].text.includes("false"), false);
  assert.equal(result.body.input[0].content[0].text.includes("[PRIVATE_VALUE_1]"), true);
});

test("large Codex artifacts are safely chunked, batched, and reconstructed", async () => {
  const secret = "boundary.secret@example.test";
  const body = {
    model: "gpt-5.4-mini",
    instructions: "x".repeat(1260) + secret + "y".repeat(1800),
    input: [],
    stream: true,
    client_metadata: { session_id: "bounded-artifact" }
  };
  const batchSizes = [];
  const result = await sanitizeCodexRequestBody(body, {
    maxContextChars: 1400,
    sanitizer: async text => {
      batchSizes.push(text.length);
      const found = text.includes(secret);
      return {
        sanitizedPrompt: found ? text.replaceAll(secret, "[EMAIL_1]") : text,
        sessionMap: found ? { "[EMAIL_1]": secret } : {}
      };
    }
  });

  assert.equal(batchSizes.length > 1, true);
  assert.equal(batchSizes.every(size => size <= 1400), true);
  assert.equal(result.metrics.modelCallCount, batchSizes.length);
  assert.equal(result.body.instructions.includes(secret), false);
  assert.equal(result.body.instructions.includes("[EMAIL_1]"), true);
  assert.deepEqual(result.sessionMapAdditions, { "[EMAIL_1]": secret });
  assert.deepEqual(result.body.input, []);
});

test("request item cache survives session-map growth", async () => {
  const cache = new Map();
  let calls = 0;
  const classify = async text => {
    calls += 1;
    return deterministicSanitizer(text);
  };

  const first = await sanitizeCodexRequestBody(sampleRequest(), {
    cache,
    sanitizer: classify
  });
  const firstCalls = calls;
  for (const [key, value] of first.cacheWrites) cache.set(key, value);
  const completeMap = { ...first.sessionMapAdditions };

  const second = await sanitizeCodexRequestBody(sampleRequest(), {
    cache,
    sessionMap: completeMap,
    sanitizer: classify
  });
  for (const [key, value] of second.cacheWrites) cache.set(key, value);
  assert.equal(calls, firstCalls, "map growth must not rescan unchanged model-visible items");
  assert.deepEqual(second.body, first.body);

  const third = await sanitizeCodexRequestBody(sampleRequest(), {
    cache,
    sessionMap: completeMap,
    sanitizer: async () => {
      throw new Error("stable-map cache entries must not reach the classifier");
    }
  });
  assert.equal(third.cacheWrites.length, 0);
  assert.deepEqual(third.body, second.body);
});

test("Codex child and fork metadata resolve parent session mappings", () => {
  const context = codexSessionContext({
    client_metadata: {
      thread_id: "child-thread",
      parent_thread_id: "parent-thread",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "child-thread",
        forked_from_thread_id: "fork-source"
      })
    }
  });
  assert.equal(context.sessionKey, "codex-provider:child-thread");
  assert.deepEqual(
    new Set(context.parentSessionKeys),
    new Set(["codex-provider:parent-thread", "codex-provider:fork-source"])
  );

  const headerContext = codexSessionContext(
    {},
    undefined,
    {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "header-thread",
        parent_thread_id: "header-parent"
      })
    }
  );
  assert.equal(headerContext.sessionKey, "codex-provider:header-thread");
  assert.deepEqual(headerContext.parentSessionKeys, ["codex-provider:header-parent"]);

  assert.throws(
    () => codexSessionContext({ client_metadata: {} }),
    error => error?.code === "PRIVACYAI_CODEX_SESSION_ID_REQUIRED"
  );
});

test("gateway inherits parent mappings and rejects ambiguous child collisions", async t => {
  let upstreamRequests = 0;
  const upstream = await startServer(async (_request, response) => {
    upstreamRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      sse({ type: "response.output_text.delta", item_id: "msg", delta: "Hello [EMAIL_1]" }),
      sse({ type: "response.completed", response: { id: "r", usage: null } })
    ].join(""));
  });
  t.after(() => upstream.close());

  const maps = new Map([
    ["codex-provider:parent", { sessionMap: { "[EMAIL_1]": PRIVATE_EMAIL } }]
  ]);
  const vault = {
    async load(key) {
      return maps.get(key);
    },
    async save(key, sessionMap) {
      maps.set(key, { sessionMap });
    }
  };
  const gateway = await startCodexProviderGateway({
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    vault,
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const childBody = sampleRequest();
  childBody.instructions = "Continue with [EMAIL_1]";
  childBody.input = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Use [EMAIL_1]" }]
  }];
  childBody.tools = [];
  childBody.prompt_cache_key = "child-cache";
  childBody.client_metadata = {
    thread_id: "child",
    parent_thread_id: "parent",
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "child",
      parent_thread_id: "parent",
      forked_from_thread_id: "missing-parent"
    })
  };
  const inherited = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(childBody)
  });
  assert.equal(inherited.status, 200);
  const inheritedEvents = parseSse(await inherited.text());
  assert.equal(inheritedEvents[0].delta, `Hello ${PRIVATE_EMAIL}`);
  assert.deepEqual(maps.get("codex-provider:child").sessionMap, { "[EMAIL_1]": PRIVATE_EMAIL });

  maps.set("codex-provider:conflicted-child", {
    sessionMap: { "[EMAIL_1]": "different@example.test" }
  });
  const conflictedBody = structuredClone(childBody);
  conflictedBody.client_metadata.thread_id = "conflicted-child";
  conflictedBody.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    thread_id: "conflicted-child",
    parent_thread_id: "parent"
  });
  const conflicted = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(conflictedBody)
  });
  assert.equal(conflicted.status, 422);
  assert.equal(upstreamRequests, 1);

  maps.set("codex-provider:alias-heavy-child", {
    sessionMap: Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`PRIVATE_ALIAS_${index + 1}`, PRIVATE_EMAIL])
    )
  });
  const aliasHeavyBody = structuredClone(childBody);
  aliasHeavyBody.client_metadata.thread_id = "alias-heavy-child";
  aliasHeavyBody.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    thread_id: "alias-heavy-child",
    parent_thread_id: "parent"
  });
  const aliasHeavy = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(aliasHeavyBody)
  });
  assert.equal(aliasHeavy.status, 422);
  assert.equal(upstreamRequests, 1);
});

test("gateway reuses persisted thread verification after restart and invalidates changed policy/content", async t => {
  const root = await createTestTempDir("privacyai-gateway-persistent-cache-");
  const verificationDbPath = join(root, "context.sqlite3");
  let upstreamRequests = 0;
  const upstream = await startServer(async (request, response) => {
    await readRequestJson(request);
    upstreamRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse({ type: "response.output_text.delta", item_id: "persisted", delta: "ok" }) +
      sse({ type: "response.completed", response: { id: "persisted", usage: null } }) +
      "data: [DONE]\n\n"
    );
  });
  t.after(() => upstream.close());

  const body = sampleRequest();
  let sanitizerCalls = 0;
  const sanitizer = async text => {
    sanitizerCalls += 1;
    return deterministicSanitizer(text);
  };
  const common = {
    baseDir: root,
    verificationDbPath,
    apiUpstream: "http://127.0.0.1:" + upstream.port + "/v1",
    allowInsecureTestUpstream: true,
    policyFingerprint: "persistent-policy-v1"
  };

  const first = await startCodexProviderGateway({ ...common, sanitizer });
  let second;
  let third;
  t.after(async () => {
    await Promise.allSettled([first.close(), second?.close(), third?.close()]);
  });
  let response = await fetch(first.baseURL + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(sanitizerCalls, 1, "uncached artifacts should be packed into one classifier request");
  await first.close();

  const cachedOnly = async () => {
    throw new Error("unchanged resumed thread must use persisted verification");
  };
  second = await startCodexProviderGateway({ ...common, sanitizer: cachedOnly });
  response = await fetch(second.baseURL + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, await response.text());

  const changed = structuredClone(body);
  changed.instructions += " changed";
  response = await fetch(second.baseURL + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changed)
  });
  assert.equal(response.status, 502);
  await second.close();

  third = await startCodexProviderGateway({
    ...common,
    policyFingerprint: "persistent-policy-v2",
    sanitizer: cachedOnly
  });
  response = await fetch(third.baseURL + "/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 502);
  await third.close();
  assert.equal(upstreamRequests, 2);
});

test("gateway maintenance pruning uses shared request state", async t => {
  const records = new Map();
  const threads = new Map();
  let prunes = 0;
  const verificationStore = {
    loadThread(key) {
      return threads.get(key) || { parentSessionKeys: [], sessionMap: {}, policyFingerprint: null };
    },
    saveThread(key, value) {
      threads.set(key, value);
    },
    getVerification(key, policyFingerprint) {
      const value = records.get(key);
      return value?.policyFingerprint === policyFingerprint ? value : undefined;
    },
    putVerification(value) {
      records.set(value.cacheKey, value);
    },
    recordThreadItem() {},
    prune() {
      prunes += 1;
    },
    close() {}
  };
  const upstream = await startServer(async (request, response) => {
    await readRequestJson(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse({ type: "response.output_text.delta", item_id: "maintenance", delta: "ok" }) +
      sse({ type: "response.completed", response: { id: "maintenance", usage: null } }) +
      "data: [DONE]\n\n"
    );
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    verificationStore,
    baseDir: await createTestTempDir("privacyai-gateway-maintenance-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const body = {
    model: "gpt-5.4-mini",
    instructions: "public instructions",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "public request" }]
    }],
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", summary: "auto" },
    store: false,
    stream: true,
    include: [],
    client_metadata: { session_id: "maintenance-session", thread_id: "maintenance-thread" }
  };
  for (let index = 0; index < 100; index += 1) {
    const response = await fetch(`${gateway.baseURL}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200, `request ${index + 1}`);
    await response.text();
  }
  assert.equal(prunes, 1);
});

test("Codex provider args force loopback Responses transport and disable unsupported provider-hosted tools", () => {
  const args = buildCodexProviderArgs("http://127.0.0.1:12345/nonce");
  assert.equal(args.includes('model_provider="privacyai"'), true);
  const provider = args.find(value => value.startsWith("model_providers.privacyai="));
  assert.match(provider, /requires_openai_auth=true/);
  assert.match(provider, /supports_websockets=false/);
  assert.match(provider, /request_max_retries=0/);
  assert.match(provider, /stream_max_retries=0/);
  assert.equal(args.includes('web_search="disabled"'), true);
  for (const feature of ["enable_request_compression", "responses_websockets", "apps", "image_generation"]) {
    const index = args.indexOf(feature);
    assert.equal(index > 0 && args[index - 1] === "--disable", true, feature);
  }
  assert.throws(() => buildCodexProviderArgs("http://localhost:1234/x"), /literal IPv4 loopback/);
});

test("Codex gateway always resolves bounded upstream deadlines", () => {
  assert.deepEqual(resolveCodexGatewayTimeouts(), {
    responseHeadersMs: 30000,
    responseIdleMs: 60000
  });
  assert.deepEqual(resolveCodexGatewayTimeouts({
    upstreamTimeoutMs: 125,
    upstreamIdleTimeoutMs: 250
  }), {
    responseHeadersMs: 125,
    responseIdleMs: 250
  });
  assert.throws(() => resolveCodexGatewayTimeouts({ upstreamTimeoutMs: 0 }), /between 1/);
});

test("Codex privacy mode defaults to gateway and removes only wrapper-owned flags", () => {
  assert.deepEqual(parseCodexPrivacyMode(["exec", "hello"]), { mode: "gateway", args: ["exec", "hello"] });
  assert.deepEqual(parseCodexPrivacyMode(["--privacy-strict", "exec"]), { mode: "strict", args: ["exec"] });
  assert.deepEqual(
    parseCodexPrivacyMode(["exec", "--", "--privacy-strict"]),
    { mode: "gateway", args: ["exec", "--", "--privacy-strict"] }
  );
  assert.throws(
    () => parseCodexPrivacyMode(["--privacy-strict", "--privacy-gateway"]),
    /Choose only one/
  );
});

function sampleRequest() {
  return {
    model: "gpt-5.4-mini",
    instructions: `Help ${PRIVATE_EMAIL}`,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Contact ${PRIVATE_EMAIL}` }]
      },
      {
        type: "function_call_output",
        call_id: "call-unchanged",
        output: `owner=${PRIVATE_EMAIL}`
      },
      {
        type: "function_call",
        call_id: "call-2",
        name: "shell_command",
        arguments: JSON.stringify({ command: `printf '%s' '${PRIVATE_KEY}'` })
      }
    ],
    tools: [
      {
        type: "function",
        name: "shell_command",
        description: `Run a command for ${PRIVATE_EMAIL}`,
        strict: false,
        parameters: { type: "object", properties: { command: { type: "string" } } }
      }
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", summary: "auto" },
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: `cache:${PRIVATE_EMAIL}`,
    client_metadata: {
      session_id: "session-123",
      thread_id: "thread-123",
      turn_id: "turn-123",
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "session-123",
        thread_id: "thread-123",
        turn_id: "turn-123",
        request_kind: "turn",
        workspaces: { private: { associated_remote_urls: { origin: `https://${PRIVATE_EMAIL}/repo` } } },
        extra: { private_email: PRIVATE_EMAIL }
      })
    }
  };
}

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .flatMap(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:")))
    .map(line => line.slice(5).trim())
    .filter(value => value && value !== "[DONE]")
    .map(value => JSON.parse(value));
}

async function startServer(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error.stack || error.message);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    port: address.port,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


test("custom sanitizers without stable identity never reuse persisted verification across restart", async t => {
  const root = await createTestTempDir("privacyai-gateway-ephemeral-policy-");
  const verificationDbPath = join(root, "context.sqlite3");
  const upstream = await startServer(async (request, response) => {
    await readRequestJson(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      sse({ type: "response.output_text.delta", item_id: "ephemeral", delta: "ok" }) +
      sse({ type: "response.completed", response: { id: "ephemeral", usage: null } }) +
      "data: [DONE]\n\n"
    );
  });
  t.after(() => upstream.close());

  let firstCalls = 0;
  let secondCalls = 0;
  function createClosure(mode) {
    return async text => {
      if (mode === "first") {
        firstCalls += 1;
        return deterministicSanitizer(text);
      }
      secondCalls += 1;
      throw new Error("replacement policy must classify again");
    };
  }
  const common = {
    baseDir: root,
    verificationDbPath,
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  };

  const first = await startCodexProviderGateway({
    ...common,
    sanitizer: createClosure("first")
  });
  let response = await fetch(`${first.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(firstCalls, 1, "uncached artifacts should be packed into one classifier request");
  await first.close();

  const second = await startCodexProviderGateway({
    ...common,
    sanitizer: createClosure("second")
  });
  t.after(() => second.close());
  response = await fetch(`${second.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 502);
  assert.equal(secondCalls, 1);
});


test("deterministic privacy-boundary failures are non-retryable HTTP 422 responses", async t => {
  const diagnostics = [];
  const gateway = await startCodexProviderGateway({
    sanitizer: async () => {
      const error = new Error("local classifier returned an invalid exact span");
      error.code = "PRIVACYAI_INVALID_CLASSIFIER_SPAN";
      throw error;
    },
    onGatewayError: diagnostic => diagnostics.push(diagnostic),
    baseDir: await createTestTempDir("privacyai-codex-boundary-status-"),
    apiUpstream: "http://127.0.0.1:9/v1",
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "PRIVACYAI_INVALID_CLASSIFIER_SPAN");
  assertDiagnostic(diagnostics[0], "PRIVACYAI_INVALID_CLASSIFIER_SPAN", "privacy_boundary");
});


test("gateway diagnostics expose only allowlisted structured fields", async t => {
  let upstreamRequests = 0;
  const diagnostics = [];
  const upstream = await startServer((_request, response) => {
    upstreamRequests += 1;
    response.end();
  });
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: async () => {
      const error = new Error(`private prompt ${PRIVATE_EMAIL} at /home/private/workspace`);
      error.name = PRIVATE_EMAIL;
      error.code = `PRIVACYAI_${PRIVATE_KEY}`;
      throw error;
    },
    onGatewayError(diagnostic) {
      diagnostics.push(diagnostic);
      throw new Error("diagnostic sink failure must remain observational");
    },
    baseDir: await createTestTempDir("privacyai-codex-safe-diagnostic-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "PRIVACYAI_CODEX_GATEWAY_FAILURE");
  assertDiagnostic(diagnostics[0], "PRIVACYAI_CODEX_GATEWAY_FAILURE", "gateway");
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(PRIVATE_EMAIL), false);
  assert.equal(serialized.includes(PRIVATE_KEY), false);
  assert.equal(serialized.includes("/home/private"), false);
  assert.equal(upstreamRequests, 0);
});

test("gateway categorizes local provider failures without exposing provider details", async t => {
  const diagnostics = [];
  const gateway = await startCodexProviderGateway({
    sanitizer: async () => {
      const error = new Error(`Provider returned HTTP 503 for ${PRIVATE_EMAIL}`);
      error.name = "ProviderError";
      error.details = PRIVATE_KEY;
      throw error;
    },
    onGatewayError: diagnostic => diagnostics.push(diagnostic),
    baseDir: await createTestTempDir("privacyai-codex-provider-diagnostic-"),
    apiUpstream: "http://127.0.0.1:9/v1",
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PRIVACYAI_LOCAL_MODEL_FAILURE");
  assertDiagnostic(diagnostics[0], "PRIVACYAI_LOCAL_MODEL_FAILURE", "local_model");
  assert.equal(JSON.stringify(diagnostics).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(diagnostics).includes(PRIVATE_KEY), false);
});

test("stream failures emit exactly one structured gateway diagnostic", async t => {
  const diagnostics = [];
  const upstream = await startServer(async (request, response) => {
    await readRequestJson(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.output_text.delta", item_id: "msg", delta: "ok" }));
    response.end("data: not-json\n\n");
  });
  t.after(() => upstream.close());
  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    onGatewayError: diagnostic => diagnostics.push(diagnostic),
    baseDir: await createTestTempDir("privacyai-codex-single-diagnostic-"),
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.baseURL}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sampleRequest())
  });
  await response.text().catch(() => "");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(diagnostics.length, 1);
  assertDiagnostic(diagnostics[0], "PRIVACYAI_CODEX_INVALID_SSE", "upstream", "sse");
});

function assertDiagnostic(diagnostic, code, category, phase = "request") {
  assert.equal(diagnostic.code, code);
  assert.equal(diagnostic.category, category);
  assert.equal(diagnostic.phase, phase);
  assert.match(diagnostic.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(diagnostic.networkCode, "NONE");
  assert.equal(diagnostic.retryCount, 0);
  assert.equal(diagnostic.downstreamClosed, false);
  assert.ok(["responses", "gateway"].includes(diagnostic.route));
}
