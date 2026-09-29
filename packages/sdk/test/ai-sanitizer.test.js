import test from "node:test";
import assert from "node:assert/strict";
import { AiSanitizer, parseSanitizerSpans } from "../src/ai-sanitizer.js";
import { createDetectorPipeline } from "../src/detectors/index.js";
import { redact } from "../src/redactor.js";
import { sanitizeKnownText } from "../src/session-map.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { OllamaProvider } from "../src/providers/ollama.js";

test("falls back to regex redaction when local AI JSON is invalid", async () => {
  const provider = {
    async chat() {
      return { text: "not json", raw: {}, provider: {} };
    }
  };

  const sanitizer = new AiSanitizer({ provider, loadEnv: false, model: "mock-model" });
  const result = await sanitizer.sanitize("Contact john.smith@example.com");

  const expected = redact("Contact john.smith@example.com", await createDetectorPipeline().detect("Contact john.smith@example.com"));
  assert.equal(result.sanitizedText, expected.sanitizedText);
  assert.equal(result.privacySource, "regex-fallback");
});

test("strict sanitizer accepts compact exact-span output without reproducing the prompt", async () => {
  const original = "Contact Private Person at private.person@example.test";
  const provider = {
    async chat() {
      return {
        text: JSON.stringify({
          spans: [
            { value: "Private Person", type: "PERSON" },
            { value: "private.person@example.test", type: "EMAIL" }
          ]
        }),
        raw: {},
        provider: {}
      };
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);
  assert.equal(result.privacySource, "ai-span-sanitizer");
  assert.equal(result.sanitizedText.includes("Private Person"), false);
  assert.equal(result.sanitizedText.includes("private.person@example.test"), false);
});

test("strict sanitizer retries once with a larger output only after explicit truncation", async () => {
  const requested = [];
  const provider = {
    async chat(request) {
      requested.push(request.maxTokens);
      return {
        text: JSON.stringify({ spans: [{ value: "secret@example.test", type: "EMAIL" }] }),
        raw: { done_reason: "length" },
        provider: {}
      };
    }
  };
  const result = await new AiSanitizer({ provider, privacyMaxTokens: 256 }).sanitize("secret@example.test");
  assert.deepEqual(requested, [256, 512]);
  assert.equal(result.sanitizedText.includes("secret@example.test"), false);
});

test("strict sanitizer does not increase its output budget for malformed output", async () => {
  const requested = [];
  const provider = {
    async chat(request) {
      requested.push(request.maxTokens);
      return { text: "not json", raw: { done_reason: "stop" }, provider: {} };
    }
  };
  await new AiSanitizer({ provider, privacyMaxTokens: 256 }).sanitize("safe input");
  assert.deepEqual(requested, [256, 256], "the normal repair may retry, but never with a larger budget");
});

test("AiSanitizer bounds concurrent local-model calls and removes cancelled queued work", async () => {
  const started = [];
  const releases = [];
  const provider = {
    chat(request) {
      started.push(request.messages.at(-1).content);
      return new Promise(resolve => releases.push(() => resolve({
        text: JSON.stringify({ spans: [] }), raw: { done_reason: "stop" }, provider: {}
      })));
    }
  };
  const sanitizer = new AiSanitizer({ provider, classifierConcurrency: 1 });
  const first = sanitizer.sanitize("first");
  const controller = new AbortController();
  const cancelled = sanitizer.sanitize("cancelled", { signal: controller.signal });
  const third = sanitizer.sanitize("third");

  await settle();
  assert.deepEqual(started, ["first"]);
  const cancellation = Object.assign(new Error("cancelled"), { code: "PRIVACYAI_REQUEST_ABORTED" });
  controller.abort(cancellation);
  await assert.rejects(cancelled, error => error === cancellation);
  releases.shift()();
  await first;
  await settle();
  assert.deepEqual(started, ["first", "third"]);
  releases.shift()();
  await third;
});

test("Ollama retains the model and falls back from 8192 to 6144 only for memory errors", async () => {
  const bodies = [];
  const provider = new OllamaProvider({
    fetch: async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      if (bodies.length === 1) return new Response("requires more system memory", { status: 500 });
      return new Response(JSON.stringify({ message: { content: "ok" }, done_reason: "stop" }), { status: 200 });
    }
  });
  const result = await provider.chat({ messages: [{ role: "user", content: "test" }] });
  await provider.chat({ messages: [{ role: "user", content: "test again" }] });
  assert.equal(result.text, "ok");
  assert.deepEqual(bodies.map(body => body.options.num_ctx), [8192, 6144, 6144]);
  assert.equal(bodies[0].keep_alive, "10m");
});

test("Ollama does not lower an explicit context or retry non-memory failures", async () => {
  const bodies = [];
  const provider = new OllamaProvider({
    fetch: async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return new Response("upstream unavailable", { status: 503 });
    }
  });
  await assert.rejects(
    provider.chat({ messages: [], numCtx: 4096 }),
    /HTTP 503/
  );
  assert.deepEqual(bodies.map(body => body.options.num_ctx), [4096]);
});

