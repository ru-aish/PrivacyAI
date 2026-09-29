# Local privacy-model pipeline

PrivacyAI uses a moderate fixed local-model context instead of copying a model's advertised maximum. The shared default is **8192 input/output context tokens** across the SDK, browser client, onboarding, Codex, AGY, hooks, image OCR classification, model health, and startup audits. Explicit configuration is validated within a bounded operational range; PrivacyAI never automatically selects a discovered 262K context for routine extraction.

For Ollama, every chat and warm-up request includes a bounded `keep_alive` value (`10m` by default). If an 8192-token request fails with a clear local memory-allocation/capacity error, PrivacyAI retries that request once at **6144 tokens**. The smaller context becomes sticky for that provider instance only after the retry succeeds, preventing repeated runner reloads and oscillation. Network failures, ordinary HTTP failures, cancellation, malformed responses, and explicit per-request contexts never activate this fallback.

Classifier work is serialized by default (`classifierConcurrency: 1`) and is hard-capped at `2`. Queued work observes `AbortSignal`; a cancelled queued request is removed before reaching the model, while active work releases its permit exactly once after success or failure.

Structured values are packed with two independent limits:

- a hard character ceiling for memory and reconstruction safety;
- a token budget calculated with a deterministic text-aware estimator for prose, code, numbers, punctuation, whitespace, and Unicode.

Callers may provide a synchronous exact token counter. Oversized strings are divided into overlapping chunks that obey both limits, preserving the maximum accepted private-span boundary. Batch metadata reports estimated input tokens.

Persistent verification-cache lookup occurs before packing. Only uncached original artifacts are packed into larger classifier requests. Packing can combine instructions, messages, tool results, schema prose, and other model-visible text, while each original artifact retains its own completion callback, content hash, verification record, and cache entry. An all-cache-hit request performs no classifier call.

The normal privacy-model output reserve is bounded to **256–512 tokens** and defaults to **512**. PrivacyAI retries once with a larger bounded output only when provider metadata explicitly reports truncation (`finish_reason: length`, or Ollama `done_reason: length`/`max_tokens`). Malformed, policy-invalid, network, and ordinary repair failures do not receive the expanded retry.

PrivacyAI excludes embedding-only models when discovering/selecting its own classifier model and limits its own classifier concurrency. It does not control embedding models or other workloads started outside PrivacyAI. External processes can still evict the Ollama runner or create memory/swap pressure; avoiding simultaneous memory-heavy workloads remains an operational requirement.
