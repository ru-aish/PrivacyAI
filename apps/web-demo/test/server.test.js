import assert from "node:assert/strict";
import test from "node:test";

import { createWebDemoServer } from "../server.mjs";

const PRIVATE = "alice.private@example.test";
const PLACEHOLDER = "contact1@example.com";
const ORIGINAL_IMAGE = "data:image/png;base64,QUFBQQ==";
const SAFE_IMAGE = "data:image/png;base64,QkJCQg==";

function strictSanitizer(text) {
  const found = text.includes(PRIVATE);
  return Promise.resolve({
    sanitizedPrompt: found ? text.replaceAll(PRIVATE, PLACEHOLDER) : text,
    sessionMap: found ? { [PLACEHOLDER]: PRIVATE } : {}
  });
}

function services(imageSanitizer) {
  return {
    config: {
      provider: "ollama",
      model: "ministral-3:3b",
      baseURL: "http://127.0.0.1:11434/v1"
    },
    strictSanitizer,
    maxContextChars: 8000,
    ownsImageSanitizer: false,
    imageSanitizer,
    client: {
      async ask(message) {
        return {
          sanitizedText: message.replaceAll(PRIVATE, PLACEHOLDER),
          modelText: `Model saw ${PLACEHOLDER}`,
          finalText: `Model saw ${PRIVATE}`,
          detections: [{ replacement: PLACEHOLDER }]
        };
      }
    }
  };
}

async function withServer(t, imageSanitizer, options = {}) {
  const app = await createWebDemoServer({
    services: services(imageSanitizer),
    maxBodyBytes: options.maxBodyBytes
  });
  const address = await app.listen(0, "127.0.0.1");
  t.after(() => app.close());
  return `http://127.0.0.1:${address.port}`;
}

async function post(base, pathname, payload) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

test("image preview returns the same mapped prompt and sanitized image that would cross the boundary", async t => {
  const base = await withServer(t, {
    async sanitize(imageUrl) {
      assert.equal(imageUrl, ORIGINAL_IMAGE);
      return {
        dataUrl: SAFE_IMAGE,
        sessionMapAdditions: { [PLACEHOLDER]: PRIVATE },
        changed: true,
        detectedLineCount: 8,
        regionCount: 2,
        maskStrategy: "line",
        verificationAttempts: 2
      };
    }
  });

  const { response, body } = await post(base, "/api/sanitize-image", {
    message: `Fix the form owned by ${PRIVATE}`,
    image_data_url: ORIGINAL_IMAGE
  });

  assert.equal(response.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.sanitized_message, `Fix the form owned by ${PLACEHOLDER}`);
  assert.equal(body.sanitized_image_url, SAFE_IMAGE);
  assert.equal(body.prompt_changed, true);
  assert.equal(body.image_changed, true);
  assert.deepEqual(body.privacy_items_detected, [PLACEHOLDER]);
  assert.deepEqual(body.image_stats, {
    detected_line_count: 8,
    protected_region_count: 2,
    mask_strategy: "line",
    verification_attempts: 2
  });
});

test("clean image and prompt remain byte-for-byte unchanged", async t => {
  const base = await withServer(t, {
    async sanitize(imageUrl) {
      return {
        dataUrl: imageUrl,
        sessionMapAdditions: {},
        changed: false,
        detectedLineCount: 3
      };
    }
  });

  const { response, body } = await post(base, "/api/sanitize-image", {
    message: "Explain this public error message",
    image_data_url: ORIGINAL_IMAGE
  });

  assert.equal(response.status, 200);
  assert.equal(body.sanitized_message, "Explain this public error message");
  assert.equal(body.sanitized_image_url, ORIGINAL_IMAGE);
  assert.equal(body.prompt_changed, false);
  assert.equal(body.image_changed, false);
  assert.deepEqual(body.privacy_items_detected, []);
  assert.equal(body.image_stats.protected_region_count, 0);
});

test("image decoder failures are returned as safe client errors", async t => {
  const base = await withServer(t, {
    async sanitize() {
      const error = new Error("PrivacyAI blocked malformed image base64.");
      error.code = "PRIVACYAI_IMAGE_INVALID_BASE64";
      throw error;
    }
  });

  const { response, body } = await post(base, "/api/sanitize-image", {
    message: "Inspect this image",
    image_data_url: "data:image/png;base64,broken"
  });

  assert.equal(response.status, 400);
  assert.equal(body.status, "error");
  assert.equal(body.code, "PRIVACYAI_IMAGE_INVALID_BASE64");
  assert.match(body.error, /malformed image base64/);
});

test("oversized prompt-plus-image requests stop before image sanitization", async t => {
  let calls = 0;
  const base = await withServer(t, {
    async sanitize() {
      calls += 1;
      return { dataUrl: SAFE_IMAGE, sessionMapAdditions: {}, changed: false };
    }
  }, { maxBodyBytes: 120 });

  const { response, body } = await post(base, "/api/sanitize-image", {
    message: "x".repeat(300),
    image_data_url: ORIGINAL_IMAGE
  });

  assert.equal(response.status, 413);
  assert.equal(body.code, "REQUEST_TOO_LARGE");
  assert.equal(calls, 0);
});

test("unexpected sanitizer failures stay server-side and use a stable error shape", async t => {
  const base = await withServer(t, {
    async sanitize() {
      throw new Error("OCR worker crashed");
    }
  });

  const { response, body } = await post(base, "/api/sanitize-image", {
    message: "Inspect this image",
    image_data_url: ORIGINAL_IMAGE
  });

  assert.equal(response.status, 500);
  assert.equal(body.status, "error");
  assert.equal(body.code, "INTERNAL_ERROR");
  assert.equal(body.error, "PrivacyAI could not complete the local sanitization preview.");
});

test("playground status and static UI expose Ollama image privacy mode", async t => {
  const base = await withServer(t, {
    async sanitize(imageUrl) {
      return { dataUrl: imageUrl, sessionMapAdditions: {}, changed: false };
    }
  });

  const statusResponse = await fetch(`${base}/api/status`);
  const status = await statusResponse.json();
  assert.equal(status.provider, "ollama");
  assert.equal(status.image_privacy, true);

  const pageResponse = await fetch(`${base}/`);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /Prompt \+ image/);
  assert.match(page, /What Codex receives/);
  assert.match(page, /id="sanitizeImageButton"/);
});
