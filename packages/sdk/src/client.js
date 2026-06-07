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
    const messages = buildTaskMessages(sanitized.sanitizedText, options);
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

function buildTaskMessages(sanitizedPrompt, options) {
  const messages = [{ role: "user", content: sanitizedPrompt }];

  if (options.system) {
    messages.unshift({ role: "system", content: options.system });
  }

  return messages;
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