import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "@privacy-ai/sdk";
import { createPrivacySanitizer } from "../src/privacy-sanitizer.js";

const CONFIG = {
  provider: "lm-studio",
  model: "test-model",
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "not-required",
  timeoutMs: 1000,
  numCtx: 4096
};

test("local privacy sanitizer retries one transient provider failure", async () => {
  let calls = 0;
  const privacyClient = {
    async sanitize(prompt, options) {
      calls += 1;
      assert.equal(prompt, "private input");
      assert.equal(options.artifactType, "message_text");
      if (calls === 1) {
        throw new ProviderError("Provider returned HTTP 503", {
          status: 503,
          bodyText: "Channel Error"
        });
      }
      return {
        sanitizedText: "[PRIVATE_1]",
        sessionMap: { "[PRIVATE_1]": "private input" }
      };
    }
  };
  const sanitizer = createPrivacySanitizer(CONFIG, {
    privacyClient,
    transientProviderRetryDelayMs: 0
  });

  const result = await sanitizer("private input", { artifactType: "message_text" });

  assert.equal(calls, 2);
  assert.equal(result.sanitizedPrompt, "[PRIVATE_1]");
  assert.deepEqual(result.sessionMap, { "[PRIVATE_1]": "private input" });
});

test("local privacy sanitizer retries LM Studio channel-error envelopes", async () => {
  let calls = 0;
  const sanitizer = createPrivacySanitizer(CONFIG, {
    privacyClient: {
      async sanitize() {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError(
            "Provider response did not include choices[0].message.content.",
            { error: { message: "Channel Error" } }
          );
        }
        return { sanitizedText: "safe", sessionMap: {} };
      }
    },
    transientProviderRetryDelayMs: 0
  });

  const result = await sanitizer("input");

  assert.equal(calls, 2);
  assert.equal(result.sanitizedPrompt, "safe");
});

test("local privacy sanitizer does not retry client or cancellation failures", async t => {
  for (const scenario of [
    {
      name: "HTTP 400",
      error: new ProviderError("Provider returned HTTP 400", {
        status: 400,
        bodyText: "too large"
      })
    },
    {
      name: "client cancellation",
      error: Object.assign(new ProviderError("Provider request cancelled"), {
        code: "PRIVACYAI_REQUEST_ABORTED"
      })
    }
  ]) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const sanitizer = createPrivacySanitizer(CONFIG, {
        privacyClient: {
          async sanitize() {
            calls += 1;
            throw scenario.error;
          }
        },
        transientProviderRetryDelayMs: 0
      });

      await assert.rejects(sanitizer("input"), error => error === scenario.error);
      assert.equal(calls, 1);
    });
  }
});
