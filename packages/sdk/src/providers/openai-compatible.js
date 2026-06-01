import { ProviderError } from "../errors.js";
import { normalizeBaseURL } from "../config.js";

export class OpenAICompatibleProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "not-required";
    this.baseURL = normalizeBaseURL(options.baseURL || "http://127.0.0.1:11434/v1");
    this.model = options.model || "qwen3.5:2b";
    this.timeoutMs = options.timeoutMs || 60000;
    this.fetch = options.fetch || globalThis.fetch;

    if (!this.fetch) {
      throw new ProviderError("A fetch implementation is required. Use Node 18+ or pass fetch.");
    }
  }

  async chat(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: request.model || this.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens,
          stream: false
        }),
        signal: controller.signal
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new ProviderError(`Provider returned HTTP ${response.status}`, bodyText);
      }

      let body;
      try {
        body = JSON.parse(bodyText);
      } catch (error) {
        throw new ProviderError("Provider returned non-JSON response.", { bodyText, error });
      }

      const choice = body?.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== "string") {
        throw new ProviderError("Provider response did not include choices[0].message.content.", body);
      }
      if (!text && choice?.message?.reasoning && choice?.finish_reason === "length") {
        throw new ProviderError(
          "Provider returned only reasoning and no visible content. Increase maxTokens for reasoning models.",
          body
        );
      }

      return {
        text,
        raw: body,
        provider: {
          baseURL: this.baseURL,
          model: request.model || this.model
        }
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new ProviderError(`Provider request timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Provider request failed.", error);
    } finally {
      clearTimeout(timer);
    }
  }
}
