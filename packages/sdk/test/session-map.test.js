import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamingPlaceholderRestorer,
  assertNoProtectedOriginals,
  assertNoProtectedOriginalsInValue,
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
