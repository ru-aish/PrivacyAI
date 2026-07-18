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
  assert.equal(first.metrics.uncachedSlotCount, 3);
  assert.equal(first.metrics.deduplicatedCount, 1);
  assert.equal(second.metrics.modelCallCount, 0);
  assert.equal(second.metrics.cacheHitCount, 2);
  assert.equal(second.metrics.deduplicatedCount, 0);
});

test("values-only structured slots preserve object keys and use distinct cache identities", async () => {
  const calls = [];
  const sanitizer = async text => {
    calls.push(text);
    let sanitizedPrompt = text;
    const sessionMap = {};
    if (text.includes("cell_id")) {
      sanitizedPrompt = sanitizedPrompt.replaceAll("cell_id", "[PRIVATE_VALUE_9]");
      sessionMap["[PRIVATE_VALUE_9]"] = "cell_id";
    }
    if (text.includes("SECRET1")) {
      sanitizedPrompt = sanitizedPrompt.replaceAll("SECRET1", "[PRIVATE_1]");
      sessionMap["[PRIVATE_1]"] = "SECRET1";
    }
    return { sanitizedPrompt, sessionMap };
  };
  const cache = new Map();
  const structured = {
    value: { cell_id: "3", note: "SECRET1" },
    slotKey: "arguments/0",
    artifactKey: "arguments/0",
    artifactType: "message",
    sanitizeObjectKeys: false
  };

  const first = await sanitizeModelVisibleArtifacts([structured], {
    sanitizer,
    cache: { get: key => cache.get(key) }
  });
  for (const [key, value] of first.cacheWrites) cache.set(key, value);

  assert.equal(calls.some(text => text.includes("cell_id")), false);
  assert.deepEqual(first.values[0], { cell_id: "3", note: "[PRIVATE_1]" });
  assert.equal(Object.values(first.sessionMap).includes("cell_id"), false);

  const second = await sanitizeModelVisibleArtifacts([
    { ...structured, sanitizeObjectKeys: true }
  ], {
    sanitizer,
    cache: { get: key => cache.get(key) }
  });

  assert.equal(calls.some(text => text.includes("cell_id")), true);
  assert.equal(Object.hasOwn(second.values[0], "[PRIVATE_VALUE_9]"), true);
  assert.equal(second.metrics.cacheHitCount, 0);
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

test("identical uncached content is classified once across artifact types", async () => {
  const mock = sanitizerCalls();
  const result = await sanitizeModelVisibleArtifacts([
    {
      value: "SECRET1",
      slotKey: "message/0",
      artifactKey: "message/0",
      artifactType: "message"
    },
    {
      value: "SECRET1",
      slotKey: "tool/0",
      artifactKey: "tool/0",
      artifactType: "tool_definition"
    }
  ], { sanitizer: mock.sanitizer });

  assert.equal(mock.calls.length, 1);
  assert.equal(result.metrics.uniqueUncachedCount, 1);
  assert.equal(result.metrics.uncachedSlotCount, 2);
  assert.equal(result.metrics.deduplicatedCount, 1);
  assert.equal(result.cacheWrites.length, 2);
  assert.equal(new Set(result.cacheWrites.map(([key]) => key)).size, 2);
  assert.deepEqual(result.values, ["[PRIVATE_1]", "[PRIVATE_1]"]);
});
