const IMAGE_ERROR_CODE = /^PRIVACYAI_IMAGE_[A-Z0-9_]{1,80}$/;

export function createImageError(code, message) {
  if (!IMAGE_ERROR_CODE.test(String(code || ""))) {
    throw new TypeError("PrivacyAI image errors require a stable PRIVACYAI_IMAGE_* code.");
  }
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isImageError(error) {
  return IMAGE_ERROR_CODE.test(String(error?.code || ""));
}

export function throwIfImageAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PrivacyAI stopped image sanitization because the client disconnected.");
  error.name = "AbortError";
  error.code = "PRIVACYAI_REQUEST_ABORTED";
  throw error;
}
