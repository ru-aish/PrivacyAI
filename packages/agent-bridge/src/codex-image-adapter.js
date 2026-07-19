import { gatewayError } from "./gateway-error.js";

const CODEX_IMAGE_ERROR_CODES = new Map([
  ["PRIVACYAI_IMAGE_INVALID", "PRIVACYAI_CODEX_INVALID_IMAGE"],
  ["PRIVACYAI_IMAGE_UNSUPPORTED_URL", "PRIVACYAI_CODEX_UNSUPPORTED_IMAGE_URL"],
  ["PRIVACYAI_IMAGE_INVALID_BASE64", "PRIVACYAI_CODEX_INVALID_IMAGE_BASE64"],
  ["PRIVACYAI_IMAGE_TOO_LARGE", "PRIVACYAI_CODEX_IMAGE_TOO_LARGE"],
  ["PRIVACYAI_IMAGE_MIME_MISMATCH", "PRIVACYAI_CODEX_IMAGE_MIME_MISMATCH"],
  ["PRIVACYAI_IMAGE_ANIMATED", "PRIVACYAI_CODEX_ANIMATED_IMAGE"],
  ["PRIVACYAI_IMAGE_SANITIZER_CLOSED", "PRIVACYAI_CODEX_IMAGE_SANITIZER_CLOSED"],
  ["PRIVACYAI_IMAGE_LOCATION_FAILED", "PRIVACYAI_CODEX_IMAGE_LOCATION_FAILED"],
  ["PRIVACYAI_IMAGE_VERIFICATION_FAILED", "PRIVACYAI_CODEX_IMAGE_VERIFICATION_FAILED"],
  ["PRIVACYAI_IMAGE_RENDER_FAILED", "PRIVACYAI_CODEX_IMAGE_RENDER_FAILED"],
  ["PRIVACYAI_IMAGE_OCR_FAILED", "PRIVACYAI_CODEX_IMAGE_OCR_FAILED"]
]);
const SDK_IMAGE_ERROR_PATTERN = /^PRIVACYAI_IMAGE_[A-Z0-9_]{1,80}$/;

export function createCodexImageSanitizer(options = {}) {
  let engine = options.engine;
  let enginePromise;
  const ownsEngine = !engine;
  let closed = false;

  const resolveEngine = async () => {
    if (closed) {
      throw gatewayError(
        "PRIVACYAI_CODEX_IMAGE_SANITIZER_CLOSED",
        "PrivacyAI image sanitization is closed."
      );
    }
    if (engine) return engine;
    enginePromise ||= import("@privacy-ai/sdk/image").then(module => module.createImageSanitizer(options));
    engine = await enginePromise;
    return engine;
  };

  return {
    async sanitize(imageUrl, context = {}) {
      try {
        const imageEngine = await resolveEngine();
        const result = await imageEngine.sanitize(imageUrl, {
          ...context,
          artifactType: "codex_image_ocr"
        });
        if (!result || typeof result.dataUrl !== "string") {
          throw gatewayError(
            "PRIVACYAI_CODEX_INVALID_SANITIZED_IMAGE",
            "PrivacyAI blocked the Codex request because image sanitization returned an invalid result."
          );
        }
        return {
          ...result,
          imageUrl: result.dataUrl
        };
      } catch (error) {
        throw toCodexImageError(error);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (!ownsEngine) return;
      const resolved = engine || (enginePromise ? await enginePromise : null);
      if (typeof resolved?.close === "function") await resolved.close();
    }
  };
}

export function toCodexImageError(error) {
  if (error?.name === "AbortError" || error?.code === "PRIVACYAI_REQUEST_ABORTED") return error;
  if (!SDK_IMAGE_ERROR_PATTERN.test(String(error?.code || ""))) return error;
  const code = CODEX_IMAGE_ERROR_CODES.get(error.code) || "PRIVACYAI_CODEX_IMAGE_SANITIZATION_FAILED";
  return gatewayError(code, error.message || "PrivacyAI image sanitization failed.");
}
