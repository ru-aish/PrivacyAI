import assert from "node:assert/strict";
import test from "node:test";

import { createImageError } from "@privacy-ai/sdk/image";
import { createAgyImageSanitizer, toAgyImageError } from "../src/index.js";

const PRIVATE_VALUE = "alice.private@example.test";
const PLACEHOLDER = "[EMAIL_1]";
const SOURCE = { mimeType: "image/png", data: "AAAA" };
const SAFE = { mimeType: "image/png", data: "BBBB" };

function sanitizer(text) {
  const found = text.includes(PRIVATE_VALUE);
  return Promise.resolve({
    sanitizedPrompt: found ? text.replaceAll(PRIVATE_VALUE, PLACEHOLDER) : text,
    sessionMap: found ? { [PLACEHOLDER]: PRIVATE_VALUE } : {}
  });
}

test("AGY image adapter converts inline data through the SDK image contract", async () => {
  const adapter = createAgyImageSanitizer({
    engine: {
      async sanitize(dataUrl, context) {
        assert.equal(dataUrl, "data:image/png;base64,AAAA");
        assert.equal(context.artifactType, "agy_image_ocr");
        assert.equal(context.sanitizer, sanitizer);
        return {
          dataUrl: "data:image/png;base64,BBBB",
          changed: true,
          sessionMapAdditions: { [PLACEHOLDER]: PRIVATE_VALUE },
          maskStrategy: "line",
          verificationAttempts: 2
        };
      }
    }
  });

  const result = await adapter.sanitize(SOURCE, { sanitizer, sessionMap: {} });
  assert.deepEqual(result.inlineData, SAFE);
  assert.equal(result.dataUrl, "data:image/png;base64,BBBB");
  assert.equal(result.maskStrategy, "line");
  assert.deepEqual(result.sessionMapAdditions, { [PLACEHOLDER]: PRIVATE_VALUE });
});

test("AGY image adapter translates generic SDK image failures", () => {
  const mappings = new Map([
    ["PRIVACYAI_IMAGE_INVALID", "PRIVACYAI_AGY_INVALID_IMAGE"],
    ["PRIVACYAI_IMAGE_UNSUPPORTED_URL", "PRIVACYAI_AGY_UNSUPPORTED_IMAGE_URL"],
    ["PRIVACYAI_IMAGE_INVALID_BASE64", "PRIVACYAI_AGY_INVALID_IMAGE_BASE64"],
    ["PRIVACYAI_IMAGE_TOO_LARGE", "PRIVACYAI_AGY_IMAGE_TOO_LARGE"],
    ["PRIVACYAI_IMAGE_MIME_MISMATCH", "PRIVACYAI_AGY_IMAGE_MIME_MISMATCH"],
    ["PRIVACYAI_IMAGE_ANIMATED", "PRIVACYAI_AGY_ANIMATED_IMAGE"],
    ["PRIVACYAI_IMAGE_SANITIZER_CLOSED", "PRIVACYAI_AGY_IMAGE_SANITIZER_CLOSED"],
    ["PRIVACYAI_IMAGE_LOCATION_FAILED", "PRIVACYAI_AGY_IMAGE_LOCATION_FAILED"],
    ["PRIVACYAI_IMAGE_VERIFICATION_FAILED", "PRIVACYAI_AGY_IMAGE_VERIFICATION_FAILED"],
    ["PRIVACYAI_IMAGE_RENDER_FAILED", "PRIVACYAI_AGY_IMAGE_RENDER_FAILED"],
    ["PRIVACYAI_IMAGE_OCR_FAILED", "PRIVACYAI_AGY_IMAGE_OCR_FAILED"]
  ]);

  for (const [sdkCode, agyCode] of mappings) {
    const source = createImageError(sdkCode, `failure ${sdkCode}`);
    const translated = toAgyImageError(source);
    assert.equal(translated.code, agyCode);
    assert.equal(translated.cause, source);
  }

  const future = createImageError("PRIVACYAI_IMAGE_FUTURE_FAILURE", "future");
  assert.equal(toAgyImageError(future).code, "PRIVACYAI_AGY_IMAGE_SANITIZATION_FAILED");

  const unrelated = new Error("unrelated");
  assert.equal(toAgyImageError(unrelated), unrelated);

  const cancellation = new Error("cancelled");
  cancellation.name = "AbortError";
  assert.equal(toAgyImageError(cancellation), cancellation);
});

test("AGY image adapter lazily loads and closes its owned SDK engine once", async () => {
  let loads = 0;
  let sanitizations = 0;
  let closes = 0;
  const adapter = createAgyImageSanitizer({
    async loadImageModule() {
      loads += 1;
      return {
        createImageSanitizer() {
          return {
            async sanitize(dataUrl) {
              sanitizations += 1;
              return { dataUrl, changed: false, sessionMapAdditions: {} };
            },
            async close() {
              closes += 1;
            }
          };
        }
      };
    }
  });

  assert.equal(loads, 0);
  await adapter.sanitize(SOURCE, { sanitizer, sessionMap: {} });
  await adapter.sanitize(SOURCE, { sanitizer, sessionMap: {} });
  assert.equal(loads, 1);
  assert.equal(sanitizations, 2);

  await adapter.close();
  await adapter.close();
  assert.equal(closes, 1);
  await assert.rejects(
    adapter.sanitize(SOURCE, { sanitizer, sessionMap: {} }),
    error => error?.code === "PRIVACYAI_AGY_IMAGE_SANITIZER_CLOSED"
  );
});

test("AGY image adapter does not close an injected engine", async () => {
  let closes = 0;
  const adapter = createAgyImageSanitizer({
    engine: {
      async sanitize(dataUrl) {
        return { dataUrl, changed: false, sessionMapAdditions: {} };
      },
      async close() {
        closes += 1;
      }
    }
  });

  await adapter.sanitize(SOURCE, { sanitizer, sessionMap: {} });
  await adapter.close();
  assert.equal(closes, 0);
});

test("AGY image adapter rejects malformed sanitized data URLs", async () => {
  const adapter = createAgyImageSanitizer({
    engine: {
      async sanitize() {
        return { dataUrl: "https://example.test/image.png", sessionMapAdditions: {} };
      }
    }
  });

  await assert.rejects(
    adapter.sanitize(SOURCE, { sanitizer, sessionMap: {} }),
    error => error?.code === "PRIVACYAI_AGY_INVALID_SANITIZED_IMAGE"
  );
});

test("AGY adapter preserves SDK media validation and limit errors", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVR4nGP4DwUMMAYAj4IP8TylVlEAAAAASUVORK5CYII=";
  const adapter = createAgyImageSanitizer();
  try {
    await assert.rejects(
      adapter.sanitize({ mimeType: "image/png", data: "AB==" }, { sanitizer, sessionMap: {} }),
      error => error?.code === "PRIVACYAI_AGY_INVALID_IMAGE_BASE64"
    );
    await assert.rejects(
      adapter.sanitize({ mimeType: "image/jpeg", data: png }, { sanitizer, sessionMap: {} }),
      error => error?.code === "PRIVACYAI_AGY_IMAGE_MIME_MISMATCH"
    );
  } finally {
    await adapter.close();
  }

  const limited = createAgyImageSanitizer({ maxImageBytes: 1 });
  try {
    await assert.rejects(
      limited.sanitize({ mimeType: "image/png", data: png }, { sanitizer, sessionMap: {} }),
      error => error?.code === "PRIVACYAI_AGY_IMAGE_TOO_LARGE"
    );
  } finally {
    await limited.close();
  }
});
