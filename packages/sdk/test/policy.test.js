import test from "node:test";
import assert from "node:assert/strict";
import { findProtectedSpans, findRedactableSubspans } from "../src/policy/protected-spans.js";
import { classifyDetections, isPrivateIp } from "../src/policy/redaction-policy.js";

test("findProtectedSpans identifies URLs and file paths", () => {
  const text = "Check out https://github.com/ru-aish/PrivacyAI and look at ./packages/sdk/src/index.js";
  const spans = findProtectedSpans(text);

  const urls = spans.filter(s => s.type === "URL");
  const files = spans.filter(s => s.type === "FILE_PATH");

  assert.equal(urls.length, 1);
  assert.equal(urls[0].value, "https://github.com/ru-aish/PrivacyAI");
  assert.equal(files.length, 1);
  assert.equal(files[0].value, "./packages/sdk/src/index.js");
});

test("findRedactableSubspans extracts URL query secrets and credentials", () => {
  const text = "postgres://sam:supersecret@prod-db.internal:5432/acme and https://api.example.com/callback?token=abc123secret456&tab=oauth";
  const protectedSpans = findProtectedSpans(text);
  const subspans = findRedactableSubspans(text, protectedSpans);

  const userinfo = subspans.filter(s => s.type === "URL_USERINFO_SECRET");
  const query = subspans.filter(s => s.type === "URL_QUERY_SECRET");

  assert.equal(userinfo.length, 1);
  assert.equal(userinfo[0].value, "supersecret");

  assert.equal(query.length, 1);
  assert.equal(query[0].value, "abc123secret456");
});

test("classifyDetections filters candidates inside protected spans and retains credentials", () => {
  const text = "My IP is 127.0.0.1 and here is postgres://sam:supersecret@prod-db.internal:5432/acme and email bob@example.com inside `code block containing gsk_12345678901234567890`";

  const candidates = [
    { type: "IP_ADDRESS", value: "127.0.0.1", start: 9, end: 18, confidence: 0.95 },
    { type: "EMAIL", value: "bob@example.com", start: 86, end: 101, confidence: 0.95 },
    { type: "API_KEY", value: "gsk_12345678901234567890", start: 125, end: 149, confidence: 0.95 }
  ];

  const decisions = classifyDetections(text, candidates, { keepPrivateIp: true });

  // 127.0.0.1 is private IP and keepPrivateIp is true -> discarded
  // bob@example.com is outside any protected span -> kept
  // gsk_12345678901234567890 is inside a code block but is an API_KEY -> kept
  // The database URL's credential (supersecret) is added as a decision -> kept

  const emailDecision = decisions.find(d => d.type === "EMAIL");
  const apiKeyDecision = decisions.find(d => d.type === "API_KEY");
  const urlCredDecision = decisions.find(d => d.type === "URL_USERINFO_SECRET");

  assert.ok(emailDecision);
  assert.ok(apiKeyDecision);
  assert.ok(urlCredDecision);
  assert.equal(urlCredDecision.value, "supersecret");
  assert.equal(decisions.some(d => d.value === "127.0.0.1"), false);
});

test("isPrivateIp classifies IP addresses correctly", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.1.4"), true);
  assert.equal(isPrivateIp("192.168.1.100"), true);
  assert.equal(isPrivateIp("172.16.5.5"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("localhost"), true);
});
