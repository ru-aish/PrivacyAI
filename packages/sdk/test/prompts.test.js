import test from "node:test";
import assert from "node:assert/strict";
import { PRIVACY_SANITIZER_PROMPT, PrivateAI } from "../src/index.js";

test("privacy sanitizer prompt requires JSON output", () => {
  assert.match(PRIVACY_SANITIZER_PROMPT, /privacy-preserving intermediary/);
  assert.match(PRIVACY_SANITIZER_PROMPT, /safe_prompt/);
  assert.match(PRIVACY_SANITIZER_PROMPT, /session_map/);
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
  assert.equal(calls[1].messages[0].content, "Email contact1@example.com");
  assert.equal(result.finalText, "Reply sent to alice@example.com");
});