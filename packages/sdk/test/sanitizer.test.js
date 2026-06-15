import test from "node:test";
import assert from "node:assert/strict";
import { PrivateAI, PrivacySanitizer, restore, parseSanitizerJson } from "../src/index.js";

function mockPrivacyProvider(payload) {
  return {
    async chat() {
      return {
        text: JSON.stringify(payload),
        raw: {},
        provider: {}
      };
    }
  };
}

test("ai sanitizer returns safe_prompt and session_map from local AI", async () => {
  const sanitizer = new PrivacySanitizer({
    provider: mockPrivacyProvider({
      safe_prompt: "Contact Alex Morgan at contact1@example.com or +1 (555) 010-0001 from Northwind Labs.",
      session_map: {
        "Alex Morgan": "John Smith",
        "contact1@example.com": "john.smith@example.com",
        "+1 (555) 010-0001": "+1 555 123 4567",
        "Northwind Labs": "Apple Inc"
      }
    }),
    loadEnv: false
  });

  const result = await sanitizer.sanitize(
    "Contact John Smith at john.smith@example.com or +1 555 123 4567 from Apple Inc."
  );

  assert.equal(result.sanitizedText, "Contact Alex Morgan at contact1@example.com or +1 (555) 010-0001 from Northwind Labs.");
  assert.equal(result.sessionMap["contact1@example.com"], "john.smith@example.com");
  assert.equal(result.privacySource, "ai-sanitizer");
});

test("restore replaces dummy stand-ins with original values", () => {
  const text = "Email contact1@example.com and phone +1 (555) 010-0001.";
  const restored = restore(text, {
    "contact1@example.com": "a@example.com",
    "+1 (555) 010-0001": "555-123-4567"
  });

  assert.equal(restored, "Email a@example.com and phone 555-123-4567.");
});

test("client ask uses local AI first, then sends safe prompt without system context", async () => {
  const calls = [];
  const provider = {
    async chat(request) {
      calls.push(request);
      if (calls.length === 1) {
        return {
          text: JSON.stringify({
            safe_prompt: "Please email contact1@example.com.",
            session_map: {
              "contact1@example.com": "alice@example.com"
            }
          }),
          raw: {},
          provider: {}
        };
      }

      return {
        text: "I will email contact1@example.com with a concise update.",
        raw: {},
        provider: { baseURL: "mock://provider", model: "mock-model" }
      };
    }
  };

  const client = new PrivateAI({ provider, loadEnv: false, model: "mock-model" });
  const result = await client.ask("Please email Alice Johnson at alice@example.com.");

  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.length, 1);
  assert.equal(calls[1].messages[0].content, "Please email contact1@example.com.");
  assert.equal(result.finalText, "I will email alice@example.com with a concise update.");
});

test("ai sanitizer redacts AWS and stripe-style secrets when local AI returns JSON", async () => {
  const sanitizer = new PrivacySanitizer({
    provider: mockPrivacyProvider({
      safe_prompt: "I keep forgetting my AWS key AKIADUMMY00000001KEY and my backup key sk_dummy_1_redacted. Can you make a mnemonic for me?",
      session_map: {
        AKIADUMMY00000001KEY: "AKIA4QW7J2KEXAMPLE",
        sk_dummy_1_redacted: "sk_live_abc123def456"
      }
    }),
    loadEnv: false
  });

  const result = await sanitizer.sanitize(
    "I keep forgetting my AWS key AKIA4QW7J2KEXAMPLE and my backup key sk_live_abc123def456. Can you make a mnemonic for me?"
  );

  assert.doesNotMatch(result.sanitizedText, /AKIA4QW7J2KEXAMPLE/);
  assert.doesNotMatch(result.sanitizedText, /sk_live_abc123def456/);
  assert.equal(result.sessionMap.sk_dummy_1_redacted, "sk_live_abc123def456");
});

