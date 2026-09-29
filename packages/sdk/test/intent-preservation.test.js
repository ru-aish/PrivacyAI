import test from "node:test";
import assert from "node:assert/strict";

import { AiSanitizer, restore } from "../src/index.js";
import { BrowserPrivateAI } from "../src/browser-client.js";

function mockProvider(responses) {
  const queue = Array.isArray(responses) ? responses : [responses];
  let index = 0;
  return {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      const response = queue[Math.min(index, queue.length - 1)];
      index += 1;
      return {
        text: typeof response === "string" ? response : JSON.stringify(response),
        raw: {},
        provider: {}
      };
    }
  };
}

function assertStrictRoundTrip(result, original) {
  assert.equal(
    restore(result.sanitizedText, result.sessionMap),
    original,
    "strict sanitization must be exactly reversible"
  );
}

test("strict SDK discards a model-authored email rewrite and preserves every non-private character", async () => {
  const original = [
    "Using the Gmail tool, send this exact body to finance@example.com:",
    "",
    '"I approved invoice INV-4482. Please release ₹18,500 today."',
    "",
    "Do not summarize or improve it."
  ].join("\n");

  const provider = mockProvider({
    safe_prompt: [
      "Using Gmail, email finance@example.com:",
      "",
      '"Invoice **INV-XXXX** was approved. Release ₹18,500."'
    ].join("\n"),
    session_map: {
      internal_invoice_id: "INV-4482"
    }
  });
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);

  assertStrictRoundTrip(result, original);
  assert.match(result.sanitizedText, /Using the Gmail tool, send this exact body/);
  assert.match(result.sanitizedText, /Do not summarize or improve it\./);
  assert.match(result.sanitizedText, /Please release ₹18,500 today\./);
  assert.doesNotMatch(result.sanitizedText, /finance@example\.com/);
  assert.doesNotMatch(result.sanitizedText, /INV-4482/);
  assert.doesNotMatch(result.sanitizedText, /\*\*INV-XXXX\*\*/);
});

test("browser mode rejects a rewrite that drops constraints or uses an unmapped stand-in", async () => {
  const original = [
    "Using the Gmail tool, send this exact body to finance@example.com:",
    "",
    '"I approved invoice INV-4482. Please release ₹18,500 today."',
    "",
    "Do not summarize or improve it."
  ].join("\n");
  const bad = {
    safe_prompt: [
      "Using Gmail, email finance@example.com:",
      "",
      '"Invoice **INV-XXXX** was approved. Release ₹18,500."'
    ].join("\n"),
    session_map: {
      internal_invoice_id: "INV-4482"
    }
  };

  const sanitizer = new AiSanitizer({
    provider: mockProvider([bad, bad]),
    model: "mock",
    sanitizationMode: "browser"
  });
  const result = await sanitizer.sanitize(original);

  assert.equal(result.privacySource, "regex-fallback");
  assert.match(result.sanitizedText, /Do not summarize or improve it\./);
  assert.match(result.sanitizedText, /INV-4482/);
  assert.doesNotMatch(result.sanitizedText, /finance@example\.com/);
});

test("browser mode permits a small local identity rewrite while retaining structure and intent", async () => {
  const original = "I built the report for alice@example.com. Please review it exactly as written.";
  const safe = "The report was built for contact1@example.com. Please review it exactly as written.";
  const provider = mockProvider({
    safe_prompt: safe,
    session_map: {
      "contact1@example.com": "alice@example.com"
    }
  });
  const sanitizer = new AiSanitizer({
    provider,
    model: "mock",
    sanitizationMode: "browser"
  });
  const result = await sanitizer.sanitize(original);

  assert.equal(result.privacySource, "ai-sanitizer");
  assert.equal(result.sanitizedText, safe);
  assert.match(result.sanitizedText, /Please review it exactly as written\./);
});

test("BrowserPrivateAI selects browser policy while the SDK defaults to strict", async () => {
  const browserProvider = mockProvider({ safe_prompt: "hello", session_map: {} });
  const browser = new BrowserPrivateAI({ provider: browserProvider, model: "mock" });
  await browser.sanitize("hello");
  assert.match(browserProvider.requests[0].messages[0].content, /browser extension/);

  const sdkProvider = mockProvider({ safe_prompt: "hello", session_map: {} });
  const sdk = new AiSanitizer({ provider: sdkProvider, model: "mock" });
  await sdk.sanitize("hello");
  assert.match(sdkProvider.requests[0].messages[0].content, /privacy span extractor/);
});

