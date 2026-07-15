import test from "node:test";
import assert from "node:assert/strict";
import { AiSanitizer, parseSanitizerSpans } from "../src/ai-sanitizer.js";
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

test("strict sanitizer accepts compact exact-span output without reproducing the prompt", async () => {
  const original = "Contact Private Person at private.person@example.test";
  const provider = {
    async chat() {
      return {
        text: JSON.stringify({
          spans: [
            { value: "Private Person", type: "PERSON" },
            { value: "private.person@example.test", type: "EMAIL" }
          ]
        }),
        raw: {},
        provider: {}
      };
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);
  assert.equal(result.privacySource, "ai-span-sanitizer");
  assert.equal(result.sanitizedText.includes("Private Person"), false);
  assert.equal(result.sanitizedText.includes("private.person@example.test"), false);
});

test("span parser rejects values that are not exact input substrings", () => {
  assert.equal(
    parseSanitizerSpans(
      JSON.stringify({ spans: [{ value: "invented@example.test", type: "EMAIL" }] }),
      "Public input"
    ),
    null
  );
});

test("strict fallback ignores low-confidence capitalized documentation phrases", async () => {
  const provider = {
    async chat() {
      return { text: "not-json", raw: {}, provider: {} };
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const documentation = "Output Schema\nGeneral Rules\nRequest Metadata";
  const clean = await sanitizer.sanitize(documentation, { identityConfidenceThreshold: 0.85 });
  assert.equal(clean.sanitizedText, documentation);

  const contextual = await sanitizer.sanitize("my name is John Doe");
  assert.equal(contextual.sanitizedText.includes("John Doe"), false);
});


test("span parser rejects unsupported model-defined types", () => {
  assert.equal(
    parseSanitizerSpans(
      JSON.stringify({ spans: [{ value: "private-value", type: "MODEL_INVENTED_TYPE" }] }),
      "private-value"
    ),
    null
  );
});

test("strict exact spans redact password aliases even inside protected code text", async () => {
  const secret = "CustomerSecretValue123";
  const original = `Use \`${secret}\` for the local test.`;
  const provider = {
    async chat() {
      return {
        text: JSON.stringify({ spans: [{ value: secret, type: "PASSWORD" }] }),
        raw: {},
        provider: {}
      };
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);

  assert.equal(result.privacySource, "ai-span-sanitizer");
  assert.equal(result.sanitizedText.includes(secret), false);
  assert.equal(Object.values(result.sessionMap).includes(secret), true);
});
