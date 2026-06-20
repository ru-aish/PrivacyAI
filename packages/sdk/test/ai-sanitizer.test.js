import test from "node:test";
import assert from "node:assert/strict";
import { AiSanitizer } from "../src/ai-sanitizer.js";
import { createDetectorPipeline } from "../src/detectors/index.js";
import { redact } from "../src/redactor.js";

test("falls back to regex redaction when local AI JSON is invalid", async () => {
  const provider = {
    async chat() {
      return { text: "not json", raw: {}, provider: {} };
    }
  };

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  const result = await sanitizer.sanitize("Contact john.smith@example.com");

  const expected = redact("Contact john.smith@example.com", await createDetectorPipeline().detect("Contact john.smith@example.com"));
  assert.equal(result.sanitizedText, expected.sanitizedText);
  assert.equal(result.privacySource, "regex-fallback");
});

test("sanitizes conversation context before provider when provider is remote", async () => {
  const calls = [];
  const provider = {
    baseURL: "https://api.openai.com/v1",
    async chat(request) {
      calls.push(request);
      return {
        text: JSON.stringify({
          safe_prompt: "clean prompt",
          session_map: {}
        })
      };
    }
  };

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  
  const context = [
    { role: "user", text: "My email is alice@example.com" }
  ];
  
  await sanitizer.sanitize("Hello", { context });

  assert.equal(calls.length, 1);
  const contextMessage = calls[0].messages.find(m => m.content.includes("[CONTEXT]"));
  assert.ok(contextMessage);
  assert.match(contextMessage.content, /contact1@example.com/);
  assert.doesNotMatch(contextMessage.content, /alice@example.com/);
});

test("does not sanitize conversation context before provider when provider is local", async () => {
  const calls = [];
  const provider = {
    baseURL: "http://localhost:11434",
    async chat(request) {
      calls.push(request);
      return {
        text: JSON.stringify({
          safe_prompt: "clean prompt",
          session_map: {}
        })
      };
    }
  };

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  
  const context = [
    { role: "user", text: "My email is alice@example.com" }
  ];
  
  await sanitizer.sanitize("Hello", { context });

  assert.equal(calls.length, 1);
  const contextMessage = calls[0].messages.find(m => m.content.includes("[CONTEXT]"));
  assert.ok(contextMessage);
  assert.match(contextMessage.content, /alice@example.com/);
  assert.doesNotMatch(contextMessage.content, /contact1@example.com/);
});