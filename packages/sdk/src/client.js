import { configFromEnv } from "./config.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { OllamaProvider } from "./providers/ollama.js";
import { PrivacySanitizer } from "./sanitizer.js";
import { restore } from "./redactor.js";

export class PrivateAI {
  constructor(options = {}) {
    const config = { ...configFromEnv({ loadEnv: options.loadEnv !== false }), ...options };
    this.config = config;
    this.provider = isProviderObject(options.provider) ? options.provider : createProvider(config);
    this.sanitizer =
      options.sanitizer ||
      new PrivacySanitizer({
        ...config,
        provider: this.provider
      });
  }

  static fromEnv(options = {}) {
    return new PrivateAI({ ...configFromEnv(options), ...options });
  }

  async sanitize(prompt) {
    return this.sanitizer.sanitize(prompt);
  }

  async inspect(prompt) {
    return this.sanitize(prompt);
  }

  async ask(prompt, options = {}) {
    const sanitized = await this.sanitize(prompt);
    const messages = buildMessages(sanitized.sanitizedText, options);
    const modelResponse = await this.provider.chat({
      model: options.model || this.config.model,
      messages,
      temperature: options.temperature,
      maxTokens: options.maxTokens
    });

    const finalText = options.restore === false
      ? modelResponse.text
      : restore(modelResponse.text, sanitized.sessionMap);

    return {
      ...sanitized,
      modelText: modelResponse.text,
      finalText,
      provider: modelResponse.provider,
      rawProviderResponse: modelResponse.raw
    };
  }
}

export function createClient(options = {}) {
  return new PrivateAI(options);
}

function buildMessages(sanitizedPrompt, options) {
  const system = options.system || [
    "You are a helpful assistant inside a privacy-preserving SDK.",
    "The user prompt may contain placeholders such as [EMAIL_1], [PHONE_1], or [PERSON_1].",
    "Treat placeholders as the real private values, but never invent or reveal the original private values.",
    "Preserve placeholder tokens exactly when referring to private data."
  ].join(" ");

  return [
    { role: "system", content: system },
    { role: "user", content: sanitizedPrompt }
  ];
}

function createProvider(config) {
  if (config.provider === "ollama") {
    return new OllamaProvider(config);
  }
  return new OpenAICompatibleProvider(config);
}

function isProviderObject(provider) {
  return provider && typeof provider === "object" && typeof provider.chat === "function";
}
