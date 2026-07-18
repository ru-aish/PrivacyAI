import { ProviderError } from "../errors.js";
import { normalizeBaseURL } from "../config.js";
import { getFetch } from "../fetch.js";
import {
  DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS,
  normalizeLocalModelContextTokens,
  normalizeOllamaKeepAlive
} from "../local-model-policy.js";
import { createProviderAbortContext, providerCancellationError } from "./abort.js";

export class OllamaProvider {
  constructor(options = {}) {
    this.baseURL = normalizeOllamaBaseURL(options.baseURL || "http://127.0.0.1:11434");
    this.model = options.model || "qwen3.5:2b";
    this.timeoutMs = options.timeoutMs || 60000;
    this.numCtx = normalizeLocalModelContextTokens(
      options.numCtx,
      DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS
    );
    const hasExplicitFallback = options.fallbackNumCtx != null;
    this.fallbackNumCtx = normalizeLocalModelContextTokens(
      options.fallbackNumCtx,
      Math.min(OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS, this.numCtx)
    );
    if (hasExplicitFallback && this.fallbackNumCtx >= this.numCtx) {
      throw new TypeError("Ollama fallbackNumCtx must be smaller than numCtx.");
    }
    this.activeNumCtx = this.numCtx;
    this.keepAlive = normalizeOllamaKeepAlive(options.keepAlive, DEFAULT_OLLAMA_KEEP_ALIVE);
    this.think = options.think ?? false;
    this.fetch = getFetch(options.fetch);

    if (!this.fetch) {
      throw new ProviderError("A fetch implementation is required. Use Node 18+ or pass fetch.");
    }
  }

  async chat(request = {}) {
    const explicitContext = request.numCtx != null;
    const requestedContext = explicitContext
      ? normalizeLocalModelContextTokens(request.numCtx)
      : this.activeNumCtx;

    try {
      return await this.chatWithContext(request, requestedContext);
    } catch (error) {
      if (
        explicitContext ||
        !isOllamaMemoryError(error) ||
        requestedContext <= this.fallbackNumCtx
      ) {
        throw error;
      }

      const response = await this.chatWithContext(request, this.fallbackNumCtx);
      // Activate the smaller runner only after a successful retry. This keeps
      // subsequent calls stable without hiding a failed fallback.
      this.activeNumCtx = this.fallbackNumCtx;
      return response;
    }
  }

  async chatWithContext(request, numCtx) {
    const abortContext = createProviderAbortContext(request.signal, this.timeoutMs);

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
            num_ctx: numCtx
          },
          keep_alive: normalizeOllamaKeepAlive(request.keepAlive, this.keepAlive)
        }),
        signal: abortContext.signal
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw new ProviderError(`Ollama returned HTTP ${response.status}`, {
          status: response.status,
          bodyText
        });
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
          type: "ollama",
          numCtx
        }
      };
    } catch (error) {
      if (abortContext.externallyAborted()) {
        throw providerCancellationError(ProviderError, abortContext.externalReason());
      }
      if (abortContext.didTimeout() || error.name === "AbortError") {
        throw new ProviderError(`Ollama request timed out after ${this.timeoutMs}ms.`);
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Ollama request failed.", error);
    } finally {
      abortContext.cleanup();
    }
  }
}

function isOllamaMemoryError(error) {
  if (!(error instanceof ProviderError)) return false;
  const status = Number(error.details?.status);
  if (Number.isInteger(status) && status < 500) return false;
  const text = `${error.message || ""}\n${error.details?.bodyText || ""}`;
  return /(?:not enough (?:system )?memory|requires more system memory|out of memory|failed to allocate|memory allocation failed|insufficient (?:system )?memory)/i.test(text);
}

function normalizeOllamaBaseURL(baseURL) {
  const normalized = normalizeBaseURL(baseURL);
  return normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
}
