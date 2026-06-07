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