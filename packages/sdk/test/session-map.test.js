import assert from "node:assert/strict";
import test from "node:test";

import {
  AsyncConcurrencyLimiter,
  StreamingPlaceholderRestorer,
  assertNoProtectedOriginals,
  assertNoProtectedOriginalsInValue,
  estimatePrivacyTokens,
  findUnresolvedPlaceholders,
  normalizeSessionMap,
  rebaseSessionAdditions,
  restoreValue,
  sanitizeKnownText,
  sanitizeKnownValue,
  sanitizeStructuredValue
} from "../src/index.js";

const map = {
  "[EMAIL_1]": "alice.private@example.test",
  "[API_KEY_1]": "sk-live-local-only",
  "contact1@example.com": "भारत@example.test"
};

test("StreamingPlaceholderRestorer restores a placeholder split at every character boundary", () => {
  const text = "before [EMAIL_1] after";
  for (let index = 0; index <= text.length; index += 1) {
    const restorer = new StreamingPlaceholderRestorer(map);
    const output = restorer.push(text.slice(0, index)) + restorer.push(text.slice(index)) + restorer.flush();
    assert.equal(output, "before alice.private@example.test after", `split ${index}`);
  }
});

test("StreamingPlaceholderRestorer handles one-character chunks and shared prefixes", () => {
  const sessionMap = {
    "[PERSON_1]": "Ada",
    "[PERSON_10]": "Grace"
  };
  const restorer = new StreamingPlaceholderRestorer(sessionMap);
  let output = "";
  for (const character of "[PERSON_10] and [PERSON_1]") output += restorer.push(character);
  output += restorer.flush();
  assert.equal(output, "Grace and Ada");
});

test("StreamingPlaceholderRestorer preserves partial non-placeholder prefixes on flush", () => {
  const restorer = new StreamingPlaceholderRestorer(map);
  assert.equal(restorer.push("value [EMAIL_"), "value ");
  assert.equal(restorer.pendingLength > 0, true);
  assert.equal(restorer.flush(), "[EMAIL_");
});

test("StreamingPlaceholderRestorer accepts Unicode split across decoded string chunks", () => {
  const restorer = new StreamingPlaceholderRestorer(map);
  const output =
    restorer.push("recipient contact1@") +
    restorer.push("example.com") +
    restorer.flush();
  assert.equal(output, "recipient भारत@example.test");
});

test("rebaseSessionAdditions reuses the existing placeholder for the same original", () => {
  const result = rebaseSessionAdditions(
    "Email contact1@example.com and [EMAIL_1]",
    {
      "contact1@example.com": "alice.private@example.test",
      "[EMAIL_1]": "bob.private@example.test"
    },
    { "[PRIVATE_VALUE_7]": "alice.private@example.test" }
  );
  assert.equal(result.sanitizedText, "Email [PRIVATE_VALUE_7] and [EMAIL_1]");
  assert.deepEqual(result.sessionMap, { "[EMAIL_1]": "bob.private@example.test" });
});

test("structured value transforms preserve prototype-like keys and reject collisions", () => {
  const input = JSON.parse('{"__proto__":"[EMAIL_1]","[EMAIL_1]":"owner"}');
  const restored = restoreValue(input, map);
  assert.equal(Object.hasOwn(restored, "__proto__"), true);
  assert.equal(restored.__proto__, "alice.private@example.test");
  assert.equal(restored["alice.private@example.test"], "owner");
  assert.throws(
    () => restoreValue({ "[EMAIL_1]": 1, "alice.private@example.test": 2 }, map),
    error => error?.code === "PRIVACYAI_TRANSFORM_KEY_COLLISION"
  );
});

test("known sanitization is case-insensitive while restoration is exact", () => {
  assert.deepEqual(
    sanitizeKnownValue({ owner: "ALICE.PRIVATE@EXAMPLE.TEST" }, map),
    { owner: "[EMAIL_1]" }
  );
  assert.equal(restoreValue("[email_1]", map), "[email_1]");
});

