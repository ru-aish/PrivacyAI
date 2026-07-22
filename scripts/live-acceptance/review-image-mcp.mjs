#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const imagePath = process.env.PRIVACYAI_REVIEW_IMAGE;
if (!imagePath) {
  process.stderr.write("PRIVACYAI_REVIEW_IMAGE is required.\n");
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  const { id, method, params } = request;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "privacyai-live-review-image", version: "1.0.0" }
    });
  } else if (method === "ping") {
    result(id, {});
  } else if (method === "tools/list") {
    result(id, {
      tools: [{
        name: "read_privacyai_review_instructions",
        description: "Read the fixed PrivacyAI live release review instruction image exactly once before reviewing the selected pull requests.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }]
    });
  } else if (method === "tools/call") {
    if (params?.name !== "read_privacyai_review_instructions") {
      failure(id, -32602, "Unknown tool.");
      continue;
    }
    if (params?.arguments && Object.keys(params.arguments).length !== 0) {
      failure(id, -32602, "This tool accepts an empty object only.");
      continue;
    }
    const data = (await readFile(imagePath)).toString("base64");
    result(id, {
      content: [
        {
          type: "text",
          text: "Read this instruction image completely. Then read LIVE_REVIEW_SCOPE.md and follow the image exactly."
        },
        { type: "image", data, mimeType: "image/png" }
      ]
    });
  } else if (id != null) {
    failure(id, -32601, "Method not found.");
  }
}
