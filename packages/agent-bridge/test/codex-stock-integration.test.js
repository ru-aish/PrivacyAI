import { createTestTempDir } from "./test-temp-dir.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexProviderArgs,
  resolveExecutable,
  startCodexProviderGateway
} from "../src/index.js";

const PRIVATE_EMAIL = "stock.gateway.private@example.test";
const PLACEHOLDER = "[EMAIL_1]";

test("installed stock Codex executes its native command through the provider gateway", { timeout: 60_000 }, async t => {
  const codex = await resolveExecutable("codex");
  if (!codex) return t.skip("Codex is not installed");

  const workspace = await createTestTempDir("privacyai-stock-codex-workspace-");
  const codexHome = await createTestTempDir("privacyai-stock-codex-home-");
  const vaultDir = await createTestTempDir("privacyai-stock-codex-vault-");
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(codexHome, { recursive: true, force: true }),
    rm(vaultDir, { recursive: true, force: true })
  ]));
  const captured = [];
  let turn = 0;

  const upstream = await startServer(async (request, response) => {
    if (request.method === "GET" && request.url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }

    const body = await readRequestJson(request);
    captured.push(body);
    assert.equal(JSON.stringify(body).includes(PRIVATE_EMAIL), false);
    turn += 1;

    if (turn === 1) {
      const toolNames = new Set(body.tools.map(tool => tool.name).filter(Boolean));
      const command = `printf '%s' '${PLACEHOLDER}' > gateway-output.txt`;
      let name;
      let args;
      if (toolNames.has("exec_command")) {
        name = "exec_command";
        args = { cmd: command, yield_time_ms: 1000, max_output_chars: 2000 };
      } else if (toolNames.has("shell_command")) {
        name = "shell_command";
        args = { command, workdir: workspace, timeout_ms: 10_000 };
      } else {
        throw new Error(`No supported native command tool in: ${[...toolNames].join(", ")}`);
      }
      writeSse(response, [
        responseCreated("resp-command"),
        functionCall("call-command", name, args),
        responseCompleted("resp-command")
      ]);
      return;
    }

    const toolOutput = body.input.find(item => item.type === "function_call_output");
    assert.ok(toolOutput, "Codex should send the native command result back to the provider");
    writeSse(response, [
      responseCreated("resp-final"),
      assistantMessage("msg-final", `completed for ${PLACEHOLDER}`),
      responseCompleted("resp-final")
    ]);
  });
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: async text => ({
      sanitizedPrompt: text.replaceAll(PRIVATE_EMAIL, PLACEHOLDER),
      sessionMap: text.includes(PRIVATE_EMAIL) ? { [PLACEHOLDER]: PRIVATE_EMAIL } : {}
    }),
    baseDir: vaultDir,
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const args = [
    ...buildCodexProviderArgs(gateway.baseURL),
    "-m",
    "gpt-5.4-mini",
    "-a",
    "never",
    "-s",
    "workspace-write",
    "exec",
    "--skip-git-repo-check",
    `Create gateway-output.txt containing exactly ${PRIVATE_EMAIL}, then finish.`
  ];
  const result = await run(codex, args, {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "dummy-local-test-key",
      NO_COLOR: "1"
    }
  });

  assert.equal(result.code, 0, `Codex failed:\n${result.stderr}\n${result.stdout}`);
  await access(join(workspace, "gateway-output.txt"));
  assert.equal(await readFile(join(workspace, "gateway-output.txt"), "utf8"), PRIVATE_EMAIL);
  assert.equal(result.stdout.includes(PRIVATE_EMAIL) || result.stderr.includes(PRIVATE_EMAIL), true);
  assert.equal(captured.length >= 2, true);
  assert.equal(captured.every(body => !JSON.stringify(body).includes(PRIVATE_EMAIL)), true);
});

