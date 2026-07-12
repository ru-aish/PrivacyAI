import { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { OllamaProvider } from "./providers/ollama.js";
import { PrivacySanitizer } from "./sanitizer.js";
import { ContextCompactor } from "./context-compactor.js";

const DEFAULT_CONFIG = {
  apiKey: "not-required",
  baseURL: "http://127.0.0.1:11434/v1",
  model: "qwen3.5:2b",
  provider: "openai-compatible",
  timeoutMs: 60000,
  numCtx: 4096,
  localDetectorEnabled: false,
  sanitizationMode: "browser"
};

export class BrowserPrivateAI {
  constructor(options = {}) {
    const config = { ...DEFAULT_CONFIG, ...options };
    this.config = config;
    this.provider = isProviderObject(options.provider) ? options.provider : createProvider(config);
    this.sanitizer =
      options.sanitizer ||
      new PrivacySanitizer({
        ...config,
        provider: this.provider
      });
    this.compactor = options.compactor || new ContextCompactor({
      ...config,
      provider: this.provider
    });
  }

  async sanitize(prompt, options = {}) {
    return this.sanitizer.sanitize(prompt, options);
  }
}

export function createBrowserClient(options = {}) {
  return new BrowserPrivateAI(options);
}

function createProvider(config) {
  if (config.provider === "ollama") {
    return new OllamaProvider(config);
  }
  if (config.provider === "lm-studio" || config.provider === "openai-compatible") {
    return new OpenAICompatibleProvider(config);
  }
  throw new TypeError(`Unsupported PrivateAI provider: ${config.provider}`);
}

function isProviderObject(provider) {
  return provider && typeof provider === "object" && typeof provider.chat === "function";
}