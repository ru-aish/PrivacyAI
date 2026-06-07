import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SYSTEM_PROMPT, PrivateAI } from "../src/index.js";

test("default system prompt is the privacy intermediary prompt", () => {
  assert.match(DEFAULT_SYSTEM_PROMPT, /privacy-preserving intermediary/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /dummy data/);
});

test("client uses the default system prompt when none is provided", async () => {
  const calls = [];
  const provider = {
    async chat(request) {
      calls.push(request);
      return { text: "ok", raw: {}, provider: {} };
    }
  };

  const client = new PrivateAI({ provider, loadEnv: false, model: "mock-model" });
  await client.ask("hello");

  assert.equal(calls[0].messages[0].role, "system");
  assert.equal(calls[0].messages[0].content, DEFAULT_SYSTEM_PROMPT);
});