test("known sanitization does not rewrite inside existing or newly inserted placeholders", () => {
  const overlapping = {
    "[EMAIL_8]": "owner.address@example.test",
    "[EMAIL_7]": "EMAIL",
    "[PRIVATE_VALUE_46]": "8"
  };
  assert.equal(
    sanitizeKnownText("owner.address@example.test and [EMAIL_8]", overlapping),
    "[EMAIL_8] and [EMAIL_8]"
  );

  const placeholderInsideOriginal = {
    "[EMAIL_1]": "email",
    "[TOKEN_1]": "prefix[EMAIL_1]suffix"
  };
  assert.equal(
    sanitizeKnownText("prefix[EMAIL_1]suffix and [EMAIL_1]", placeholderInsideOriginal),
    "[TOKEN_1] and [EMAIL_1]"
  );
});

test("unresolved placeholder scanning accepts safe custom pattern shapes", () => {
  assert.deepEqual(
    findUnresolvedPlaceholders("Use [EMAIL_1] and [EMAIL_2]", "\\[EMAIL_\\d+\\]"),
    ["[EMAIL_1]", "[EMAIL_2]"]
  );
  assert.deepEqual(
    findUnresolvedPlaceholders("Use [API_KEY_7]", { source: "\\[API_KEY_\\d+\\]" }),
    ["[API_KEY_7]"]
  );
  assert.deepEqual(
    findUnresolvedPlaceholders("Use [EMAIL_1]", /\[EMAIL_\d+\]/i),
    ["[EMAIL_1]"]
  );
  assert.throws(
    () => findUnresolvedPlaceholders("Use [EMAIL_1]", {}),
    /Placeholder pattern must be/
  );
});

test("sanitizeStructuredValue shields existing placeholders and rebases new collisions", async () => {
  const existing = { "[EMAIL_1]": "existing@example.test" };
  const result = await sanitizeStructuredValue(
    { text: "Keep [EMAIL_1], redact new@example.test" },
    {
      sessionMap: existing,
      sanitizer: async text => {
        assert.equal(text.includes("[EMAIL_1]"), false);
        return {
          sanitizedPrompt: text.replace("new@example.test", "[EMAIL_1]"),
          sessionMap: { "[EMAIL_1]": "new@example.test" }
        };
      }
    }
  );
  assert.deepEqual(result.value, { text: "Keep [EMAIL_1], redact [EMAIL_2]" });
  assert.deepEqual(result.sessionMapAdditions, { "[EMAIL_2]": "new@example.test" });
});

test("sanitizeStructuredValue allocates distinct boundary shields case-insensitively", async () => {
  const literalBoundary = "__privacyai_boundary_0__";
  const result = await sanitizeStructuredValue(
    { text: `${literalBoundary} and [EMAIL_1]` },
    {
      sessionMap: { "[EMAIL_1]": "existing@example.test" },
      sanitizer: async text => {
        assert.equal(text.includes("__PRIVACYAI_BOUNDARY_0___"), false);
        assert.equal(text.includes("__PRIVACYAI_BOUNDARY_1__"), true);
        return { sanitizedPrompt: text, sessionMap: {} };
      }
    }
  );

  assert.deepEqual(result.value, { text: `${literalBoundary} and [EMAIL_1]` });
});

test("sanitizeStructuredValue makes progress for short known originals", async () => {
  const result = await sanitizeStructuredValue("a", {
    sessionMap: { "[PRIVATE_VALUE_1]": "a" },
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} })
  });

  assert.equal(result.value, "[PRIVATE_VALUE_1]");
});

test("sanitizeStructuredValue ignores classifier mappings derived from reserved boundary shields", async () => {
  const existing = { "[EMAIL_1]": "existing@example.test" };
  const result = await sanitizeStructuredValue(
    { text: "Keep [EMAIL_1]" },
    {
      sessionMap: existing,
      sanitizer: async text => {
        const token = text.match(/__PRIVACYAI_BOUNDARY_\d+__/)?.[0];
        assert.ok(token, "the existing placeholder should be shielded before classification");
        return {
          sanitizedPrompt: text.replace(new RegExp(token, "gi"), "[PRIVATE_VALUE_1]"),
          sessionMap: { "[PRIVATE_VALUE_1]": token.toLocaleLowerCase("en-US") }
        };
      }
    }
  );

  assert.deepEqual(result.value, { text: "Keep [EMAIL_1]" });
  assert.deepEqual(result.sessionMapAdditions, {});
});