test("installed stock Codex GPT-5.6 Luna receives hosted web and image tools through the gateway", { timeout: 60_000 }, async t => {
  const codex = await resolveExecutable("codex");
  if (!codex) return t.skip("Codex is not installed");

  const workspace = await createTestTempDir("privacyai-stock-codex-hosted-workspace-");
  const codexHome = await createTestTempDir("privacyai-stock-codex-hosted-home-");
  const vaultDir = await createTestTempDir("privacyai-stock-codex-hosted-vault-");
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(codexHome, { recursive: true, force: true }),
    rm(vaultDir, { recursive: true, force: true })
  ]));
  let captured;

  const upstream = await startServer(async (request, response) => {
    if (request.method === "GET" && request.url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    captured = await readRequestJson(request);
    writeSse(response, [
      responseCreated("resp-hosted-tools"),
      assistantMessage("msg-hosted-tools", "HOSTED_TOOLS_OK"),
      responseCompleted("resp-hosted-tools")
    ]);
  });
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    hostedToolPolicy: { webSearch: true, imageGeneration: true },
    baseDir: vaultDir,
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const args = [
    ...buildCodexProviderArgs(gateway.baseURL),
    "--search",
    "--enable",
    "image_generation",
    "-m",
    "gpt-5.6-luna",
    "-a",
    "never",
    "-s",
    "read-only",
    "exec",
    "--skip-git-repo-check",
    "Reply with exactly HOSTED_TOOLS_OK and do not call tools."
  ];
  const result = await run(codex, args, {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "dummy-local-test-key",
      NO_COLOR: "1"
    }
  });

  assert.equal(result.code, 0, `Codex failed:\n${result.stderr}\n${result.stdout}`);
  assert.ok(captured, "Codex should send a GPT-5.6 Luna request through the provider gateway");
  const hostedTypes = captured.tools
    .map(tool => tool.type)
    .filter(type => type === "web_search" || type === "image_generation");
  assert.deepEqual(hostedTypes, ["web_search", "image_generation"]);
});

test("installed stock Codex preserves custom Lark grammar under a false-positive sanitizer", { timeout: 60_000 }, async t => {
  const codex = await resolveExecutable("codex");
  if (!codex) return t.skip("Codex is not installed");

  const workspace = await createTestTempDir("privacyai-stock-codex-grammar-workspace-");
  const codexHome = await createTestTempDir("privacyai-stock-codex-grammar-home-");
  const vaultDir = await createTestTempDir("privacyai-stock-codex-grammar-vault-");
  t.after(() => Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(codexHome, { recursive: true, force: true }),
    rm(vaultDir, { recursive: true, force: true })
  ]));
  const sanitizerInputs = [];
  let captured;

  const upstream = await startServer(async (request, response) => {
    if (request.method === "GET" && request.url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }

    captured = await readRequestJson(request);
    writeSse(response, [
      responseCreated("resp-grammar"),
      assistantMessage("msg-grammar", "TOOL_GRAMMAR_OK"),
      responseCompleted("resp-grammar")
    ]);
  });
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: async text => {
      sanitizerInputs.push(text);
      const found = /ai/i.test(text);
      return {
        sanitizedPrompt: found ? text.replace(/ai/gi, "[PRIVATE_VALUE_7]") : text,
        sessionMap: found ? { "[PRIVATE_VALUE_7]": "ai" } : {}
      };
    },
    baseDir: vaultDir,
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true
  });
  t.after(() => gateway.close());

  const args = [
    ...buildCodexProviderArgs(gateway.baseURL),
    "-m",
    "gpt-5.4-mini",
    "-a",
    "never",
    "-s",
    "read-only",
    "exec",
    "--skip-git-repo-check",
    "Reply with exactly TOOL_GRAMMAR_OK and do not call tools."
  ];
  const result = await run(codex, args, {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "dummy-local-test-key",
      NO_COLOR: "1"
    }
  });

  assert.equal(result.code, 0, `Codex failed:\n${result.stderr}\n${result.stdout}`);
  assert.ok(captured, "Codex should send one request through the provider gateway");
  const customTool = captured.tools.find(tool =>
    tool.type === "custom" && tool.format?.type === "grammar" && tool.format?.syntax === "lark"
  );
  assert.ok(customTool, "Codex should include its native custom Lark tool");
  const grammar = customTool.format.definition;
  assert.match(grammar, /start:\s*begin_patch hunk\+ end_patch/);
  assert.match(grammar, /begin_patch:\s*"\*\*\* Begin Patch" LF/);
  assert.doesNotMatch(grammar, /PRIVATE_VALUE_7/);
  assert.equal(
    sanitizerInputs.some(text => text.includes('begin_patch: "*** Begin Patch" LF')),
    false,
    "executable grammar must never enter the text sanitizer"
  );
});

function responseCreated(id) {
  return { type: "response.created", response: { id } };
}

function responseCompleted(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0
      }
    }
  };
}

function functionCall(callId, name, args) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function assistantMessage(id, text) {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id,
      content: [{ type: "output_text", text }]
    }
  };
}

function writeSse(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function startServer(handler) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
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

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({
        code: signal ? 128 : code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}
