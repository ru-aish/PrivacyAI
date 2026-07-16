import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexSseRestorer,
  buildCodexProviderArgs,
  codexSessionContext,
  parseCodexPrivacyMode,
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

test("Codex request transformation rejects unknown fields, media, unknown items, and leaked no-op mappings", async () => {
  await assert.rejects(
    sanitizeCodexRequestBody({ ...sampleRequest(), future_private_field: PRIVATE_EMAIL }, {
      sanitizer: deterministicSanitizer
    }),
    error => error?.code === "PRIVACYAI_CODEX_UNSUPPORTED_REQUEST_FIELD"
  );

  const media = sampleRequest();
  media.input = [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:x" }] }];
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
  custom.tools = [{
    type: "custom",
    name: "apply_patch",
    description: `Apply a patch for ${PRIVATE_EMAIL}`,
    format: {
      type: "grammar",
      syntax: "lark",
      definition: `start: "${PRIVATE_KEY}"`
    }
  }];
  const customResult = await sanitizeCodexRequestBody(custom, { sanitizer: deterministicSanitizer });
  assert.equal(JSON.stringify(customResult.body.tools).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(customResult.body.tools).includes(PRIVATE_KEY), false);
  assert.match(customResult.body.tools[0].description, /\[EMAIL_1\]/);
  assert.match(customResult.body.tools[0].format.definition, /\[API_KEY_1\]/);

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
  const root = await mkdtemp(join(tmpdir(), "privacyai-identifier-alias-"));
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

test("tool JSON Schema private keys are sanitized consistently and restored in function arguments", async () => {
  const body = sampleRequest();
  body.tools[0].parameters = {
    type: "object",
    properties: {
      [PRIVATE_EMAIL]: {
        type: "string",
        description: `value for ${PRIVATE_EMAIL}`
      },
      nested: {
        type: "object",
        properties: {
          [PRIVATE_KEY]: { type: "string" }
        },
        required: [PRIVATE_KEY]
      }
    },
    required: [PRIVATE_EMAIL]
  };

  const result = await sanitizeCodexRequestBody(body, { sanitizer: deterministicSanitizer });
  const schema = result.body.tools[0].parameters;
  assert.equal(Object.hasOwn(schema.properties, "[EMAIL_1]"), true);
  assert.deepEqual(schema.required, ["[EMAIL_1]"]);
  assert.equal(Object.hasOwn(schema.properties.nested.properties, "[API_KEY_1]"), true);
  assert.deepEqual(schema.properties.nested.required, ["[API_KEY_1]"]);
  assert.equal(JSON.stringify(schema).includes(PRIVATE_EMAIL), false);
  assert.equal(JSON.stringify(schema).includes(PRIVATE_KEY), false);

  const call = {
    type: "function_call",
    call_id: "schema-call",
    name: "shell_command",
    arguments: JSON.stringify({
      "[EMAIL_1]": "visible",
      nested: { "[API_KEY_1]": "value" }
    })
  };
  restoreResponseItem(call, sessionMap);
  assert.deepEqual(JSON.parse(call.arguments), {
    [PRIVATE_EMAIL]: "visible",
    nested: { [PRIVATE_KEY]: "value" }
  });
});

test("tool JSON Schema key collisions fail closed", async () => {
  const body = sampleRequest();
  body.tools[0].parameters = {
    type: "object",
    properties: {
      [PRIVATE_EMAIL]: { type: "string" },
      "[EMAIL_1]": { type: "string" }
    }
  };
  await assert.rejects(
    sanitizeCodexRequestBody(body, { sanitizer: deterministicSanitizer }),
    error => error?.code === "PRIVACYAI_TRANSFORM_KEY_COLLISION"
  );
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

  const vaultDir = await mkdtemp(join(tmpdir(), "privacyai-codex-gateway-test-"));
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-headerless-sse-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-headerless-invalid-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-disconnect-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-sanitizer-disconnect-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-compact-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-compact-success-")),
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
  assert.equal(blocked.status, 502);
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-fail-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-fail-sanitizer-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-models-")),
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
  assert.equal(invalid.status, 502);
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-models-invalid-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-upstream-fail-")),
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-routing-")),
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

test("Codex sanitization isolates independent model-visible artifacts", async () => {
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
  assert.equal(seen.length, 3);
  for (const text of seen) {
    const artifacts = [
      "INSTRUCTIONS_ARTIFACT",
      "MESSAGE_ARTIFACT",
      "TOOL_OUTPUT_ARTIFACT"
    ].filter(marker => text.includes(marker));
    assert.equal(artifacts.length, 1, `classifier batch mixed artifacts: ${artifacts.join(",")}`);
  }
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

test("oversized Codex artifacts are sanitized in bounded batches and reconstructed", async () => {
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
  assert.equal(conflicted.status, 502);
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
  assert.equal(aliasHeavy.status, 502);
  assert.equal(upstreamRequests, 1);
});

test("gateway reuses persisted thread verification after restart and invalidates changed policy/content", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-gateway-persistent-cache-"));
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
  assert.equal(sanitizerCalls > 1, true, "independent artifacts should be classified separately");
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

test("Codex provider args force loopback Responses transport and disable unsupported provider-hosted tools", () => {
  const args = buildCodexProviderArgs("http://127.0.0.1:12345/nonce");
  assert.equal(args.includes('model_provider="privacyai"'), true);
  const provider = args.find(value => value.startsWith("model_providers.privacyai="));
  assert.match(provider, /requires_openai_auth=true/);
  assert.match(provider, /supports_websockets=false/);
  assert.equal(args.includes('web_search="disabled"'), true);
  for (const feature of ["enable_request_compression", "responses_websockets", "apps", "image_generation"]) {
    const index = args.indexOf(feature);
    assert.equal(index > 0 && args[index - 1] === "--disable", true, feature);
  }
  assert.throws(() => buildCodexProviderArgs("http://localhost:1234/x"), /literal IPv4 loopback/);
});

test("Codex privacy mode defaults to gateway and removes only wrapper-owned flags", () => {
  assert.deepEqual(parseCodexPrivacyMode(["exec", "hello"]), { mode: "gateway", args: ["exec", "hello"] });
  assert.deepEqual(parseCodexPrivacyMode(["--privacy-strict", "exec"]), { mode: "strict", args: ["exec"] });
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
  const root = await mkdtemp(join(tmpdir(), "privacyai-gateway-ephemeral-policy-"));
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
  assert.equal(firstCalls > 1, true, "independent artifacts should be classified separately");
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-safe-diagnostic-")),
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
  assert.deepEqual(diagnostics, [{
    phase: "request",
    code: "PRIVACYAI_CODEX_GATEWAY_FAILURE",
    category: "gateway"
  }]);
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-provider-diagnostic-")),
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
  assert.deepEqual(diagnostics, [{
    phase: "request",
    code: "PRIVACYAI_LOCAL_MODEL_FAILURE",
    category: "local_model"
  }]);
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
    baseDir: await mkdtemp(join(tmpdir(), "privacyai-codex-single-diagnostic-")),
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
  assert.deepEqual(diagnostics[0], {
    phase: "request",
    code: "PRIVACYAI_CODEX_INVALID_SSE",
    category: "upstream"
  });
});