test("sanitizeStructuredValue rejects classifier placeholders that reuse reserved boundary shields", async () => {
  await assert.rejects(
    sanitizeStructuredValue(
      { text: "Keep [EMAIL_1], redact new@example.test" },
      {
        sessionMap: { "[EMAIL_1]": "existing@example.test" },
        sanitizer: async text => {
          const token = text.match(/__PRIVACYAI_BOUNDARY_\d+__/)?.[0];
          assert.ok(token, "the existing placeholder should be shielded before classification");
          return {
            sanitizedPrompt: text.replace("new@example.test", token),
            sessionMap: { [token]: "new@example.test" }
          };
        }
      }
    ),
    error => error?.code === "PRIVACYAI_INVALID_SANITIZED_CONTEXT"
  );
});

test("sanitizeStructuredValue recovers classifier spans that mix boundary shields with literal placeholders", async () => {
  const existing = { "[EMAIL_1]": "existing@example.test" };
  const source = { text: "Keep [EMAIL_1], redact new@example.test" };
  const result = await sanitizeStructuredValue(source, {
    sessionMap: existing,
    sanitizer: async text => {
      const token = text.match(/__PRIVACYAI_BOUNDARY_\d+__/)?.[0];
      assert.ok(token, "the existing placeholder should be shielded before classification");
      const mixedSpan = token.toLocaleLowerCase("en-US") + ", redact new@example.test";
      return {
        sanitizedPrompt: text.replace(
          token + ", redact new@example.test",
          "[PRIVATE_VALUE_1]"
        ),
        sessionMap: { "[PRIVATE_VALUE_1]": mixedSpan }
      };
    }
  });

  assert.deepEqual(result.value, { text: "Keep [PRIVATE_VALUE_1]" });
  assert.deepEqual(result.sessionMapAdditions, {
    "[PRIVATE_VALUE_1]": "[EMAIL_1], redact new@example.test"
  });
  assert.deepEqual(
    restoreValue(result.value, { ...existing, ...result.sessionMapAdditions }),
    source
  );
});

test("sanitizeStructuredValue recovers mixed boundary spans from previously protected originals", async () => {
  const existing = { "[EMAIL_1]": "existing@example.test" };
  const source = { text: "Keep existing@example.test, redact new@example.test" };
  const result = await sanitizeStructuredValue(source, {
    sessionMap: existing,
    sanitizer: async text => {
      const token = text.match(/__PRIVACYAI_BOUNDARY_\d+__/)?.[0];
      assert.ok(token, "the known original should be shielded before classification");
      const mixedSpan = token + ", redact new@example.test";
      return {
        sanitizedPrompt: text.replace(mixedSpan, "[PRIVATE_VALUE_1]"),
        sessionMap: { "[PRIVATE_VALUE_1]": mixedSpan }
      };
    }
  });

  assert.deepEqual(result.value, { text: "Keep [PRIVATE_VALUE_1]" });
  assert.deepEqual(result.sessionMapAdditions, {
    "[PRIVATE_VALUE_1]": "existing@example.test, redact new@example.test"
  });
  assert.deepEqual(
    restoreValue(result.value, { ...existing, ...result.sessionMapAdditions }),
    source
  );
});

test("sanitizeStructuredValue rejects malformed structured output and invalid limits", async () => {
  await assert.rejects(
    sanitizeStructuredValue({ private: "alice.private@example.test" }, {
      sanitizer: async () => ({ sanitizedPrompt: "not-json", sessionMap: {} })
    }),
    error => error?.code === "PRIVACYAI_INVALID_SANITIZED_CONTEXT"
  );
  await assert.rejects(
    sanitizeStructuredValue("x", {
      maxContextChars: 0,
      sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} })
    }),
    TypeError
  );
});

test("sanitizeStructuredValue chunks oversized text with overlap and catches boundary-spanning secrets", async () => {
  const secret = "boundary.secret@example.test";
  const input = "x".repeat(1260) + secret + "y".repeat(1800);
  let calls = 0;
  const result = await sanitizeStructuredValue(input, {
    maxContextChars: 1400,
    sanitizer: async text => {
      calls += 1;
      const found = text.includes(secret);
      return {
        sanitizedPrompt: found ? text.split(secret).join("[EMAIL_1]") : text,
        sessionMap: found ? { "[EMAIL_1]": secret } : {}
      };
    }
  });

  assert.equal(calls > 1, true);
  assert.equal(result.value.includes(secret), false);
  assert.equal(result.value.includes("[EMAIL_1]"), true);
  assert.equal(restoreValue(result.value, result.sessionMapAdditions), input);
});

