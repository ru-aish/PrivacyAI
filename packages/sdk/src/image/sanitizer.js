import { sanitizeStructuredValue } from "../structured.js";
import { createImageError, throwIfImageAborted } from "./errors.js";
import { decodeImageDataUrl, encodePngDataUrl, normalizeImage } from "./media.js";
import {
  locatePrivateRegions,
  normalizeMaskStrategies,
  regionsForStrategy,
  verifyPrivateTextRemoved
} from "./regions.js";
import { renderOpaqueRegions } from "./renderer.js";
import { createTesseractOcrEngine } from "./tesseract.js";

export function createImageSanitizer(options = {}) {
  const ocr = options.ocr || createTesseractOcrEngine(options);
  const ownsOcr = !options.ocr;
  const renderer = options.renderer || renderOpaqueRegions;
  const maskStrategies = normalizeMaskStrategies(options.maskStrategies);
  let closed = false;

  return {
    async sanitize(dataUrl, context = {}) {
      if (closed) {
        throw createImageError("PRIVACYAI_IMAGE_SANITIZER_CLOSED", "PrivacyAI image sanitization is closed.");
      }
      const parsed = await decodeImageDataUrl(dataUrl, options);
      throwIfImageAborted(context.signal);

      const normalized = await normalizeImage(parsed.buffer);
      const lines = requireOcrLines(await ocr.recognize(normalized, { signal: context.signal }));
      throwIfImageAborted(context.signal);
      const texts = lines.map(line => line.text);
      if (texts.length === 0) return unchangedResult(dataUrl, 0);

      const classified = await sanitizeStructuredValue(texts, {
        sanitizer: context.sanitizer,
        sessionMap: context.sessionMap,
        maxContextChars: context.maxContextChars,
        maxContextTokens: context.maxContextTokens,
        tokenCounter: context.tokenCounter,
        artifactType: context.artifactType || "image_ocr",
        identity: context.identity,
        signal: context.signal,
        onBatchComplete: context.onBatchComplete
      });
      const completeMap = { ...(context.sessionMap || {}), ...classified.sessionMapAdditions };
      const regions = locatePrivateRegions(lines, completeMap);
      if (regions.length === 0) {
        if (classified.changed) {
          throw createImageError(
            "PRIVACYAI_IMAGE_LOCATION_FAILED",
            "PrivacyAI identified private image text but could not locate it safely."
          );
        }
        return {
          ...unchangedResult(dataUrl, lines.length),
          sessionMapAdditions: classified.sessionMapAdditions,
          ...(classified.identityMapAdditions
            ? { identityMapAdditions: classified.identityMapAdditions }
            : {})
        };
      }

      for (let attempt = 0; attempt < maskStrategies.length; attempt += 1) {
        throwIfImageAborted(context.signal);
        const maskStrategy = maskStrategies[attempt];
        const attemptRegions = regionsForStrategy(regions, maskStrategy);
        const rendered = await renderer(normalized, attemptRegions, {
          ...options,
          maskAttempt: attempt + 1,
          maskStrategy
        });
        if (!Buffer.isBuffer(rendered) || rendered.length === 0) {
          throw createImageError(
            "PRIVACYAI_IMAGE_RENDER_FAILED",
            "PrivacyAI image rendering did not return a non-empty buffer."
          );
        }
        const verificationLines = requireOcrLines(await ocr.recognize(rendered, {
          signal: context.signal,
          verification: true,
          verificationAttempt: attempt + 1
        }));
        try {
          verifyPrivateTextRemoved(verificationLines, regions);
          return {
            dataUrl: encodePngDataUrl(rendered),
            sessionMapAdditions: classified.sessionMapAdditions,
            ...(classified.identityMapAdditions
              ? { identityMapAdditions: classified.identityMapAdditions }
              : {}),
            changed: true,
            detectedLineCount: lines.length,
            regionCount: attemptRegions.length,
            maskStrategy,
            verificationAttempts: attempt + 1
          };
        } catch (error) {
          const retryable = error?.code === "PRIVACYAI_IMAGE_VERIFICATION_FAILED";
          if (!retryable || attempt === maskStrategies.length - 1) throw error;
        }
      }

      throw createImageError(
        "PRIVACYAI_IMAGE_VERIFICATION_FAILED",
        "PrivacyAI could not verify removal of private image text."
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      if (ownsOcr && typeof ocr.close === "function") await ocr.close();
    }
  };
}

function unchangedResult(dataUrl, detectedLineCount) {
  return {
    dataUrl,
    sessionMapAdditions: {},
    changed: false,
    detectedLineCount,
    regionCount: 0,
    maskStrategy: null,
    verificationAttempts: 0
  };
}

function requireOcrLines(value) {
  if (!Array.isArray(value)) {
    throw createImageError("PRIVACYAI_IMAGE_OCR_FAILED", "PrivacyAI OCR returned an invalid result.");
  }
  for (const line of value) {
    if (!line || typeof line.text !== "string" || !validBox(line.box)) {
      throw createImageError("PRIVACYAI_IMAGE_OCR_FAILED", "PrivacyAI OCR returned malformed text geometry.");
    }
    if (line.words != null && !Array.isArray(line.words)) {
      throw createImageError("PRIVACYAI_IMAGE_OCR_FAILED", "PrivacyAI OCR returned malformed word geometry.");
    }
    for (const word of line.words || []) {
      if (
        !word ||
        typeof word.text !== "string" ||
        !Number.isSafeInteger(word.start) ||
        !Number.isSafeInteger(word.end) ||
        word.start < 0 ||
        word.end <= word.start ||
        word.end > line.text.length ||
        !validBox(word.box)
      ) {
        throw createImageError("PRIVACYAI_IMAGE_OCR_FAILED", "PrivacyAI OCR returned malformed word geometry.");
      }
    }
  }
  return value;
}

function validBox(box) {
  return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1];
}
