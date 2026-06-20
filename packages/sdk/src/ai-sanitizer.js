import { createDetectorPipeline } from "./detectors/index.js";
import { redact } from "./redactor.js";
import { PRIVACY_SANITIZER_PROMPT } from "./prompts.js";
import { PrivacyGuardianError } from "./errors.js";
import { parseSanitizerJson } from "./parser/sanitizer-json.js";
import { buildSanitizerMessages } from "./prompt-messages.js";
import { enforceSafeResult } from "./enforcement/enforce-safe-result.js";
import { normalizeSanitizerResult } from "./sanitizer-result.js";

export { parseSanitizerJson } from "./parser/sanitizer-json.js";

export class AiSanitizer {
  constructor(options = {}) {
    if (!options.provider || typeof options.provider.chat !== "function") {
      throw new PrivacyGuardianError("AiSanitizer requires a provider with chat().");
    }

    this.provider = options.provider;
    this.model = options.privacyModel || options.model;
    this.systemPrompt = options.privacySystemPrompt || PRIVACY_SANITIZER_PROMPT;
    this.privacyMaxTokens = options.privacyMaxTokens;
    this.fallbackDetector = createDetectorPipeline({ ...options, localDetectorEnabled: false });
  }

  async sanitize(text, options = {}) {
    if (typeof text !== "string") {
      throw new TypeError("AiSanitizer.sanitize expects a string prompt.");
    }

    const messages = buildSanitizerMessages({
      systemPrompt: this.systemPrompt,
      text: text,
      context: options.context
    });

    const response = await this.provider.chat({
      model: this.model,
      messages: messages,
      temperature: 0,
      maxTokens: optionsMaxTokens(this)
    });

    const parsed = parseSanitizerJson(response.text);
    if (parsed) {
      const enforced = await enforceSafeResult(text, parsed, this.fallbackDetector);
      return normalizeSanitizerResult(text, enforced, response, "ai-sanitizer");
    }

    const detections = await this.fallbackDetector.detect(text);
    const fallback = redact(text, detections);
    return {
      ...fallback,
      privacyModelText: response.text,
      privacySource: "regex-fallback"
    };
  }
}

function optionsMaxTokens(sanitizer) {
  return sanitizer.privacyMaxTokens || 2048;
}