test("provider-bound assertion never discloses protected values", () => {
  assert.throws(
    () => assertNoProtectedOriginals("alice.private@example.test", map),
    error => {
      assert.equal(error.code, "PRIVACYAI_PROVIDER_PAYLOAD_LEAK");
      assert.equal(error.message.includes("alice.private@example.test"), false);
      return true;
    }
  );
});

test("provider-bound assertion ignores protected substrings only inside known placeholders", () => {
  const overlappingMap = {
    "[PRIVATE_VALUE_5]": "VALUE_5",
    Riverdale: "dale"
  };

  assert.doesNotThrow(() =>
    assertNoProtectedOriginals("safe [PRIVATE_VALUE_5] and Riverdale", overlappingMap)
  );
  assert.throws(
    () => assertNoProtectedOriginals(
      "safe [PRIVATE_VALUE_5], Riverdale, and leaked value_5",
      overlappingMap
    ),
    error => error?.code === "PRIVACYAI_PROVIDER_PAYLOAD_LEAK" && error?.leakCount === 1
  );
  assert.throws(
    () => assertNoProtectedOriginals("Riverdale plus dale outside", overlappingMap),
    error => error?.code === "PRIVACYAI_PROVIDER_PAYLOAD_LEAK" && error?.leakCount === 1
  );
});

test("value-aware provider assertion ignores JSON literals but checks strings and keys", () => {
  const booleanMap = { "[PRIVATE_VALUE_1]": "false" };

  assert.doesNotThrow(() =>
    assertNoProtectedOriginalsInValue(
      { enabled: false, text: "[PRIVATE_VALUE_1]" },
      booleanMap
    )
  );
  assert.throws(
    () => assertNoProtectedOriginalsInValue({ text: "false" }, booleanMap),
    error => error?.code === "PRIVACYAI_PROVIDER_PAYLOAD_LEAK" && error?.leakCount === 1
  );
  assert.throws(
    () => assertNoProtectedOriginalsInValue({ false: "safe" }, booleanMap),
    error => error?.code === "PRIVACYAI_PROVIDER_PAYLOAD_LEAK" && error?.leakCount === 1
  );
});

test("normalizeSessionMap removes malformed and identity mappings", () => {
  assert.deepEqual(
    normalizeSessionMap({
      good: "private",
      same: "same",
      empty: "",
      number: 5,
      "": "value"
    }),
    { good: "private" }
  );
});

test("normalizeSessionMap rejects ambiguous case-insensitive aliases", () => {
  for (const ambiguous of [
    { "[EMAIL_1]": "first", "[email_1]": "second" },
    { "[EMAIL_1]": "Alice", "[PERSON_1]": "alice" },
    { "[EMAIL_1]": "first", "[TOKEN_1]": "[email_1]" }
  ]) {
    assert.throws(
      () => normalizeSessionMap(ambiguous),
      error =>
        error?.code === "PRIVACYAI_AMBIGUOUS_SESSION_MAP" &&
        !error.message.includes("first") &&
        !error.message.includes("Alice")
    );
  }
});

test("normalizeSessionMap rejects prototype-control placeholders", () => {
  for (const placeholder of ["__proto__", "Prototype", "CONSTRUCTOR"]) {
    const candidate = JSON.parse(JSON.stringify({ placeholder, original: "private-value" }));
    const sessionMap = Object.fromEntries([[candidate.placeholder, candidate.original]]);
    assert.throws(
      () => normalizeSessionMap(sessionMap),
      error => error?.code === "PRIVACYAI_INVALID_SESSION_MAP" &&
        !error.message.includes("private-value")
    );
  }
});

test("normalizeSessionMap permits multiple aliases for the exact same original", () => {
  assert.deepEqual(
    normalizeSessionMap({
      "[EMAIL_1]": "owner@example.test",
      "contact1@example.com": "owner@example.test"
    }),
    {
      "[EMAIL_1]": "owner@example.test",
      "contact1@example.com": "owner@example.test"
    }
  );
});


test("ordinary long numeric IDs are not mistaken for generated placeholders", () => {
  assert.deepEqual(
    findUnresolvedPlaceholders("ids: 123456 and 1700000000"),
    []
  );
  assert.deepEqual(
    findUnresolvedPlaceholders("generated ZIP-10001"),
    ["ZIP-10001"]
  );
});

