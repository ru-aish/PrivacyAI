const AGY_IMAGE_ERROR_CODES = new Map([
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
const SDK_IMAGE_ERROR_PATTERN = /^PRIVACYAI_IMAGE_[A-Z0-9_]{1,80}$/;
const AGY_IMAGE_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

/**
 * Thin Gemini/AGY adapter around the optional SDK image engine. The dynamic
 * import keeps Sharp and Tesseract out of text-only AGY processes until the
 * first inline image actually needs inspection.
 */
export function createAgyImageSanitizer(options = {}) {
  let engine = options.engine;
  let enginePromise;
  const ownsEngine = !engine;
  let closed = false;

  const resolveEngine = async () => {
    if (closed) {
      throw agyImageError(
        "PRIVACYAI_AGY_IMAGE_SANITIZER_CLOSED",
        "PrivacyAI AGY image sanitization is closed."
      );
    }
    if (engine) return engine;
    const loadImageModule = options.loadImageModule || (() => import("@privacy-ai/sdk/image"));
    enginePromise ||= Promise.resolve(loadImageModule())
      .then(module => module.createImageSanitizer(options));
    engine = await enginePromise;
    return engine;
  };

  return {
    async sanitize(inlineData, context = {}) {
      try {
        const dataUrl = agyInlineDataUrl(inlineData);
        const imageEngine = await resolveEngine();
        const result = await imageEngine.sanitize(dataUrl, {
          ...context,
          artifactType: "agy_image_ocr"
        });
        if (!result || typeof result.dataUrl !== "string") {
          throw agyImageError(
            "PRIVACYAI_AGY_INVALID_SANITIZED_IMAGE",
            "PrivacyAI blocked the AGY request because image sanitization returned an invalid result."
          );
        }
        return {
          ...result,
          inlineData: agyInlineDataFromUrl(result.dataUrl)
        };
      } catch (error) {
        throw toAgyImageError(error);
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (!ownsEngine) return;

      let resolved = engine;
      if (!resolved && enginePromise) {
        try {
          resolved = await enginePromise;
        } catch {
          // Initialization already failed at the sanitize boundary. Shutdown
          // remains best-effort so the rest of the runtime can still clean up.
        }
      }
      if (typeof resolved?.close === "function") await resolved.close();
    }
  };
}

export function toAgyImageError(error) {
  if (
    error?.name === "AbortError" ||
    error?.code === "PRIVACYAI_REQUEST_ABORTED" ||
    error?.code === "PRIVACYAI_AGY_REQUEST_ABORTED"
  ) {
    return error;
  }
  if (!SDK_IMAGE_ERROR_PATTERN.test(String(error?.code || ""))) return error;
  const code = AGY_IMAGE_ERROR_CODES.get(error.code) || "PRIVACYAI_AGY_IMAGE_SANITIZATION_FAILED";
  return agyImageError(code, error.message || "PrivacyAI AGY image sanitization failed.", error);
}

function agyInlineDataUrl(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw agyImageError("PRIVACYAI_AGY_INVALID_IMAGE", "PrivacyAI requires AGY inline image data.");
  }
  if (typeof value.mimeType !== "string" || typeof value.data !== "string") {
    throw agyImageError("PRIVACYAI_AGY_INVALID_IMAGE", "PrivacyAI requires AGY image MIME and base64 data.");
  }
  return `data:${value.mimeType};base64,${value.data}`;
}

function agyInlineDataFromUrl(value) {
  const match = AGY_IMAGE_DATA_URL_PATTERN.exec(value);
  if (!match || !match[2] || match[2].length % 4 !== 0) {
    throw agyImageError(
      "PRIVACYAI_AGY_INVALID_SANITIZED_IMAGE",
      "PrivacyAI blocked the AGY request because image sanitization returned malformed image data."
    );
  }
  return { mimeType: match[1], data: match[2] };
}

function agyImageError(code, message, cause) {
  const error = cause == null ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}