test("Ollama validates local-model limits instead of silently accepting invalid values", () => {
  assert.throws(() => new OllamaProvider({ numCtx: 0, fetch: async () => {} }), /Local-model context/);
  assert.throws(() => new OllamaProvider({ keepAlive: "forever", fetch: async () => {} }), /keepAlive/);
  assert.doesNotThrow(() => new OllamaProvider({ numCtx: 4096, fetch: async () => {} }));
});

test("span parser rejects values that are not exact input substrings", () => {
  assert.equal(
    parseSanitizerSpans(
      JSON.stringify({ spans: [{ value: "invented@example.test", type: "EMAIL" }] }),
      "Public input"
    ),
    null
  );
});

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

test("strict fallback ignores low-confidence capitalized documentation phrases", async () => {
  const provider = {
    async chat() {
      return { text: "not-json", raw: {}, provider: {} };
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const documentation = "Output Schema\nGeneral Rules\nRequest Metadata";
  const clean = await sanitizer.sanitize(documentation, { identityConfidenceThreshold: 0.85 });
  assert.equal(clean.sanitizedText, documentation);

  const contextual = await sanitizer.sanitize("my name is John Doe");
  assert.equal(contextual.sanitizedText.includes("John Doe"), false);
});


test("span parser rejects unsupported model-defined types", () => {
  assert.equal(
    parseSanitizerSpans(
      JSON.stringify({ spans: [{ value: "private-value", type: "MODEL_INVENTED_TYPE" }] }),
      "private-value"
    ),
    null
  );
});

test("strict exact spans redact password aliases even inside protected code text", async () => {
  const secret = "CustomerSecretValue123";
  const original = `Use \`${secret}\` for the local test.`;
  const provider = {
    async chat() {
      return {
        text: JSON.stringify({ spans: [{ value: secret, type: "PASSWORD" }] }),
        raw: {},
        provider: {}
      };
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);

  assert.equal(result.privacySource, "ai-span-sanitizer");
  assert.equal(result.sanitizedText.includes(secret), false);
  assert.equal(Object.values(result.sessionMap).includes(secret), true);
});


test("strict sanitizer output is exactly reconstructible from one canonical placeholder per original", async () => {
  const original = [
    "Alex Morgan owns shared.private@example.test.",
    "Contact Alex Morgan again at shared.private@example.test."
  ].join("\n");
  const provider = {
    async chat() {
      return {
        text: JSON.stringify({
          spans: [
            { value: "Alex Morgan", type: "PERSON" },
            { value: "Alex Morgan", type: "PRIVATE_IDENTIFIER" },
            { value: "shared.private@example.test", type: "EMAIL" },
            { value: "shared.private@example.test", type: "PRIVATE_IDENTIFIER" }
          ]
        }),
        raw: {},
        provider: {}
      };
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);

  assert.equal(result.sanitizedText, sanitizeKnownText(original, result.sessionMap));
  assert.equal(
    new Set(Object.values(result.sessionMap).map(value => value.toLowerCase())).size,
    Object.keys(result.sessionMap).length
  );
  assert.equal(result.sanitizedText.includes("Alex Morgan"), false);
  assert.equal(result.sanitizedText.includes("shared.private@example.test"), false);
});

for (const [name, Provider, config] of [
  ["OpenAI-compatible", OpenAICompatibleProvider, { baseURL: "http://127.0.0.1:1234/v1" }],
  ["Ollama", OllamaProvider, { baseURL: "http://127.0.0.1:11434" }]
]) {
  test(`${name} provider aborts its local HTTP request when PrivacyAI is cancelled`, async () => {
    const controller = new AbortController();
    const provider = new Provider({
      ...config,
      model: "test-model",
      timeoutMs: 5000,
      fetch: async (_url, options = {}) => new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error("fetch aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      })
    });

    const pending = provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "test" }],
      signal: controller.signal
    });
    const reason = new Error("Codex client disconnected");
    reason.code = "PRIVACYAI_CODEX_CLIENT_DISCONNECTED";
    controller.abort(reason);

    await assert.rejects(
      pending,
      error =>
        error?.code === "PRIVACYAI_CODEX_CLIENT_DISCONNECTED" &&
        !error.message.includes("timed out")
    );
  });
}

test("strict sanitizer propagates cancellation during a repair request", async () => {
  const controller = new AbortController();
  let calls = 0;
  let markRepairStarted;
  const repairStarted = new Promise(resolve => {
    markRepairStarted = resolve;
  });
  const provider = {
    async chat(request) {
      calls += 1;
      if (calls === 1) return { text: "not-json", raw: {}, provider: {} };
      markRepairStarted();
      return new Promise((resolve, reject) => {
        const abort = () => reject(request.signal?.reason || new Error("repair aborted"));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  };
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const pending = sanitizer.sanitize("Contact private.person@example.test", {
    signal: controller.signal
  });

  await repairStarted;
  const reason = new Error("Codex client disconnected");
  reason.code = "PRIVACYAI_CODEX_CLIENT_DISCONNECTED";
  controller.abort(reason);

  await assert.rejects(
    pending,
    error => error?.code === "PRIVACYAI_CODEX_CLIENT_DISCONNECTED"
  );
});