test("sanitizeStructuredValue classifies private values used as object keys", async () => {
  const secretKey = "AKIA1234567890123456";
  let sawKey = false;
  const result = await sanitizeStructuredValue({ [secretKey]: "public" }, {
    sanitizer: async text => {
      sawKey ||= text.includes(secretKey);
      return {
        sanitizedPrompt: text.split(secretKey).join("[AWS_ACCESS_KEY_1]"),
        sessionMap: text.includes(secretKey)
          ? { "[AWS_ACCESS_KEY_1]": secretKey }
          : {}
      };
    }
  });

  assert.equal(sawKey, true);
  assert.equal(Object.hasOwn(result.value, secretKey), false);
  assert.equal(result.value["[AWS_ACCESS_KEY_1]"], "public");
  assert.deepEqual(result.sessionMapAdditions, {
    "[AWS_ACCESS_KEY_1]": secretKey
  });
});

test("sanitizeStructuredValue preserves protocol object keys when key sanitization is disabled", async () => {
  const privateEmail = "private-contact@example.test";
  const calls = [];
  const result = await sanitizeStructuredValue({
    cell_id: "3",
    nested: { owner: privateEmail }
  }, {
    sanitizeObjectKeys: false,
    sanitizer: async text => {
      calls.push(text);
      const found = text.includes(privateEmail);
      return {
        sanitizedPrompt: found ? text.replaceAll(privateEmail, "[EMAIL_1]") : text,
        sessionMap: found ? { "[EMAIL_1]": privateEmail } : {}
      };
    }
  });

  assert.equal(calls.some(text => text.includes("cell_id")), false);
  assert.equal(calls.some(text => text.includes("nested")), false);
  assert.equal(calls.some(text => text.includes("owner")), false);
  assert.deepEqual(result.value, {
    cell_id: "3",
    nested: { owner: "[EMAIL_1]" }
  });
  assert.deepEqual(result.sessionMapAdditions, { "[EMAIL_1]": privateEmail });
});

test("chunk overlap contains every accepted 512-character private span", async () => {
  const secret = "S".repeat(512);
  const input = "x".repeat(1420) + secret + "y".repeat(1000);
  let containingCalls = 0;
  const result = await sanitizeStructuredValue(input, {
    maxContextChars: 2048,
    sanitizer: async text => {
      const found = text.includes(secret);
      if (found) containingCalls += 1;
      return {
        sanitizedPrompt: found ? text.split(secret).join("[PRIVATE_IDENTIFIER_1]") : text,
        sessionMap: found ? { "[PRIVATE_IDENTIFIER_1]": secret } : {}
      };
    }
  });

  assert.equal(containingCalls >= 1, true);
  assert.equal(result.value.includes(secret), false);
  assert.equal(restoreValue(result.value, result.sessionMapAdditions), input);
});

test("chunk overlap protects Unicode spans with exact token counters", async () => {
  const secret = "秘".repeat(512);
  const input = "文".repeat(800) + secret + "後".repeat(900);
  const tokenCounter = text => [...text].reduce(
    (tokens, character) => tokens + (character.codePointAt(0) > 0x7f ? 2 : 1),
    0
  );
  let containingCalls = 0;
  const result = await sanitizeStructuredValue(input, {
    maxContextChars: 4096,
    maxContextTokens: 2200,
    tokenCounter,
    sanitizer: async text => {
      const found = text.includes(secret);
      if (found) containingCalls += 1;
      return {
        sanitizedPrompt: found ? text.split(secret).join("[PRIVATE_IDENTIFIER_1]") : text,
        sessionMap: found ? { "[PRIVATE_IDENTIFIER_1]": secret } : {}
      };
    }
  });

  assert.equal(containingCalls >= 1, true);
  assert.equal(result.value.includes(secret), false);
  assert.equal(restoreValue(result.value, result.sessionMapAdditions), input);
});

