import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAgyRequestBody } from "../src/agy-request-transform.js";
import { sanitizeModelVisibleArtifacts } from "../src/model-visible-artifacts.js";

function sanitizerCalls() {
  const calls = [];
  return {
    calls,
    sanitizer: async text => {
      calls.push(text);
      const originals = [...new Set(text.match(/SECRET\d+/g) || [])];
      const sessionMap = Object.fromEntries(originals.map(original => [`[PRIVATE_${original.at(-1)}]`, original]));
      let sanitizedPrompt = text;
      for (const original of originals) sanitizedPrompt = sanitizedPrompt.split(original).join(`[PRIVATE_${original.at(-1)}]`);
      return { sanitizedPrompt, sessionMap };
    }
  };
}

const slots = values => values.map((value, index) => ({ value, slotKey: `slot/${index}`, artifactKey: `artifact/${index}`, artifactType: "message" }));

test("model-visible artifacts densely batch unique values and report deterministic metrics", async () => {
  const mock = sanitizerCalls();
  const result = await sanitizeModelVisibleArtifacts(slots(Array.from({ length: 10 }, (_, index) => `SECRET${index}`)), { sanitizer: mock.sanitizer });
  assert.equal(mock.calls.length, 1);
  assert.equal(result.metrics.uniqueUncachedCount, 10);
  assert.equal(result.metrics.deduplicatedCount, 0);
  assert.equal(result.metrics.modelCallCount, 1);
  assert.equal(result.values.length, 10);
  assert.equal(result.values.every(value => value.includes("[PRIVATE_")), true);
});

test("duplicate and cached artifacts avoid repeat classification while preserving every destination", async () => {
  const mock = sanitizerCalls();
  const cache = new Map();
  const first = await sanitizeModelVisibleArtifacts(slots(["SECRET1", "SECRET1", "clean"]), { sanitizer: mock.sanitizer, cache: { get: key => cache.get(key) } });
  for (const [key, value] of first.cacheWrites) cache.set(key, value);
  const second = await sanitizeModelVisibleArtifacts(slots(["SECRET1", "SECRET1"]), { sanitizer: mock.sanitizer, cache: { get: key => cache.get(key) } });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(second.values, [first.values[0], first.values[1]]);
  assert.equal(first.metrics.uniqueUncachedCount, 2);
  assert.equal(first.metrics.deduplicatedCount, 1);
  assert.equal(second.metrics.modelCallCount, 0);
});

test("packing is deterministic, preserves adjacent items, and safely chunks large artifacts", async () => {
  const mock = sanitizerCalls();
  const values = Array.from({ length: 6 }, (_, index) => `SECRET${index}-${"x".repeat(260)}`);
  const events = [];
  const result = await sanitizeModelVisibleArtifacts(slots(values), {
    sanitizer: mock.sanitizer,
    maxContextChars: 1400,
    onArtifactComplete: event => events.push(event)
  });
  assert.equal(mock.calls.length, 2);
  assert.equal(result.metrics.modelCallCount, 2);
  assert.equal(result.values.every((value, index) =>
    value.includes("x".repeat(260)) && !value.includes(`SECRET${index}`)
  ), true);
  assert.equal(events.at(-1).packedChars, result.metrics.packedChars);

  const largeMock = sanitizerCalls();
  const large = await sanitizeModelVisibleArtifacts(
    slots([`${"a".repeat(1260)}SECRET0${"b".repeat(1800)}`]),
    { sanitizer: largeMock.sanitizer, maxContextChars: 1400 }
  );
  assert.equal(largeMock.calls.length > 1, true);
  assert.equal(large.metrics.modelCallCount, largeMock.calls.length);
  assert.equal(large.values[0].includes("SECRET0"), false);
});

test("colliding classifier placeholders are rebased per item", async () => {
  const sanitizer = async text => {
    const original = (text.match(/SECRET[12]/) || [])[0];
    return { sanitizedPrompt: text.split(original).join("[PRIVATE]"), sessionMap: { "[PRIVATE]": original } };
  };
  const result = await sanitizeModelVisibleArtifacts(
    slots([`SECRET1${"x".repeat(800)}`, `SECRET2${"x".repeat(800)}`]),
    { sanitizer, maxContextChars: 1400 }
  );
  assert.notEqual(result.values[0], result.values[1]);
  assert.equal(Object.values(result.sessionMap).sort().join(","), "SECRET1,SECRET2");
});

test("the AGY request path receives the same dense batching behavior", async () => {
  const mock = sanitizerCalls();
  const body = {
    project: "project", requestId: "request", model: "model", userAgent: "test", requestType: "generate",
    request: { sessionId: "session", contents: [
      { role: "user", parts: [{ text: "SECRET1" }] },
      { role: "user", parts: [{ text: "SECRET2" }] }
    ] }
  };
  const result = await sanitizeAgyRequestBody(body, { sanitizer: mock.sanitizer });
  assert.equal(mock.calls.length, 1);
  assert.equal(result.metrics.modelCallCount, 1);
  assert.equal(result.body.request.contents.every(content => content.parts[0].text.includes("[PRIVATE_")), true);
});
