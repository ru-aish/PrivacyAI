import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_IMAGE_BYTES,
  buildImagePayload,
  formatBytes,
  normalizeImagePreviewResponse,
  validateImageFile
} from "../public/js/app-core.js";

test("image file validation accepts supported images and rejects missing, empty, unsupported, and oversized files", () => {
  assert.equal(validateImageFile({ type: "image/png", size: 1024 }), null);
  assert.equal(validateImageFile(null), "Choose an image first.");
  assert.equal(validateImageFile({ type: "image/gif", size: 10 }), "Use a PNG, JPEG, or WebP image.");
  assert.equal(validateImageFile({ type: "image/png", size: 0 }), "The selected image is empty.");
  assert.match(validateImageFile({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }), /larger than 8\.0 MB/);
});

test("image payload construction trims the prompt and requires an image data URL", () => {
  assert.deepEqual(buildImagePayload("  inspect owner  ", "data:image/png;base64,AAAA"), {
    message: "inspect owner",
    image_data_url: "data:image/png;base64,AAAA"
  });
  assert.throws(() => buildImagePayload("", "data:image/png;base64,AAAA"), /Enter the prompt/);
  assert.throws(() => buildImagePayload("inspect", ""), /Choose an image/);
});

test("preview response normalization preserves before-and-after evidence", () => {
  const result = normalizeImagePreviewResponse({
    status: "success",
    original_message: "Owner alice@example.test",
    sanitized_message: "Owner contact1@example.com",
    sanitized_image_url: "data:image/png;base64,BBBB",
    image_changed: true,
    prompt_changed: true,
    privacy_items_detected: ["contact1@example.com"],
    image_stats: {
      detected_line_count: 7,
      protected_region_count: 2,
      mask_strategy: "line",
      verification_attempts: 2
    }
  }, "data:image/png;base64,AAAA");

  assert.equal(result.originalImageUrl, "data:image/png;base64,AAAA");
  assert.equal(result.sanitizedImageUrl, "data:image/png;base64,BBBB");
  assert.equal(result.sanitizedPrompt, "Owner contact1@example.com");
  assert.deepEqual(result.privacyItems, ["contact1@example.com"]);
  assert.equal(result.detectedLineCount, 7);
  assert.equal(result.protectedRegionCount, 2);
  assert.equal(result.maskStrategy, "line");
  assert.equal(result.verificationAttempts, 2);
  assert.equal(result.imageChanged, true);
  assert.equal(result.promptChanged, true);
});

test("preview response normalization rejects malformed server output", () => {
  assert.throws(() => normalizeImagePreviewResponse({ status: "error", error: "blocked" }, "x"), /blocked/);
  assert.throws(() => normalizeImagePreviewResponse({ status: "success", sanitized_image_url: "data:image/png;base64,x" }, "x"), /invalid sanitized prompt/);
  assert.throws(() => normalizeImagePreviewResponse({ status: "success", sanitized_message: "safe", sanitized_image_url: "https://example.test/image.png" }, "x"), /invalid sanitized image/);
});

test("byte formatting remains compact for the upload interface", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(8 * 1024 * 1024), "8.0 MB");
});
