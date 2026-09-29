import { createTestTempDir } from "./test-temp-dir.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";

import { SessionVault, writeClaudeSettings } from "../src/index.js";

const enabled = process.env.PRIVACYAI_CLAUDE_NATIVE_E2E === "1";
const claudePath = process.env.PRIVACYAI_CLAUDE_BIN || "claude";
const model = process.env.PRIVACYAI_CLAUDE_E2E_MODEL || "claude-haiku-4-5-20251001";

test(
  "installed Claude Code protects successful and failed MCP calls end to end",
  { skip: !enabled, timeout: 180000 },
  async () => {
    await runScenario({ failure: false });
    await runScenario({ failure: true });
  }
);

async function runScenario({ failure }) {
  const root = await createTestTempDir(`privacyai-claude-${failure ? "failure" : "success"}-`);
  const settingsPath = join(root, "settings.json");
  const mcpConfigPath = join(root, "mcp.json");
  const mcpScriptPath = join(root, "fake-mail-mcp.mjs");
  const receivedPath = join(root, "received.json");
  const vaultDir = join(root, "vault");
  const debugPath = join(root, "claude-debug.log");
  const sessionId = randomUUID();
  const safe = "contact1@example.com";
  const original = failure
    ? "native.claude.failure@example.test"
    : "native.claude.success@example.test";
  const provider = await startMockProvider({ safe });

  try {
    const settings = await writeClaudeSettings(settingsPath);
    delete settings.hooks.UserPromptSubmit;
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

    await new SessionVault({ baseDir: vaultDir }).save(sessionId, { [safe]: original });
    await writeFile(mcpScriptPath, fakeMcpSource(), { mode: 0o700 });
    await writeFile(
      mcpConfigPath,
      `${JSON.stringify({
        mcpServers: {
          "privacyai-test": {
            type: "stdio",
            command: process.execPath,
            args: [mcpScriptPath, receivedPath, failure ? "failure" : "success"]
          }
        }
      }, null, 2)}\n`,
      { mode: 0o600 }
    );

    const result = await runClaude({
      settingsPath,
      mcpConfigPath,
      vaultDir,
      debugPath,
      sessionId,
      providerURL: provider.url,
      safe
    });

    assert.equal(result.code, 0, result.stderr);
    const received = JSON.parse(await readFile(receivedPath, "utf8"));
    assert.equal(received.to, original);
    assert.equal(received.subject, "hi");
    assert.equal(received.body, "hi");

    assert.ok(provider.requests.length >= 1);
    const firstRequest = JSON.stringify(provider.requests[0]);
    assert.match(firstRequest, new RegExp(escapeRegExp(safe)));
    assert.doesNotMatch(firstRequest, new RegExp(escapeRegExp(original)));
    assert.match(result.stdout, /PreToolUse:mcp__privacyai-test__send_mail/);

    if (failure) {
      assert.equal(provider.requests.length, 1, "PostToolBatch must stop before another model request");
      assert.match(result.stdout, /failed or batched tool result still contained local private values/);
      assert.match(result.stdout, /"terminal_reason":"hook_stopped"/);
    } else {
      assert.equal(provider.requests.length, 2);
      const secondRequest = JSON.stringify(provider.requests[1]);
      assert.match(secondRequest, new RegExp(escapeRegExp(safe)));
      assert.doesNotMatch(secondRequest, new RegExp(escapeRegExp(original)));
      assert.match(result.stdout, /PostToolUse:mcp__privacyai-test__send_mail/);
      assert.match(result.stdout, /Fake mail recorded for contact1@example\.com/);
      assert.match(result.stdout, /"result":"DONE"/);
    }
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

function runClaude({
  settingsPath,
  mcpConfigPath,
  vaultDir,
  debugPath,
  sessionId,
  providerURL,
  safe
}) {
  const args = [
    "--settings",
    settingsPath,
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--session-id",
    sessionId,
    "--model",
    model,
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    "",
    "--max-turns",
    "3",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--debug-file",
    debugPath,
    "-p",
    `Use the privacyai-test send_mail MCP tool exactly once to send hi to ${safe}. Then say DONE.`
  ];
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: providerURL,
    ANTHROPIC_AUTH_TOKEN: "privacyai-local-e2e-token",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SIMPLE: "0",
    CLAUDE_CODE_SAFE_MODE: "0",
    PRIVACYAI_AGENT_FLAVOR: "claude",
    PRIVACYAI_AGENT_VAULT_DIR: vaultDir
  };

  return new Promise((resolve, reject) => {
    const child = spawn(claudePath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Installed Claude Code E2E timed out."));
    }, 120000);

    child.on("error", error => finish(error));
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("exit", code => finish(null, { code: code ?? 1, stdout, stderr }));
  });
}

async function startMockProvider({ safe }) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }

    const body = JSON.parse(raw);
    if (!Array.isArray(body.messages)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    requests.push(body);

    const secondTurn = hasToolResult(body.messages);
    const events = secondTurn
      ? textResponseEvents({ model: body.model })
      : toolResponseEvents({ model: body.model, safe });
    const payload = events.join("");
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
      "content-length": Buffer.byteLength(payload)
    });
    response.end(payload);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function hasToolResult(messages = []) {
  return messages.some(message =>
    Array.isArray(message?.content) && message.content.some(block => block?.type === "tool_result")
  );
}

function toolResponseEvents({ model, safe }) {
  return [
    event("message_start", messageStart("msg_privacyai_1", model)),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_privacyai_1",
        name: "mcp__privacyai-test__send_mail",
        input: {}
      }
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ to: safe, subject: "hi", body: "hi" })
      }
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 12 }
    }),
    event("message_stop", { type: "message_stop" })
  ];
}

function textResponseEvents({ model }) {
  return [
    event("message_start", messageStart("msg_privacyai_2", model)),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }),
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "DONE" }
    }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 }
    }),
    event("message_stop", { type: "message_stop" })
  ];
}

function messageStart(id, modelName) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: modelName,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1
      }
    }
  };
}

function event(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function fakeMcpSource() {
  return `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const [receivedPath, mode] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");

lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: mode === "failure" ? "fake-mail-failure" : "fake-mail", version: "1.0.0" }
      }
    });
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "send_mail",
          description: "Harmless local test tool that records arguments and sends no real email.",
          inputSchema: {
            type: "object",
            properties: {
              to: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" }
            },
            required: ["to", "subject", "body"],
            additionalProperties: false
          }
        }]
      }
    });
    return;
  }
  if (message.method === "tools/call") {
    const input = message.params?.arguments || {};
    writeFileSync(receivedPath, JSON.stringify(input, null, 2));
    const failure = mode === "failure";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: failure,
        content: [{
          type: "text",
          text: failure
            ? \`Controlled delivery failure for \${input.to}\`
            : \`Fake mail recorded for \${input.to}\`
        }]
      }
    });
    return;
  }
  if (message.id != null) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
