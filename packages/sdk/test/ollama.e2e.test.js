import assert from "node:assert/strict";
import { PrivateAI } from "../src/index.js";

const baseURL = process.env.PRIVATE_AI_BASE_URL || "http://127.0.0.1:11434";
const model = process.env.PRIVATE_AI_MODEL || "qwen2.5:0.5b";

const client = new PrivateAI({
  apiKey: process.env.PRIVATE_AI_API_KEY || "ollama",
  baseURL,
  model,
  provider: "ollama",
  timeoutMs: Number(process.env.PRIVATE_AI_TIMEOUT_MS || 120000),
  loadEnv: false
});

const prompt = "local.e2e@example.com needs a one-line acknowledgement.";
const sanitized = await client.sanitize(prompt);

console.log(JSON.stringify({
  provider: { baseURL, model },
  originalText: sanitized.originalText,
  sanitizedText: sanitized.sanitizedText,
  sessionMap: sanitized.sessionMap,
  privacySource: sanitized.privacySource
}, null, 2));

assert.equal(sanitized.originalText, prompt);
assert.notEqual(sanitized.sanitizedText, prompt);
assert.ok(Object.keys(sanitized.sessionMap).length > 0);
assert.doesNotMatch(sanitized.sanitizedText, /local\.e2e@example\.com/);

if (sanitized.privacySource === "ai-sanitizer") {
  const result = await client.ask(prompt, {
    maxTokens: 128,
    temperature: 0
  });

  console.log(JSON.stringify({
    modelText: result.modelText,
    finalText: result.finalText
  }, null, 2));

  assert.ok(result.modelText.length > 0);
  assert.match(result.finalText, /local\.e2e@example\.com/);
}