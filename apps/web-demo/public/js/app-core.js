export const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function validateImageFile(file, options = {}) {
  if (!file) return "Choose an image first.";
  const supportedTypes = options.supportedTypes || SUPPORTED_IMAGE_TYPES;
  const maxBytes = Number(options.maxBytes || MAX_IMAGE_BYTES);
  if (!supportedTypes.has(String(file.type || ""))) return "Use a PNG, JPEG, or WebP image.";
  if (!Number.isFinite(file.size) || file.size <= 0) return "The selected image is empty.";
  if (file.size > maxBytes) return `The selected image is larger than ${formatBytes(maxBytes)}.`;
  return null;
}

export function buildImagePayload(message, imageDataUrl) {
  const prompt = String(message || "").trim();
  if (!prompt) throw new Error("Enter the prompt that would accompany this image.");
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    throw new Error("Choose an image before running the preview.");
  }
  return { message: prompt, image_data_url: imageDataUrl };
}

export function normalizeImagePreviewResponse(data, originalImageUrl) {
  if (!data || data.status !== "success") throw new Error(data?.error || "Image sanitization failed.");
  if (typeof data.sanitized_message !== "string") {
    throw new Error("The server returned an invalid sanitized prompt.");
  }
  if (typeof data.sanitized_image_url !== "string" || !data.sanitized_image_url.startsWith("data:image/")) {
    throw new Error("The server returned an invalid sanitized image.");
  }
  return {
    originalPrompt: String(data.original_message || ""),
    sanitizedPrompt: data.sanitized_message,
    originalImageUrl,
    sanitizedImageUrl: data.sanitized_image_url,
    imageChanged: Boolean(data.image_changed),
    promptChanged: Boolean(data.prompt_changed),
    privacyItems: Array.isArray(data.privacy_items_detected) ? data.privacy_items_detected : [],
    detectedLineCount: Number(data.image_stats?.detected_line_count || 0),
    protectedRegionCount: Number(data.image_stats?.protected_region_count || 0),
    maskStrategy: String(data.image_stats?.mask_strategy || "none"),
    verificationAttempts: Number(data.image_stats?.verification_attempts || 0)
  };
}

export async function copyPromptToClipboard({
  text,
  clipboard,
  button,
  copiedLabel = "Copied",
  resetDelayMs = 1200,
  setTimeoutFn = setTimeout
} = {}) {
  const prompt = String(text || "");
  if (!prompt) return false;
  if (typeof clipboard?.writeText !== "function") return false;
  try {
    await clipboard.writeText(prompt);
  } catch {
    return false;
  }
  if (button) {
    const originalLabel = button.textContent;
    button.textContent = copiedLabel;
    setTimeoutFn(() => {
      button.textContent = originalLabel;
    }, resetDelayMs);
  }
  return true;
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
