#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import readline from "node:readline";

const logPath = process.env.PRIVACYAI_MCP_TEST_LOG;
const privateResult = process.env.PRIVACYAI_MCP_PRIVATE_RESULT || "mcp-private-result";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.method === "notifications/initialized") continue;
  if (message.id == null) continue;

  try {
    const result = await handle(message.method, message.params || {});
    write({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: error?.message || "fixture failure" }
    });
  }
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "privacyai-test-mcp", version: "1.0.0" }
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: "echo_private",
            description: "Echo a locally restored test value and return another fake private value.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false
            },
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false
            }
          }
        ]
      };
    case "tools/call": {
      if (params.name !== "echo_private") throw new Error("unknown fixture tool");
      const message = String(params.arguments?.message || "");
      if (logPath) {
        await appendFile(logPath, `${JSON.stringify({ message })}\n`, { mode: 0o600 });
      }
      return {
        content: [
          {
            type: "text",
            text: `received=${message}; result=${privateResult}`
          }
        ],
        structuredContent: { received: message, result: privateResult },
        isError: false
      };
    }
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new Error(`unsupported method: ${method}`);
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
