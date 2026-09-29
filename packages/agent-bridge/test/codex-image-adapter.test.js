import assert from "node:assert/strict";
import test from "node:test";

import { createImageError } from "@privacy-ai/sdk/image";
import {
  createCodexImageSanitizer,
  sanitizeCodexRequestBody,
  toCodexImageError
} from "../src/index.js";

const PRIVATE = "alice.private@example.test";
const PLACEHOLDER = "[EMAIL_1]";
const SOURCE_IMAGE = "data:image/png;base64,AAAA";
const SAFE_IMAGE = "data:image/png;base64,BBBB";

function sanitizer(text) {
  const found = text.includes(PRIVATE);
  return Promise.resolve({
    sanitizedPrompt: found ? text.replaceAll(PRIVATE, PLACEHOLDER) : text,
    sessionMap: found ? { [PLACEHOLDER]: PRIVATE } : {}
  });
}

function baseRequest(input) {
  return {
    model: "gpt-5.4-mini",
    store: false,
    stream: true,
    client_metadata: { thread_id: "image-thread" },
    input
  };
}

test("Codex image adapter translates generic SDK results and error codes", async () => {
  const adapter = createCodexImageSanitizer({
    engine: {
      async sanitize(dataUrl, context) {
        assert.equal(dataUrl, SOURCE_IMAGE);
        assert.equal(context.artifactType, "codex_image_ocr");
        return {
          dataUrl: SAFE_IMAGE,
          changed: true,
          sessionMapAdditions: { [PLACEHOLDER]: PRIVATE },
          maskStrategy: "line",
          verificationAttempts: 2
        };
      }
    }
  });

  const result = await adapter.sanitize(SOURCE_IMAGE, { sanitizer, sessionMap: {} });
  assert.equal(result.imageUrl, SAFE_IMAGE);
  assert.equal(result.dataUrl, SAFE_IMAGE);
  assert.equal(result.maskStrategy, "line");

  const mapped = toCodexImageError(createImageError(
    "PRIVACYAI_IMAGE_VERIFICATION_FAILED",
    "verification failed"
  ));
  assert.equal(mapped.code, "PRIVACYAI_CODEX_IMAGE_VERIFICATION_FAILED");

  const cancellation = new Error("cancelled");
  cancellation.name = "AbortError";
  assert.equal(toCodexImageError(cancellation), cancellation);
});

test("Codex images share SDK mappings with prompt text and preserve image detail", async () => {
  let calls = 0;
  const imageSanitizer = {
    async sanitize(imageUrl) {
      calls += 1;
      assert.equal(imageUrl, SOURCE_IMAGE);
      return {
        imageUrl: SAFE_IMAGE,
        sessionMapAdditions: { [PLACEHOLDER]: PRIVATE },
        changed: true
      };
    }
  };
  const body = baseRequest([{ type: "message", role: "user", content: [
    { type: "input_image", image_url: SOURCE_IMAGE, detail: "high" },
    { type: "input_text", text: `Fix the form owned by ${PRIVATE}` }
  ] }]);

  const result = await sanitizeCodexRequestBody(body, { sanitizer, imageSanitizer });
  assert.equal(calls, 1);
  assert.equal(result.body.input[0].content[0].image_url, SAFE_IMAGE);
  assert.equal(result.body.input[0].content[0].detail, "high");
  assert.equal(result.body.input[0].content[1].text, `Fix the form owned by ${PLACEHOLDER}`);
  assert.deepEqual(result.sessionMapAdditions, { [PLACEHOLDER]: PRIVATE });
  assert.equal(result.itemRecords.some(record => record.artifactType === "image"), false);
});

test("Codex sanitizes input images inside supported tool-output shapes", async () => {
  const imageSanitizer = {
    async sanitize() {
      return { imageUrl: SAFE_IMAGE, sessionMapAdditions: {}, changed: true };
    }
  };
  const arrayOutput = baseRequest([{
    type: "function_call_output",
    call_id: "call-array-image",
    output: [{ type: "input_image", image_url: SOURCE_IMAGE }]
  }]);
  const arrayResult = await sanitizeCodexRequestBody(arrayOutput, { sanitizer, imageSanitizer });
  assert.equal(arrayResult.body.input[0].output[0].image_url, SAFE_IMAGE);

  const objectOutput = baseRequest([{
    type: "custom_tool_call_output",
    call_id: "call-object-image",
    name: "inspect_image",
    output: { content_items: [{ type: "input_image", image_url: SOURCE_IMAGE, detail: "low" }] }
  }]);
  const objectResult = await sanitizeCodexRequestBody(objectOutput, { sanitizer, imageSanitizer });
  assert.equal(objectResult.body.input[0].output.content_items[0].image_url, SAFE_IMAGE);
  assert.equal(objectResult.body.input[0].output.content_items[0].detail, "low");
});

test("Codex image count and detail validation stop before sanitization", async () => {
  let calls = 0;
  const imageSanitizer = {
    async sanitize() {
      calls += 1;
      return { imageUrl: SAFE_IMAGE, sessionMapAdditions: {} };
    }
  };
  const tooMany = baseRequest([{ type: "message", role: "user", content: [
    { type: "input_image", image_url: SOURCE_IMAGE },
    { type: "input_image", image_url: SOURCE_IMAGE }
  ] }]);
  await assert.rejects(
    sanitizeCodexRequestBody(tooMany, { sanitizer, imageSanitizer, maxImagesPerRequest: 1 }),
    error => error?.code === "PRIVACYAI_CODEX_TOO_MANY_IMAGES"
  );
  assert.equal(calls, 0);

  const invalidDetail = baseRequest([{ type: "message", role: "user", content: [
    { type: "input_image", image_url: SOURCE_IMAGE, detail: "raw" }
  ] }]);
  await assert.rejects(
    sanitizeCodexRequestBody(invalidDetail, { sanitizer, imageSanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_INVALID_IMAGE"
  );
  assert.equal(calls, 0);
});

test("Codex requires an image sanitizer only when image content is present", async () => {
  const imageBody = baseRequest([{ type: "message", role: "user", content: [
    { type: "input_image", image_url: SOURCE_IMAGE }
  ] }]);
  await assert.rejects(
    sanitizeCodexRequestBody(imageBody, { sanitizer }),
    error => error?.code === "PRIVACYAI_CODEX_IMAGE_SANITIZER_REQUIRED"
  );

  const textBody = baseRequest([{ type: "message", role: "user", content: [
    { type: "input_text", text: "Public prompt" }
  ] }]);
  await assert.doesNotReject(sanitizeCodexRequestBody(textBody, { sanitizer }));
});
