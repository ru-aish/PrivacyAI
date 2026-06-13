import { ProviderError } from "../errors.js";
import { normalizeBaseURL } from "../config.js";
import { getFetch } from "../fetch.js";

export class OllamaProvider {
  constructor(options = {}) {
    this.baseURL = normalizeOllamaBaseURL(options.baseURL || "http://127.0.0.1:11434");
    this.model = options.model || "qwen3.5:2b";
    this.timeoutMs = options.timeoutMs || 60000;
    this.numCtx = options.numCtx || 4096;
    this.think = options.think ?? false;
    this.fetch = getFetch(options.fetch);

    if (!this.fetch) {
      throw new ProviderError("A fetch implementation is required. Use Node 18+ or pass fetch.");
    }
  }

  async chat(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(`${this.baseURL}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: request.model || this.model,
          messages: request.messages,
          stream: false,
          think: request.think ?? this.think,
          options: {
            temperature: request.temperature ?? 0.2,
            num_predict: request.maxTokens,
            num_ctx: request.numCtx || this.numCtx
          }
        }),
        signal: controller.signal
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new ProviderError(`Ollama returned HTTP ${response.status}`, bodyText);
      }

      let body;
      try {
        body = JSON.parse(bodyText);
      } catch (error) {
        throw new ProviderError("Ollama returned non-JSON response.", { bodyText, error });
      }

      const text = body?.message?.content;
      if (typeof text !== "string") {
        throw new ProviderError("Ollama response did not include message.content.", body);
      }

      return {
        text,
        raw: body,
        provider: {
          baseURL: this.baseURL,
          model: request.model || this.model,
          type: "ollama"
        }
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new ProviderError(`Ollama request timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Ollama request failed.", error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeOllamaBaseURL(baseURL) {
  const normalized = normalizeBaseURL(baseURL);
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}
