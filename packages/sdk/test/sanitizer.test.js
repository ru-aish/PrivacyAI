import test from "node:test";
import assert from "node:assert/strict";
import { PrivateAI, PrivacySanitizer, restore } from "../src/index.js";

test("sanitizer redacts common PII into dummy stand-ins", async () => {
  const sanitizer = new PrivacySanitizer();
  const result = await sanitizer.sanitize(
    "Contact John Smith at john.smith@example.com or +1 555 123 4567 from Apple Inc."
  );

  assert.doesNotMatch(result.sanitizedText, /john\.smith@example\.com/);
  assert.doesNotMatch(result.sanitizedText, /\+1 555 123 4567/);
  assert.doesNotMatch(result.sanitizedText, /John Smith/);
  assert.doesNotMatch(result.sanitizedText, /Apple Inc/);

  const dummyEmail = Object.keys(result.sessionMap).find((key) => result.sessionMap[key] === "john.smith@example.com");
  assert.ok(dummyEmail);
  assert.match(result.sanitizedText, new RegExp(dummyEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("restore replaces dummy stand-ins with original values", () => {
  const text = "Email contact1@example.com and phone +1 (555) 010-0001.";
  const restored = restore(text, {
    "contact1@example.com": "a@example.com",
    "+1 (555) 010-0001": "555-123-4567"
  });

  assert.equal(restored, "Email a@example.com and phone 555-123-4567.");
});

test("client ask sanitizes before calling provider and restores final text", async () => {
  const calls = [];
  const provider = {
    async chat(request) {
      calls.push(request);
      return {
        text: "I will email contact1@example.com with a concise update.",
        raw: {},
        provider: { baseURL: "mock://provider", model: "mock-model" }
      };
    }
  };

  const client = new PrivateAI({ provider, loadEnv: false, model: "mock-model" });
  const result = await client.ask("Please email Alice Johnson at alice@example.com.");

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].messages.at(-1).content, /alice@example\.com/);
  assert.match(calls[0].messages.at(-1).content, /contact1@example\.com/);
  assert.equal(result.finalText, "I will email alice@example.com with a concise update.");
});

test("sanitizer handles contextual names, locations, short phones, IPs, and JSON fields", async () => {
  const sanitizer = new PrivacySanitizer();
  const result = await sanitizer.sanitize(
    "My name is Michael O'Connor, I live in New York, phone 555-7890. JSON: {'name': 'Alice Johnson', 'company': 'IBM Watson', 'city': 'Boston', 'zip': '02101', 'servers': ['10.1.1.1']}."
  );

  assert.doesNotMatch(result.sanitizedText, /Michael O'Connor/);
  assert.doesNotMatch(result.sanitizedText, /Alice Johnson/);
  assert.doesNotMatch(result.sanitizedText, /New York/);
  assert.doesNotMatch(result.sanitizedText, /555-7890/);
  assert.doesNotMatch(result.sanitizedText, /IBM Watson/);
  assert.doesNotMatch(result.sanitizedText, /10\.1\.1\.1/);
  assert.ok(Object.keys(result.sessionMap).length >= 5);
});