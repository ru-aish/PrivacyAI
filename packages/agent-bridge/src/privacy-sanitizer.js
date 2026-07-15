import { createHash } from "node:crypto";

import { PrivateAI, STRICT_PRIVACY_SANITIZER_PROMPT } from "@privacy-ai/sdk";

export function createPrivacySanitizer(config, options = {}) {
  if (options.sanitizer) return options.sanitizer;

  const privacyMaxTokens = derivePrivacyMaxTokens(config, options);
  const client = new PrivateAI({
    provider: config.provider,
    model: config.model,
    privacyModel: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
    numCtx: config.numCtx,
    privacyMaxTokens,
    sanitizationMode: "strict",
    loadEnv: false
  });

  const sanitizer = async (prompt, sanitizeOptions = {}) =>
    normalizeSanitizerResult(await client.sanitize(prompt, sanitizeOptions));
  const identity = {
    boundary: "strict-agent",
    policyVersion: 3,
    model: String(config.model || ""),
    baseURL: String(config.baseURL || ""),
    promptHash: createHash("sha256").update(STRICT_PRIVACY_SANITIZER_PROMPT).digest("hex"),
    structuredIdentityConfidenceThreshold: 0.85,
    privacyMaxTokens
  };
  sanitizer.identity = {
    ...identity,
    fingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  };
  return sanitizer;
}

export function derivePrivacyMaxTokens(config = {}, options = {}) {
  if (options.privacyMaxTokens != null) {
    const explicit = Number(options.privacyMaxTokens);
    if (!Number.isSafeInteger(explicit) || explicit <= 0) {
      throw new TypeError("privacyMaxTokens must be a positive safe integer.");
    }
    return explicit;
  }
  const numCtx = normalizedContextTokens(config.numCtx);
  return Math.min(1024, Math.max(256, Math.floor(numCtx / 4)));
}

export function derivePrivacyContextMaxChars(config = {}, options = {}) {
  if (options.providerContextMaxChars != null) {
    const explicit = Number(options.providerContextMaxChars);
    if (!Number.isSafeInteger(explicit) || explicit <= 0) {
      throw new TypeError("providerContextMaxChars must be a positive safe integer.");
    }
    return explicit;
  }

  const numCtx = normalizedContextTokens(config.numCtx);
  const outputTokens = derivePrivacyMaxTokens(config, options);
  const systemAndProtocolReserve = Math.max(512, Math.floor(numCtx / 8));
  const inputTokens = Math.max(768, numCtx - outputTokens - systemAndProtocolReserve);
  // Two characters per token is deliberately conservative for code, JSON, and
  // identifiers, where the common four-character heuristic is unsafe.
  return inputTokens * 2;
}

function normalizedContextTokens(value) {
  const numCtx = Number(value || 4096);
  if (!Number.isSafeInteger(numCtx) || numCtx < 2048) {
    throw new TypeError("PrivacyAI local-model context must be at least 2048 tokens.");
  }
  return numCtx;
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