test("strict mode round-trips markdown, JSON, code, Unicode, repeated values, and existing stand-ins", async () => {
  const original = [
    "Keep this structure exactly:",
    "",
    "```json",
    '{"owner":"José Núñez","email":"jose@example.com","token":"sk_live_abc123def456"}',
    "```",
    "",
    "- Email jose@example.com twice.",
    "- Existing examples: contact1@example.com and [EMAIL_1].",
    "- Do not translate नमस्ते or change punctuation?!"
  ].join("\n");
  const provider = mockProvider({
    safe_prompt: "Completely rewritten summary.",
    session_map: {
      "Alex Morgan": "José Núñez"
    }
  });
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);

  assertStrictRoundTrip(result, original);
  assert.equal((result.sanitizedText.match(/```/g) || []).length, 2);
  assert.match(result.sanitizedText, /Do not translate नमस्ते or change punctuation\?!/);
  assert.doesNotMatch(result.sanitizedText, /jose@example\.com/i);
  assert.doesNotMatch(result.sanitizedText, /sk_live_abc123def456/);
  assert.doesNotMatch(result.sanitizedText, /José Núñez/);
});

test("strict mode redacts international and Indian phone formats without changing the surrounding email", async () => {
  const original = [
    "Email alice.johnson@example.com and say exactly:",
    "",
    "Subject: Project Atlas delay",
    "Hi Alice,",
    "The deployment failed twice. Do not change the wording; ask her to call me at +91 98765 43210.",
    "Thanks,",
    "Rudra"
  ].join("\n");
  const provider = mockProvider({
    safe_prompt: "The model rewrote all of this.",
    session_map: {}
  });
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);

  assertStrictRoundTrip(result, original);
  assert.doesNotMatch(result.sanitizedText, /alice\.johnson@example\.com/i);
  assert.doesNotMatch(result.sanitizedText, /\+91 98765 43210/);
  assert.match(result.sanitizedText, /Do not change the wording/);
  assert.equal((result.sanitizedText.match(/\n/g) || []).length, (original.match(/\n/g) || []).length);
});

test("strict validation remains linear enough for future large-file inputs", async () => {
  const block = "preserve this line exactly, including spaces and punctuation.\n";
  const original = `${block.repeat(4000)}contact large.file@example.com at the end.\n`;
  const provider = mockProvider({
    safe_prompt: "short model summary",
    session_map: {}
  });
  const sanitizer = new AiSanitizer({ provider, model: "mock" });
  const result = await sanitizer.sanitize(original);

  assertStrictRoundTrip(result, original);
  assert.equal(result.sanitizedText.startsWith(block.repeat(10)), true);
  assert.doesNotMatch(result.sanitizedText, /large\.file@example\.com/);
});


test("browser mode accepts compact exact edits and reconstructs the prompt locally", async () => {
  const original = "I built the report for alice@example.com. Please review it exactly as written.";
  const provider = mockProvider({
    edits: [
      {
        search: "I built the report for alice@example.com",
        replace: "The report was built for contact1@example.com",
        occurrence: 1,
        all: false
      }
    ],
    session_map: {
      "contact1@example.com": "alice@example.com"
    }
  });
  const sanitizer = new AiSanitizer({
    provider,
    model: "mock",
    sanitizationMode: "browser"
  });
  const result = await sanitizer.sanitize(original);

  assert.equal(result.privacySource, "ai-edit-sanitizer");
  assert.equal(
    result.sanitizedText,
    "The report was built for contact1@example.com. Please review it exactly as written."
  );
  assert.equal(result.privacyModelText.includes(original), false);
  assert.equal(provider.requests.length, 1);
});

test("browser mode rejects ambiguous compact edits without resending the full source", async () => {
  const original = "enabled enabled alice@example.com";
  const provider = mockProvider({
    edits: [{ search: "enabled", replace: "disabled" }],
    session_map: {}
  });
  const sanitizer = new AiSanitizer({
    provider,
    model: "mock",
    sanitizationMode: "browser"
  });
  const result = await sanitizer.sanitize(original);

  assert.equal(result.privacySource, "regex-fallback");
  assert.match(result.sanitizedText, /^enabled enabled /);
  assert.doesNotMatch(result.sanitizedText, /alice@example\.com/);
  assert.equal(provider.requests.length, 1);
});
