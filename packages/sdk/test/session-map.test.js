import assert from "node:assert/strict";
import test from "node:test";

import {
  StreamingPlaceholderRestorer,
  assertNoProtectedOriginals,
  normalizeSessionMap,
  rebaseSessionAdditions,
  restoreValue,
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