test("structured sanitization rejects exact-token windows without bounded overlap progress", async () => {
  const secret = "秘".repeat(512);
  const input = "文".repeat(250) + secret + "後".repeat(16000);
  const tokenCounter = text => [...text].reduce(
    (tokens, character) => tokens + (character.codePointAt(0) > 0x7f ? 2 : 1),
    0
  );

  for (const maxContextTokens of [1052, 1400]) {
    let sanitizerCalls = 0;
    await assert.rejects(
      sanitizeStructuredValue(input, {
        maxContextChars: 4096,
        maxContextTokens,
        tokenCounter,
        sanitizer: async text => {
          sanitizerCalls += 1;
          return { sanitizedPrompt: text, sessionMap: {} };
        }
      }),
      error => error?.code === "PRIVACYAI_CONTEXT_TOO_LARGE"
    );
    assert.equal(sanitizerCalls, 0);
  }
});


test("privacy token estimation is text-aware and accepts an exact synchronous counter", () => {
  const prose = estimatePrivacyTokens("ordinary prose with repeated words and spacing");
  const code = estimatePrivacyTokens("const value={token:'x',items:[1,2,3]};");
  const unicode = estimatePrivacyTokens("秘密🔐भारत");
  assert.equal(prose > 0, true);
  assert.equal(code > 0, true);
  assert.equal(unicode > 0, true);
  assert.notEqual(prose, Math.ceil("ordinary prose with repeated words and spacing".length / 2));
  assert.equal(estimatePrivacyTokens("anything", () => 7), 7);
  assert.throws(() => estimatePrivacyTokens("anything", () => -1), /tokenCounter/);
});

test("structured sanitization enforces character and token budgets and reports token metadata", async () => {
  const input = { text: "alpha beta gamma ".repeat(180) };
  const batches = [];
  const tokenCounter = text => Math.ceil([...text].length / 4);
  const result = await sanitizeStructuredValue(input, {
    maxContextChars: 1400,
    maxContextTokens: 350,
    tokenCounter,
    sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }),
    onBatchComplete: details => batches.push(details)
  });
  assert.deepEqual(result.value, input);
  assert.equal(batches.length > 1, true);
  assert.equal(batches.every(batch => batch.inputChars <= 1400), true);
  assert.equal(batches.every(batch => batch.estimatedInputTokens <= 350), true);
  assert.equal(batches.every(batch => Number.isSafeInteger(batch.estimatedInputTokens)), true);
});

test("AsyncConcurrencyLimiter caps at two and releases permits after failures", async () => {
  assert.throws(() => new AsyncConcurrencyLimiter(3), /between 1 and 2/);
  const limiter = new AsyncConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;
  const releases = [];
  const run = (label, fail = false) => limiter.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => releases.push(resolve));
    active -= 1;
    if (fail) throw new Error(label);
    return label;
  });
  const first = run("first", true);
  const second = run("second");
  const third = run("third");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 2);
  assert.equal(releases.length, 2);
  releases.shift()();
  await assert.rejects(first, /first/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2, "the queued third operation should acquire the released permit");
  releases.shift()();
  await second;
  releases.shift()();
  assert.equal(await third, "third");
  assert.equal(active, 0);
});


test("canonical session maps normalize aliases deterministically", () => {
  const original = "owner@example.test";
  const normalized = normalizeSessionMap({
    contact1: original,
    "[EMAIL_2]": original,
    "[EMAIL_1]": original
  });

  assert.deepEqual(Object.keys(normalized), ["[EMAIL_1]", "[EMAIL_2]", "contact1"]);
  assert.equal(sanitizeKnownText(original, normalized), "[EMAIL_1]");
});

test("rebaseSessionAdditions resolves folded placeholder collisions and rejects folded originals", () => {
  assert.deepEqual(
    rebaseSessionAdditions(
      "[email_1]",
      { "[email_1]": "new@example.test" },
      { "[EMAIL_1]": "old@example.test" }
    ),
    {
      sanitizedText: "[EMAIL_2]",
      sessionMap: { "[EMAIL_2]": "new@example.test" }
    }
  );

  assert.throws(
    () => rebaseSessionAdditions(
      "[PERSON_2]",
      { "[PERSON_2]": "Alice" },
      { "[PERSON_1]": "alice" }
    ),
    error => error?.code === "PRIVACYAI_AMBIGUOUS_SESSION_MAP"
  );
});

test("rebaseSessionAdditions replaces overlapping aliases in one longest-first pass", () => {
  assert.deepEqual(
    rebaseSessionAdditions(
      "contact10 contact1",
      {
        contact1: "first@example.test",
        contact10: "second@example.test"
      },
      {
        "[EMAIL_1]": "first@example.test",
        "[EMAIL_10]": "second@example.test"
      }
    ),
    {
      sanitizedText: "[EMAIL_10] [EMAIL_1]",
      sessionMap: {}
    }
  );
});

