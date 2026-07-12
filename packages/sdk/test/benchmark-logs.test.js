import test from "node:test";
import assert from "node:assert/strict";
import { AiSanitizer } from "../src/ai-sanitizer.js";

function mockProvider(responses) {
  let callIndex = 0;
  return {
    async chat(request) {
      const resp = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return {
        text: typeof resp === "string" ? resp : JSON.stringify(resp),
        raw: {},
        provider: {}
      };
    }
  };
}

test("benchmark-logs: strict SDK ignores a no-PII rephrase and preserves the original", async () => {
  const provider = mockProvider([
    {
      safe_prompt: "hi how are you?",
      session_map: {}
    }
  ]);

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  const result = await sanitizer.sanitize("hi man how are you?");

  assert.equal(result.sanitizedText, "hi man how are you?");
  assert.equal(result.privacySource, "ai-sanitizer");
});

test("benchmark-logs: browser mode rejects a complete rewrite and falls back", async () => {
  const provider = mockProvider([
    {
      safe_prompt: "I am doing well, how can I help you today?",
      session_map: {}
    },
    {
      safe_prompt: "I am doing well, how can I help you today?",
      session_map: {}
    }
  ]);

  const sanitizer = new AiSanitizer({
    provider,
    loadEnv: false,
    model: "mock-model",
    sanitizationMode: "browser"
  });
  const result = await sanitizer.sanitize("hi man how are you?");

  // Browser mode permits local privacy rewrites, but not an answer or wholesale replacement.
  // "hi man how are you?" -> "I am doing well, how can I help you today?" has distance > 12.
  // So it fails validation and repair, and falls back to regex-fallback which preserves the original.
  assert.equal(result.sanitizedText, "hi man how are you?");
  assert.equal(result.privacySource, "regex-fallback");
});

test("benchmark-logs: context must not override latest prompt (repaired)", async () => {
  const provider = mockProvider([
    {
      safe_prompt: "[CONTEXT] hi how are you?",
      session_map: {}
    },
    {
      safe_prompt: "can you use the @git",
      session_map: {}
    }
  ]);

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  const context = [
    { role: "user", text: "hi how are you?" },
    { role: "assistant", text: "Hi! I’m doing well. How are you doing today?" }
  ];

  const result = await sanitizer.sanitize("can you use the @git", { context });

  assert.equal(result.sanitizedText, "can you use the @git");
  assert.equal(result.privacySource, "ai-sanitizer");
});

test("benchmark-logs: context must not override latest prompt (fallback)", async () => {
  const provider = mockProvider([
    {
      safe_prompt: "[CONTEXT] hi how are you?",
      session_map: {}
    },
    {
      safe_prompt: "[CONTEXT] [CONTEXT] hi how are you?",
      session_map: {}
    }
  ]);

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  const context = [
    { role: "user", text: "hi how are you?" },
    { role: "assistant", text: "Hi! I’m doing well. How are you doing today?" }
  ];

  const result = await sanitizer.sanitize("can you use the @git", { context });

  assert.equal(result.sanitizedText, "can you use the @git");
  assert.equal(result.privacySource, "regex-fallback");
});

test("benchmark-logs: repeated context markers in prompt are rejected", async () => {
  const provider = mockProvider([
    {
      safe_prompt: "[CONTEXT] [CONTEXT] hi how are you? can you use the GitHub tools you have and check the repo https://github.com/ru-aish/PrivacyAI latest PR and review that?",
      session_map: {}
    },
    {
      safe_prompt: "can you use the github tools you have and check the repo https://github.com/ru-aish/PrivacyAI leterst pr and review that",
      session_map: {}
    }
  ]);

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  const context = [
    { role: "user", text: "[CONTEXT] [CONTEXT] hi how are you?" },
    { role: "assistant", text: "I’m good, thanks. Looks like you added the earlier message as context—what would you like to do next?" }
  ];

  const prompt = "can you use the github tools you have and check the repo https://github.com/ru-aish/PrivacyAI leterst pr and review that";
  const result = await sanitizer.sanitize(prompt, { context });

  assert.equal(result.sanitizedText, prompt);
  assert.equal(result.privacySource, "ai-sanitizer");
});

test("benchmark-logs: task-answer design guide response is rejected and falls back", async () => {
  const provider = mockProvider([
    "Here’s a structured approach to designing an icon for PrivacyAI Shield...\n- Use shield shape\n- Use color green",
    "Here’s a structured approach to designing an icon..."
  ]);

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  const prompt = "can you generate a good icon for this which i can add in the firefox";
  const result = await sanitizer.sanitize(prompt);

  assert.equal(result.sanitizedText, prompt);
  assert.equal(result.privacySource, "regex-fallback");
});

test("benchmark-logs: browser mode rejects AMO listing generation and falls back", async () => {
  const provider = mockProvider([
    {
      safe_prompt: "PrivacyAI Shield is a secure extension that protects your private information. Learn more at our AMO listing page where you can install the addon...",
      session_map: {}
    },
    {
      safe_prompt: "PrivacyAI Shield is a secure extension that protects your private information...",
      session_map: {}
    }
  ]);

  const sanitizer = new AiSanitizer({
    provider,
    loadEnv: false,
    model: "mock-model",
    sanitizationMode: "browser"
  });
  const prompt = "write the firefox listing text for the new version";
  const result = await sanitizer.sanitize(prompt);

  assert.equal(result.sanitizedText, prompt);
  assert.equal(result.privacySource, "regex-fallback");
});
