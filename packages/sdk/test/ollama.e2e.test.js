import assert from "node:assert/strict";
import { PrivateAI } from "../src/index.js";

const baseURL = process.env.PRIVATE_AI_BASE_URL || "http://127.0.0.1:11434";
const model = process.env.PRIVATE_AI_MODEL || "qwen3.5:2b";

const client = new PrivateAI({
  apiKey: process.env.PRIVATE_AI_API_KEY || "ollama",
  baseURL,
  model,
  provider: "ollama",
  timeoutMs: Number(process.env.PRIVATE_AI_TIMEOUT_MS || 120000),
  loadEnv: false
});

const result = await client.ask(
  "local.e2e@example.com",
  {
    maxTokens: 1024,
    temperature: 0,
    system: "Reply with exactly: [EMAIL_1]"
  }
);

console.log(JSON.stringify({
  provider: result.provider,
  sanitizedText: result.sanitizedText,
  modelText: result.modelText,
  finalText: result.finalText,
  detections: result.detections.map((detection) => ({
    type: detection.type,
    replacement: detection.replacement
  }))
}, null, 2));

assert.match(result.sanitizedText, /\[EMAIL_1\]/);
assert.doesNotMatch(result.sanitizedText, /local\.e2e@example\.com/);
assert.equal(result.sessionMap["[EMAIL_1]"], "local.e2e@example.com");
assert.equal(result.provider.model, model);
assert.ok(result.modelText.length > 0);
assert.match(result.modelText, /\[EMAIL_1\]/);
assert.match(result.finalText, /local\.e2e@example\.com/);