test("StreamingPlaceholderRestorer preserves exact Unicode placeholders across surrogate splits", () => {
  const placeholder = "🔒PRIVATE🔒";
  const text = `before ${placeholder} after`;
  for (let index = 0; index <= text.length; index += 1) {
    const restorer = new StreamingPlaceholderRestorer({ [placeholder]: "restored" });
    const output = restorer.push(text.slice(0, index)) + restorer.push(text.slice(index)) + restorer.flush();
    assert.equal(output, "before restored after", `split ${index}`);
  }
});

test("structured key policy preserves protocol keys while sanitizing other keys", async () => {
  const secretKey = "private-key@example.test";
  const privateValue = "private-value@example.test";
  const result = await sanitizeStructuredValue({
    protocol_key: privateValue,
    [secretKey]: "public"
  }, {
    sanitizeObjectKeys: ({ key }) => key === "protocol_key" ? false : true,
    sanitizer: async text => {
      const sessionMap = {};
      let sanitizedPrompt = text;
      if (text.includes(secretKey)) {
        sessionMap["[EMAIL_1]"] = secretKey;
        sanitizedPrompt = sanitizedPrompt.replaceAll(secretKey, "[EMAIL_1]");
      }
      if (text.includes(privateValue)) {
        sessionMap["[EMAIL_2]"] = privateValue;
        sanitizedPrompt = sanitizedPrompt.replaceAll(privateValue, "[EMAIL_2]");
      }
      return { sanitizedPrompt, sessionMap };
    }
  });

  assert.deepEqual(result.value, {
    protocol_key: "[EMAIL_2]",
    "[EMAIL_1]": "public"
  });
});

test("structured sanitization propagates cancellation before and during classification", async () => {
  const before = new AbortController();
  const beforeReason = new Error("cancelled before classification");
  before.abort(beforeReason);
  let calls = 0;
  await assert.rejects(
    sanitizeStructuredValue("private", {
      signal: before.signal,
      sanitizer: async text => {
        calls += 1;
        return { sanitizedPrompt: text, sessionMap: {} };
      }
    }),
    error => error === beforeReason
  );
  assert.equal(calls, 0);

  const during = new AbortController();
  const duringReason = new Error("cancelled during classification");
  await assert.rejects(
    sanitizeStructuredValue("private", {
      signal: during.signal,
      sanitizer: async text => {
        during.abort(duringReason);
        return { sanitizedPrompt: text, sessionMap: {} };
      }
    }),
    error => error === duringReason
  );
});

test("structured chunk boundaries never split surrogate pairs", async () => {
  const secret = "🔐".repeat(256);
  const input = "x".repeat(1800) + secret + "y".repeat(900);
  let containingCalls = 0;
  const result = await sanitizeStructuredValue(input, {
    maxContextChars: 2048,
    sanitizer: async text => {
      assert.equal(hasUnpairedSurrogate(text), false);
      const found = text.includes(secret);
      if (found) containingCalls += 1;
      return {
        sanitizedPrompt: found ? text.replaceAll(secret, "[PRIVATE_IDENTIFIER_1]") : text,
        sessionMap: found ? { "[PRIVATE_IDENTIFIER_1]": secret } : {}
      };
    }
  });

  assert.equal(containingCalls >= 1, true);
  assert.equal(restoreValue(result.value, result.sessionMapAdditions), input);
});

test("privacy-core compatibility exports retain their public identities", async () => {
  const publicApi = await import("../src/index.js");
  const sessionMapApi = await import("../src/session-map.js");
  const redactorApi = await import("../src/redactor.js");

  for (const name of [
    "normalizeSessionMap",
    "rebaseSessionAdditions",
    "restoreText",
    "restoreValue",
    "sanitizeKnownText",
    "sanitizeKnownValue",
    "transformValue",
    "findUnresolvedPlaceholders",
    "assertNoProtectedOriginals",
    "assertNoProtectedOriginalsInValue"
  ]) {
    assert.equal(publicApi[name], sessionMapApi[name], name);
  }
  assert.equal(publicApi.restore, redactorApi.restore);
});

function hasUnpairedSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
