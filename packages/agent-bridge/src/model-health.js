import { createPrivacySanitizer } from "./privacy-sanitizer.js";

const READINESS_CANARY = "PrivacyAI local readiness canary. This text contains no private data.";
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function checkPrivacyModel(config, options = {}) {
  if (options.skip || process.env.PRIVACYAI_SKIP_MODEL_CHECK === "1") {
    return { ok: true, skipped: true };
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return modelHealthFailure("Node.js does not provide fetch().", "model_not_ready", false);
  }

  const discovery = await discoverConfiguredModel(config, {
    fetch: fetchImpl,
    timeoutMs: positiveInteger(options.timeoutMs, 3000)
  });
  if (!discovery.ok || options.probeCompletion === false) return discovery;

  return probeConfiguredModel(config, {
    ...options,
    fetch: fetchImpl
  });
}

export function privacyModelHealthError(health) {
  const unavailable = health?.category === "model_unavailable";
  const error = new Error(
    `${health?.reason || "The local privacy model is not ready."}\n` +
      (unavailable
        ? "Run: privacyai onboard"
        : "Start or finish loading the configured local model, then retry.")
  );
  error.code = unavailable ? "PRIVACYAI_MODEL_UNAVAILABLE" : "PRIVACYAI_MODEL_NOT_READY";
  return error;
}

async function discoverConfiguredModel(config, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    if (config.provider === "ollama") {
      const baseURL = config.baseURL.replace(/\/v1$/, "");
      const response = await options.fetch(`${baseURL}/api/tags`, { signal: controller.signal });
      if (!response.ok) {
        return modelHealthFailure(
          `Ollama returned HTTP ${response.status}.`,
          "model_not_ready",
          isTransientStatus(response.status)
        );
      }
      const body = await response.json();
      const models = Array.isArray(body?.models) ? body.models : [];
      const found = models.some(item => item?.name === config.model || item?.model === config.model);
      return found
        ? { ok: true, discovered: true }
        : modelHealthFailure(`Local model ${config.model} is not downloaded.`, "model_unavailable", false);
    }

    const response = await options.fetch(`${config.baseURL}/models`, {
      headers: { authorization: `Bearer ${config.apiKey || "not-required"}` },
      signal: controller.signal
    });
    if (!response.ok) {
      return modelHealthFailure(
        `Model server returned HTTP ${response.status}.`,
        "model_not_ready",
        isTransientStatus(response.status)
      );
    }
    const body = await response.json();
    const found = Array.isArray(body?.data) && body.data.some(item => item?.id === config.model);
    return found
      ? { ok: true, discovered: true }
      : modelHealthFailure(`Local model ${config.model} is not available.`, "model_unavailable", false);
  } catch (error) {
    if (error?.name === "AbortError") {
      return modelHealthFailure("The local privacy model did not respond in time.", "model_not_ready", true);
    }
    return modelHealthFailure("The local privacy model is not reachable.", "model_not_ready", true);
  } finally {
    clearTimeout(timer);
  }
}

async function probeConfiguredModel(config, options) {
  const attempts = positiveInteger(options.readinessAttempts, 3);
  const deadlineMs = positiveInteger(
    options.readinessTimeoutMs,
    Math.min(Math.max(positiveInteger(config.timeoutMs, 60000), 10000), 30000)
  );
  const retryDelayMs = nonNegativeInteger(options.retryDelayMs, 250);
  const maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs, 2000);
  const sleep = options.sleep || defaultSleep;
  const sanitizer = options.sanitizer || (options.createSanitizer || createPrivacySanitizer)(config, {
    ...options,
    fetch: options.fetch
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let lastError;

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const result = await sanitizer(READINESS_CANARY, { signal: controller.signal });
        if (!result || typeof result.sanitizedPrompt !== "string") {
          return modelHealthFailure(
            "The local privacy model returned an invalid sanitizer result.",
            "model_not_ready",
            false,
            { attempts: attempt }
          );
        }
        return { ok: true, discovered: true, warmed: true, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) break;
        const retryable = isTransientReadinessError(error);
        if (!retryable || attempt === attempts) {
          return modelHealthFailure(
            readinessFailureReason(error, retryable),
            "model_not_ready",
            retryable,
            { attempts: attempt }
          );
        }
        const delayMs = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** (attempt - 1)));
        await sleep(delayMs);
        if (controller.signal.aborted) break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return modelHealthFailure(
    "The local privacy model did not become ready before the readiness deadline.",
    "model_not_ready",
    true,
    { attempts, causeCategory: readinessErrorCategory(lastError) }
  );
}

function readinessFailureReason(error, retryable) {
  const status = providerHttpStatus(error);
  if (status) return `The local privacy model rejected the readiness probe (HTTP ${status}).`;
  if (retryable) return "The local privacy model did not become ready after bounded retries.";
  if (error instanceof TypeError) return "The local privacy model returned an invalid sanitizer result.";
  return "The local privacy model could not complete a readiness probe.";
}

function isTransientReadinessError(error) {
  if (error?.name !== "ProviderError") return false;
  const status = providerHttpStatus(error);
  if (status != null) {
    if (TRANSIENT_HTTP_STATUSES.has(status)) return true;
    if (status !== 400) return false;
    return /(?:load(?:ing|ed)?|not\s+ready|initializ|starting|busy|temporar|unavailable)/i.test(
      providerDetailsText(error)
    );
  }

  return /(?:request failed|timed out)/i.test(String(error.message || ""));
}

function readinessErrorCategory(error) {
  const status = providerHttpStatus(error);
  if (status) return `http_${status}`;
  return error?.name === "ProviderError" ? "provider" : "unknown";
}

function providerHttpStatus(error) {
  const match = String(error?.message || "").match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function providerDetailsText(error) {
  if (typeof error?.details === "string") return error.details.slice(0, 2000);
  return "";
}

function isTransientStatus(status) {
  return TRANSIENT_HTTP_STATUSES.has(Number(status));
}

function modelHealthFailure(reason, category, retryable, details = {}) {
  return { ok: false, reason, category, retryable, ...details };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