test("enforcement replaces vague stand-ins like API key with concrete dummy values", async () => {
  const leakedKey = "848a71e823beb08e73a65f358c9b223b015e45bc";
  const sanitizer = new PrivacySanitizer({
    provider: mockPrivacyProvider({
      safe_prompt: "I want to use the Groq API. The API key I have is API key. Please tell me how to add this to the environment variables.",
      session_map: {
        "API key": leakedKey
      }
    }),
    loadEnv: false
  });

  const result = await sanitizer.sanitize(
    `now i want to use the groq so this is the api can you tell me how to add this in the env? api: ${leakedKey}`
  );

  assert.doesNotMatch(result.sanitizedText, /API key I have is API key/i);
  assert.doesNotMatch(result.sanitizedText, new RegExp(leakedKey));
  assert.match(result.sanitizedText, /gsk_dummy_1_redacted/);
  assert.equal(result.sessionMap.gsk_dummy_1_redacted, leakedKey);
});

test("enforcement strips leaked api keys even when local AI returns bad JSON mapping", async () => {
  const leakedKey = "848a71e823beb08e73a65f358c9b223b015e45bc";
  const sanitizer = new PrivacySanitizer({
    provider: mockPrivacyProvider({
      safe_prompt: `I want to use the Groq API. The API key I have is ${leakedKey}. Please tell me how to add this to the environment variables.`,
      session_map: {
        [leakedKey]: "dummy-should-have-been-key"
      }
    }),
    loadEnv: false
  });

  const result = await sanitizer.sanitize(
    `now i want to use the groq so this is the api can you tell me how to add this in the env? api: ${leakedKey}`
  );

  assert.doesNotMatch(result.sanitizedText, new RegExp(leakedKey));
  assert.ok(Object.values(result.sessionMap).includes(leakedKey));
  assert.ok(Object.keys(result.sessionMap).some((dummy) => result.sanitizedText.includes(dummy)));
});

test("parseSanitizerJson extracts safe prompt and session map", () => {
  const parsed = parseSanitizerJson(`{"safe_prompt":"safe text","session_map":{"dummy":"real"}}`);
  assert.equal(parsed.safe_prompt, "safe text");
  assert.deepEqual(parsed.session_map, { dummy: "real" });
});

test("enforcement keeps ordinary API wording and only redacts the credential value", async () => {
  const leakedKey = "848a71e823beb08e73a65f358c9b223b015e45bc";
  const original =
    `so i wnat to configer the api of the grok can you do that for me using the write tools: api: ${leakedKey}`;
  const sanitizer = new PrivacySanitizer({
    provider: mockPrivacyProvider({
      safe_prompt:
        "so i wnat to configer the gsk_dummy_1_redacted of the grok can you do that for me using the write tools: gsk_dummy_1_redacted: gsk_dummy_1_redacted",
      session_map: {
        gsk_dummy_1_redacted: "gsk_dummy_1_redacted"
      }
    }),
    loadEnv: false
  });

  const result = await sanitizer.sanitize(original);

  assert.match(result.sanitizedText, /configer the api of the grok/i);
  assert.match(result.sanitizedText, /api:\s*gsk_dummy_1_redacted/);
  assert.doesNotMatch(result.sanitizedText, /gsk_dummy_1_redacted:\s*gsk_dummy_1_redacted/);
  assert.doesNotMatch(result.sanitizedText, new RegExp(leakedKey));
  assert.equal(result.sessionMap.gsk_dummy_1_redacted, leakedKey);
});

test("enforcement performs case-insensitive replacements to prevent PII leaks of emails", async () => {
  const original = "My email is John.Smith@example.com. Send info to john.smith@example.com.";
  const sanitizer = new PrivacySanitizer({
    provider: mockPrivacyProvider({
      safe_prompt: "My email is contact1@example.com. Send info to contact1@example.com.",
      session_map: {
        "contact1@example.com": "john.smith@example.com"
      }
    }),
    loadEnv: false
  });

  const result = await sanitizer.sanitize(original);

  assert.doesNotMatch(result.sanitizedText, /john.smith@example.com/i);
  assert.match(result.sanitizedText, /contact1@example.com/);
  assert.equal(result.sanitizedText, "My email is contact1@example.com. Send info to contact1@example.com.");
});