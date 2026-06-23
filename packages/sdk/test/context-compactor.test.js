import test from "node:test";
import assert from "node:assert/strict";
import { ContextCompactor } from "../src/context-compactor.js";

test("ContextCompactor outputs valid JSON and preserves task/repo facts", async () => {
  const provider = {
    async chat(request) {
      assert.ok(request.messages[0].content.includes("context compaction engine"));
      return {
        text: JSON.stringify({
          safe_context_summary: "User wants to configure the repository name PrivacyAI and test it locally.",
          private_memory: { repo: "ru-aish/PrivacyAI" },
          open_tasks: ["Configure model", "Run E2E tests"],
          stable_user_intent: ["Test context compaction"],
          privacy_sensitive_refs: ["api_key_1"],
          warnings: []
        }),
        raw: {},
        provider: {}
      };
    }
  };

  const compactor = new ContextCompactor({ provider, model: "test-model" });
  const result = await compactor.compact(
    null,
    "how do I test PrivacyAI locally?",
    "You can run pnpm test.",
    { "api_key_1": "sk-12345" }
  );

  assert.equal(result.safe_context_summary, "User wants to configure the repository name PrivacyAI and test it locally.");
  assert.deepEqual(result.private_memory, { repo: "ru-aish/PrivacyAI" });
  assert.deepEqual(result.open_tasks, ["Configure model", "Run E2E tests"]);
  assert.deepEqual(result.stable_user_intent, ["Test context compaction"]);
});
