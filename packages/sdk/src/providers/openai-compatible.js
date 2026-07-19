import { ProviderError } from "../errors.js";
import { normalizeBaseURL } from "../config.js";
import { getFetch } from "../fetch.js";
import { createProviderAbortContext, providerCancellationError } from "./abort.js";

export class OpenAICompatibleProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "not-required";
    this.baseURL = normalizeBaseURL(options.baseURL || "http://127.0.0.1:11434/v1");
    this.model = options.model || "qwen3.5:2b";
    this.timeoutMs = options.timeoutMs || 60000;
    this.fetch = getFetch(options.fetch);

    if (!this.fetch) {
      throw new ProviderError("A fetch implementation is required. Use Node 18+ or pass fetch.");
    }
  }

  async resolveModel(requestedModel, signal) {
    const targetModel = requestedModel || this.model;
    if (targetModel && targetModel !== "local-model") {
      return targetModel;
    }

    try {
      const res = await this.fetch(`${this.baseURL}/models`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`
        },
        signal
      });
      if (res.ok) {
        const json = await res.json();
        if (json && json.data && json.data.length > 0) {
          const firstModel = json.data[0].id;
          console.log(`OpenAICompatibleProvider: resolved "local-model" to "${firstModel}"`);
          return firstModel;
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn("OpenAICompatibleProvider: failed to auto-resolve model via /models", e);
    }

    return targetModel;
  }

  async chat(request) {
    const abortContext = createProviderAbortContext(request.signal, this.timeoutMs);

    try {
      const resolvedModel = await this.resolveModel(request.model || this.model, abortContext.signal);

      const response = await this.fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: request.messages,
          temperature: request.temperature ?? 0.2,
          max_tokens: request.maxTokens,
          stream: false
        }),
        signal: abortContext.signal
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new ProviderError(`Provider returned HTTP ${response.status}`, {
          status: response.status,
          bodyText
        });
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
      if (abortContext.externallyAborted()) {
        throw providerCancellationError(ProviderError, abortContext.externalReason());
      }
      if (abortContext.didTimeout() || error.name === "AbortError") {
        throw new ProviderError(`Provider request timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Provider request failed.", error);
    } finally {
      abortContext.cleanup();
    }
  }
}
