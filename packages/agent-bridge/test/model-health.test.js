import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "@privacy-ai/sdk";
import {
  checkPrivacyModel,
  privacyModelHealthError
} from "../src/model-health.js";

const OLLAMA_CONFIG = {
  provider: "ollama",
  model: "ministral-3:3b",
  baseURL: "http://127.0.0.1:11434",
  apiKey: "not-required",
  timeoutMs: 60000,
  numCtx: 4096
};

const LM_STUDIO_CONFIG = {
  provider: "lm-studio",
  model: "mistralai/ministral-3-3b",
  baseURL: "http://127.0.0.1:1234/v1",
  apiKey: "not-required",
  timeoutMs: 180000,
  numCtx: 4096
};

test("model health warms Ollama with a fixed public sanitizer canary", async () => {
  const requests = [];
  const health = await checkPrivacyModel(OLLAMA_CONFIG, {
    probeCompletion: true,
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.endsWith("/api/tags")) {
        return jsonResponse({ models: [{ name: OLLAMA_CONFIG.model }] });
      }
      assert.equal(url, "http://127.0.0.1:11434/api/chat");
      const body = JSON.parse(init.body);
      const canary = body.messages.at(-1).content;
      assert.match(canary, /^PrivacyAI local readiness canary\./);
      assert.equal(canary.includes("private@example.test"), false);
      return jsonResponse({ message: { content: '{"spans":[]}' } });
    }
  });

  assert.deepEqual(health, { ok: true, discovered: true, warmed: true, attempts: 1 });
  assert.equal(requests.length, 2);
});

test("model health retries transient warm-up failures including an explicit loading HTTP 400", async () => {
  let attempts = 0;
  const health = await checkPrivacyModel(LM_STUDIO_CONFIG, {
    probeCompletion: true,
    fetch: async url => {
      assert.equal(url, `${LM_STUDIO_CONFIG.baseURL}/models`);
      return jsonResponse({ data: [{ id: LM_STUDIO_CONFIG.model }] });
    },
    sanitizer: async () => {
      attempts += 1;
      if (attempts === 1) throw new ProviderError("Provider returned HTTP 503", "temporarily unavailable");
      if (attempts === 2) throw new ProviderError("Provider returned HTTP 400", "model is loading");
      return { sanitizedPrompt: "public canary", sessionMap: {} };
    },
    retryDelayMs: 0,
    sleep: async () => {}
  });

  assert.equal(health.ok, true);
  assert.equal(health.attempts, 3);
  assert.equal(attempts, 3);
});

test("model health does not retry a terminal readiness rejection", async () => {
  let attempts = 0;
  const health = await checkPrivacyModel(LM_STUDIO_CONFIG, {
    probeCompletion: true,
    fetch: async () => jsonResponse({ data: [{ id: LM_STUDIO_CONFIG.model }] }),
    sanitizer: async () => {
      attempts += 1;
      throw new ProviderError("Provider returned HTTP 400", "invalid request schema");
    },
    retryDelayMs: 0,
    sleep: async () => {}
  });

  assert.equal(health.ok, false);
  assert.equal(health.retryable, false);
  assert.equal(health.attempts, 1);
  assert.match(health.reason, /HTTP 400/);
  assert.equal(attempts, 1);
});

test("model health does not retry malformed successful provider responses", async () => {
  let attempts = 0;
  const health = await checkPrivacyModel(LM_STUDIO_CONFIG, {
    probeCompletion: true,
    fetch: async () => jsonResponse({ data: [{ id: LM_STUDIO_CONFIG.model }] }),
    sanitizer: async () => {
      attempts += 1;
      throw new ProviderError("Provider returned non-JSON response.", "not-json");
    },
    retryDelayMs: 0,
    sleep: async () => {}
  });

  assert.equal(health.ok, false);
  assert.equal(health.retryable, false);
  assert.equal(health.attempts, 1);
  assert.equal(attempts, 1);
});

test("model health fails unavailable models before invoking the readiness canary", async () => {
  let sanitizerCalls = 0;
  const health = await checkPrivacyModel(OLLAMA_CONFIG, {
    probeCompletion: true,
    fetch: async () => jsonResponse({ models: [{ name: "another-model" }] }),
    sanitizer: async () => {
      sanitizerCalls += 1;
      return { sanitizedPrompt: "unexpected", sessionMap: {} };
    }
  });

  assert.equal(health.ok, false);
  assert.equal(health.category, "model_unavailable");
  assert.equal(health.retryable, false);
  assert.equal(sanitizerCalls, 0);
});

test("model health enforces one bounded readiness deadline", async () => {
  const health = await checkPrivacyModel(LM_STUDIO_CONFIG, {
    probeCompletion: true,
    readinessTimeoutMs: 20,
    readinessAttempts: 3,
    fetch: async () => jsonResponse({ data: [{ id: LM_STUDIO_CONFIG.model }] }),
    sanitizer: async (_text, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  });

  assert.equal(health.ok, false);
  assert.equal(health.category, "model_not_ready");
  assert.equal(health.retryable, true);
  assert.match(health.reason, /readiness deadline/);
});

test("model health errors distinguish reconfiguration from temporary readiness", () => {
  const unavailable = privacyModelHealthError({
    reason: "Configured model is missing.",
    category: "model_unavailable"
  });
  assert.equal(unavailable.code, "PRIVACYAI_MODEL_UNAVAILABLE");
  assert.match(unavailable.message, /privacyai onboard/);

  const loading = privacyModelHealthError({
    reason: "Configured model is loading.",
    category: "model_not_ready"
  });
  assert.equal(loading.code, "PRIVACYAI_MODEL_NOT_READY");
  assert.doesNotMatch(loading.message, /privacyai onboard/);
  assert.match(loading.message, /finish loading/);
});

function jsonResponse(body, options = {}) {
  return new Response(JSON.stringify(body), {
    status: options.status || 200,
    headers: { "content-type": "application/json" }
  });
}
