import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildCodexProviderArgs,
  resolveExecutable,
  startCodexProviderGateway
} from "../src/index.js";

const PRIVATE_ARG = "mcp.gateway.private@example.test";
const PRIVATE_RESULT = "sk-mcp-fake-result-987654321";
const ARG_PLACEHOLDER = "[EMAIL_1]";
const RESULT_PLACEHOLDER = "[API_KEY_1]";
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "privacy-mcp-server.js");

test("stock Codex keeps a normal stdio MCP while gateway restores args and sanitizes results", { timeout: 60_000 }, async t => {
  const codex = await resolveExecutable("codex");
  if (!codex) return t.skip("Codex is not installed");

  const root = await mkdtemp(join(tmpdir(), "privacyai-stock-codex-mcp-"));
  const workspace = join(root, "workspace");
  const codexHome = join(root, "codex-home");
  const vaultDir = join(root, "vault");
  const mcpLog = join(root, "mcp-calls.jsonl");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(codexHome, { recursive: true, mode: 0o700 })
  ]));

  await writeFile(
    join(codexHome, "config.toml"),
    [
      "[mcp_servers.privacy_test]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(FIXTURE)}]`,
      "enabled = true",
      "startup_timeout_sec = 10",
      "tool_timeout_sec = 10",
      'default_tools_approval_mode = "approve"',
      "",
      "[mcp_servers.privacy_test.env]",
      `PRIVACYAI_MCP_TEST_LOG = ${JSON.stringify(mcpLog)}`,
      `PRIVACYAI_MCP_PRIVATE_RESULT = ${JSON.stringify(PRIVATE_RESULT)}`,
      ""
    ].join("\n"),
    { mode: 0o600 }
  );

  const captured = [];
  const serverErrors = [];
  const gatewayErrors = [];
  let turn = 0;
  const upstream = await startServer(async (request, response) => {
    if (request.method === "GET" && request.url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    const body = await readRequestJson(request);
    captured.push(body);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes(PRIVATE_ARG), false);
    assert.equal(serialized.includes(PRIVATE_RESULT), false);
    turn += 1;

    if (turn === 1) {
      assert.equal(
        (body.tools || []).some(tool => tool?.type === "tool_search"),
        true,
        `Stock Codex should expose tool_search for deferred MCPs: ${summarizeTools(body.tools || [])}`
      );
      writeSse(response, [
        responseCreated("resp-mcp-search"),
        toolSearchCall("search-mcp", { query: "privacy_test echo_private MCP tool", limit: 8 }),
        responseCompleted("resp-mcp-search")
      ]);
      return;
    }

    if (turn === 2) {
      const searchableTools = body.input
        .filter(item => item.type === "tool_search_output")
        .flatMap(item => item.tools || []);
      const tool = findMcpTool(searchableTools, "echo_private");
      assert.ok(
        tool,
        `MCP tool not returned by native tool_search: ${summarizeTools(searchableTools)}`
      );
      writeSse(response, [
        responseCreated("resp-mcp-call"),
        functionCall("call-mcp", tool.name, { message: ARG_PLACEHOLDER }, tool.namespace),
        responseCompleted("resp-mcp-call")
      ]);
      return;
    }

    const output = body.input.find(item => item.type === "function_call_output" && item.call_id === "call-mcp");
    assert.ok(output, "Codex should return the native MCP result as a function output");
    assert.equal(JSON.stringify(output).includes(ARG_PLACEHOLDER), true);
    assert.equal(JSON.stringify(output).includes(RESULT_PLACEHOLDER), true);
    writeSse(response, [
      responseCreated("resp-mcp-final"),
      assistantMessage("msg-mcp-final", `MCP_DONE ${ARG_PLACEHOLDER} ${RESULT_PLACEHOLDER}`),
      responseCompleted("resp-mcp-final")
    ]);
  }, error => serverErrors.push(error?.message || String(error)));
  t.after(() => upstream.close());

  const gateway = await startCodexProviderGateway({
    sanitizer: deterministicSanitizer,
    baseDir: vaultDir,
    apiUpstream: `http://127.0.0.1:${upstream.port}/v1`,
    allowInsecureTestUpstream: true,
    onGatewayError: error => gatewayErrors.push(error)
  });
  t.after(() => gateway.close());

  const result = await run(codex, [
    ...buildCodexProviderArgs(gateway.baseURL),
    "-m",
    "gpt-5.4-mini",
    "-a",
    "never",
    "-s",
    "workspace-write",
    "exec",
    "--skip-git-repo-check",
    `Call the privacy_test MCP echo tool with exactly ${PRIVATE_ARG}, then finish.`
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "dummy-local-test-key",
      NO_COLOR: "1"
    }
  });

  assert.equal(
    result.code,
    0,
    `Codex MCP integration failed. Server errors: ${JSON.stringify(serverErrors)} Gateway errors: ${JSON.stringify(gatewayErrors)}\n${result.stderr}\n${result.stdout}`
  );
  const calls = (await readFile(mcpLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls, [{ message: PRIVATE_ARG }]);
  assert.equal(result.stdout.includes(PRIVATE_ARG), true);
  assert.equal(result.stdout.includes(PRIVATE_RESULT), true);
  assert.equal(captured.length >= 3, true);
  assert.equal(captured.every(body => !JSON.stringify(body).includes(PRIVATE_ARG)), true);
  assert.equal(captured.every(body => !JSON.stringify(body).includes(PRIVATE_RESULT)), true);
});

async function deterministicSanitizer(text) {
  let sanitizedPrompt = text;
  const sessionMap = {};
  if (sanitizedPrompt.includes(PRIVATE_ARG)) {
    sanitizedPrompt = sanitizedPrompt.replaceAll(PRIVATE_ARG, ARG_PLACEHOLDER);
    sessionMap[ARG_PLACEHOLDER] = PRIVATE_ARG;
  }
  if (sanitizedPrompt.includes(PRIVATE_RESULT)) {
    sanitizedPrompt = sanitizedPrompt.replaceAll(PRIVATE_RESULT, RESULT_PLACEHOLDER);
    sessionMap[RESULT_PLACEHOLDER] = PRIVATE_RESULT;
  }
  return { sanitizedPrompt, sessionMap };
}

function findMcpTool(tools, childName) {
  for (const tool of tools) {
    if (typeof tool?.name === "string" && tool.name.includes(childName)) {
      return { name: tool.name, namespace: tool.namespace };
    }
    if (Array.isArray(tool?.tools)) {
      const child = tool.tools.find(entry => entry?.name === childName || entry?.name?.includes(childName));
      if (child) return { name: child.name, namespace: tool.name };
    }
  }
  return null;
}

function summarizeTools(tools) {
  return JSON.stringify(tools.map(tool => ({
    type: tool?.type,
    name: tool?.name,
    children: Array.isArray(tool?.tools) ? tool.tools.map(child => child?.name) : []
  })));
}

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

function toolSearchCall(callId, argumentsValue) {
  return {
    type: "response.output_item.done",
    item: {
      type: "tool_search_call",
      call_id: callId,
      execution: "client",
      arguments: argumentsValue
    }
  };
}

function functionCall(callId, name, args, namespace) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      ...(namespace ? { namespace } : {}),
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
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function startServer(handler, onError = () => {}) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      onError(error);
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
