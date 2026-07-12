import test from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_PRIVACY_SANITIZER_PROMPT,
  PRIVACY_SANITIZER_PROMPT,
  STRICT_PRIVACY_SANITIZER_PROMPT,
  PrivateAI
} from "../src/index.js";

test("strict and browser sanitizer prompts define separate trust policies", () => {
  assert.equal(PRIVACY_SANITIZER_PROMPT, STRICT_PRIVACY_SANITIZER_PROMPT);
  assert.match(STRICT_PRIVACY_SANITIZER_PROMPT, /privacy span extractor/);
  assert.match(STRICT_PRIVACY_SANITIZER_PROMPT, /byte-for-byte/);
  assert.match(STRICT_PRIVACY_SANITIZER_PROMPT, /Never paraphrase/);
  assert.match(STRICT_PRIVACY_SANITIZER_PROMPT, /smallest exact private value/);
  assert.match(STRICT_PRIVACY_SANITIZER_PROMPT, /safe_prompt/);
  assert.match(STRICT_PRIVACY_SANITIZER_PROMPT, /session_map/);

  assert.match(BROWSER_PRIVACY_SANITIZER_PROMPT, /browser extension/);
  assert.match(BROWSER_PRIVACY_SANITIZER_PROMPT, /small local rewrites/);
  assert.match(BROWSER_PRIVACY_SANITIZER_PROMPT, /Never perform a wholesale rewrite/);
  assert.match(BROWSER_PRIVACY_SANITIZER_PROMPT, /Preserve quoted email\/message bodies byte-for-byte/);
});

test("main ask call sends only the safe prompt unless system override is provided", async () => {
  const calls = [];
  const provider = {
    async chat(request) {
      calls.push(request);
      if (calls.length === 1) {
        return {
          text: JSON.stringify({
            safe_prompt: "Email contact1@example.com",
            session_map: {
              "contact1@example.com": "alice@example.com"
            }
          }),
          raw: {},
          provider: {}
        };
      }

      return {
        text: "Reply sent to contact1@example.com",
        raw: {},
        provider: { baseURL: "mock://provider", model: "mock-model" }
      };
    }
  };

  const client = new PrivateAI({ provider, loadEnv: false, model: "mock-model" });
  const result = await client.ask("Please email Alice Johnson at alice@example.com.");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].messages[0].role, "system");
  assert.equal(calls[0].messages[0].content, PRIVACY_SANITIZER_PROMPT);
  assert.match(calls[0].messages[1].content, /alice@example\.com/);
  assert.equal(calls[1].messages.length, 1);
  assert.equal(calls[1].messages[0].role, "user");
  assert.equal(calls[1].messages[0].content, "Please email Alex Morgan at contact1@example.com.");
  assert.equal(result.finalText, "Reply sent to alice@example.com");
});
