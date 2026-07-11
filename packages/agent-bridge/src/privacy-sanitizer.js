import { PrivateAI } from "@privacy-ai/sdk";

export function createPrivacySanitizer(config, options = {}) {
  if (options.sanitizer) return options.sanitizer;

  const client = new PrivateAI({
    provider: config.provider,
    model: config.model,
    privacyModel: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    numCtx: config.numCtx,
    loadEnv: false
  });

  return async prompt => normalizeSanitizerResult(await client.sanitize(prompt));
}

export function normalizeSanitizerResult(result) {
  if (!result || typeof result !== "object") {
    throw new TypeError("PrivacyAI sanitizer returned an invalid result.");
  }

  const sanitizedPrompt = result.sanitizedText ?? result.safe_prompt;
  const sessionMap = result.sessionMap ?? result.session_map ?? {};
  if (typeof sanitizedPrompt !== "string") {
    throw new TypeError("PrivacyAI sanitizer did not return sanitized text.");
  }

  return { sanitizedPrompt, sessionMap };
}
