import sharp from "sharp";

import { createImageError } from "./errors.js";

const SUPPORTED_MIME_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"]
]);
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 40_000_000;
const DEFAULT_MAX_DIMENSION = 12_000;
const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;

export async function decodeImageDataUrl(value, options = {}) {
  if (typeof value !== "string") {
    throw createImageError("PRIVACYAI_IMAGE_INVALID", "PrivacyAI requires an image data URL.");
  }
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) {
    throw createImageError(
      "PRIVACYAI_IMAGE_UNSUPPORTED_URL",
      "PrivacyAI accepts only base64 PNG, JPEG, or WebP image data URLs."
    );
  }

  const [, mimeType, encoded] = match;
  if (!encoded || encoded.length % 4 !== 0) {
    throw createImageError("PRIVACYAI_IMAGE_INVALID_BASE64", "PrivacyAI blocked malformed image base64.");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.toString("base64") !== encoded) {
    throw createImageError("PRIVACYAI_IMAGE_INVALID_BASE64", "PrivacyAI blocked non-canonical image base64.");
  }

  const maxBytes = positiveLimit(options.maxImageBytes, DEFAULT_MAX_BYTES, "maxImageBytes");
  if (buffer.length > maxBytes) {
    throw createImageError("PRIVACYAI_IMAGE_TOO_LARGE", "PrivacyAI blocked an image above the decoded-byte limit.");
  }

  let metadata;
  try {
    metadata = await sharp(buffer, { animated: true, limitInputPixels: false }).metadata();
  } catch {
    throw createImageError("PRIVACYAI_IMAGE_INVALID", "PrivacyAI could not decode the supplied image.");
  }

  const expectedFormat = SUPPORTED_MIME_TYPES.get(mimeType);
  if (metadata.format !== expectedFormat) {
    throw createImageError(
      "PRIVACYAI_IMAGE_MIME_MISMATCH",
      "PrivacyAI blocked an image whose bytes do not match its MIME type."
    );
  }
  if ((metadata.pages || 1) !== 1) {
    throw createImageError(
      "PRIVACYAI_IMAGE_ANIMATED",
      "PrivacyAI does not support animated or multi-page images."
    );
  }

  const width = metadata.width;
  const height = metadata.pageHeight || metadata.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw createImageError("PRIVACYAI_IMAGE_INVALID", "PrivacyAI blocked an image without valid dimensions.");
  }

  const maxDimension = positiveLimit(options.maxImageDimension, DEFAULT_MAX_DIMENSION, "maxImageDimension");
  const maxPixels = positiveLimit(options.maxImagePixels, DEFAULT_MAX_PIXELS, "maxImagePixels");
  if (width > maxDimension || height > maxDimension || width * height > maxPixels) {
    throw createImageError(
      "PRIVACYAI_IMAGE_TOO_LARGE",
      "PrivacyAI blocked an image above the dimension or pixel limit."
    );
  }

  return { buffer, mimeType, width, height };
}

export async function normalizeImage(buffer) {
  return sharp(buffer, { limitInputPixels: false })
    .rotate()
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
}

export function encodePngDataUrl(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createImageError("PRIVACYAI_IMAGE_RENDER_FAILED", "PrivacyAI did not receive a rendered image buffer.");
  }
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function positiveLimit(value, fallback, name) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}
