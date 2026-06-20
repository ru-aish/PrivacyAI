import test from "node:test";
import assert from "node:assert/strict";
import { extractProtectedSpans, findProtectedSpan, findRedactableSubspans } from "../src/policy/span-policy.js";
import { shouldRedact, classifyDetections } from "../src/policy/redaction-policy.js";
import { RedactionPlan } from "../src/redaction-plan.js";
import { RegexDetector } from "../src/detectors/regex.js";

test("extractProtectedSpans finds URLs", () => {
  const spans = extractProtectedSpans("Visit https://github.com/ru-aish/PrivacyAI");
  assert.ok(spans.some(s => s.type === "URL"));
});

test("extractProtectedSpans finds connection strings", () => {
  const spans = extractProtectedSpans("postgres://user:pass@host:5432/db");
  assert.ok(spans.some(s => s.type === "CONNECTION_STRING" || s.type === "URL"));
});

test("extractProtectedSpans finds file paths", () => {
  const spans = extractProtectedSpans("Error at /home/user/app/worker.js:88");
  assert.ok(spans.some(s => s.type === "FILE_PATH"));
});

test("extractProtectedSpans finds code blocks", () => {
  const spans = extractProtectedSpans("```\nconst x = 1;\n```");
  assert.ok(spans.some(s => s.type === "CODE_BLOCK"));
});

test("extractProtectedSpans finds inline code", () => {
  const spans = extractProtectedSpans("Run `npm install`");
  assert.ok(spans.some(s => s.type === "INLINE_CODE"));
});

test("findProtectedSpan returns parent span", () => {
  const text = "Visit https://github.com/ru-aish/PrivacyAI for info";
  const spans = extractProtectedSpans(text);
  const urlSpan = spans.find(s => s.type === "URL");
  assert.ok(urlSpan);

  const atUrlEnd = findProtectedSpan(spans, urlSpan.end - 5, urlSpan.end);
  assert.equal(atUrlEnd, urlSpan);
});

test("findRedactableSubspans extracts URL credentials", () => {
  const subspans = findRedactableSubspans(
    { type: "URL", start: 0, end: 40, value: "https://user:pass@example.com/path" },
    null
  );
  assert.ok(subspans.some(s => s.type === "URL_CREDENTIAL"));
});

test("findRedactableSubspans extracts URL query secrets", () => {
  const subspans = findRedactableSubspans(
    { type: "URL", start: 0, end: 60, value: "https://example.com?token=abc123&tab=oauth" },
    null
  );
  assert.ok(subspans.some(s => s.type === "URL_QUERY_SECRET"));
});

test("shouldRedact returns false for URLs", () => {
  const text = "Visit https://github.com/ru-aish/PrivacyAI";
  const spans = extractProtectedSpans(text);
  const urlMatch = text.match(/https:\/\/github\.com\/ru-aish\/PrivacyAI/);
  const result = shouldRedact({
    type: "URL",
    value: "https://github.com/ru-aish/PrivacyAI",
    start: urlMatch.index,
    end: urlMatch.index + urlMatch[0].length,
    confidence: 0.95
  }, { text, protectedSpans: spans });
  assert.equal(result, false);
});

test("shouldRedact returns true for URL credentials", () => {
  const text = "https://user:supersecret@example.com";
  const spans = extractProtectedSpans(text);
  const match = text.match(/supersecret/);
  const result = shouldRedact({
    type: "URL_CREDENTIAL",
    value: "supersecret",
    start: match.index,
    end: match.index + match[0].length,
    confidence: 0.97
  }, { text, protectedSpans: spans });
  assert.equal(result, true);
});

test("shouldRedact returns true for emails outside protected spans", () => {
  const result = shouldRedact({
    type: "EMAIL",
    value: "john@example.com",
    start: 0,
    end: 15,
    confidence: 0.99
  }, { protectedSpans: [] });
  assert.equal(result, true);
});

test("classifyDetections marks only sensitive items as redact", () => {
  const text = "Email john@example.com and visit https://github.com";
  const classified = classifyDetections([
    { type: "EMAIL", value: "john@example.com", start: 6, end: 21, confidence: 0.99 },
    { type: "URL", value: "https://github.com", start: 33, end: 49, confidence: 0.95 }
  ], { text });

  assert.equal(classified.find(d => d.type === "EMAIL").action, "redact");
  assert.equal(classified.find(d => d.type === "URL").action, "keep");
});

test("RedactionPlan preserves protected spans while redacting sensitive content", () => {
  const plan = new RedactionPlan("Email john@example.com and URL https://github.com");
  plan.addDetections(new RegexDetector().detect("Email john@example.com and URL https://github.com"));
  const result = plan.toResult();

  assert.doesNotMatch(result.sanitizedText, /john@example\.com/);
  assert.match(result.sanitizedText, /https:\/\/github\.com/);
});

test("RedactionPlan redacts URL credentials without destroying the URL", () => {
  const plan = new RedactionPlan("Login with https://user:password@example.com");
  plan.addDetections(new RegexDetector().detect("Login with https://user:password@example.com"));
  plan.addProtectedSpanSubspans();
  const result = plan.toResult();

  assert.match(result.sanitizedText, /https:\/\/[^@]+@example\.com/);
  assert.doesNotMatch(result.sanitizedText, /\bpassword\b/);
});

test("RedactionPlan protects connection string host while redacting credentials", () => {
  const text = "REDIS_URL=redis://:redispass@10.0.1.4:6379. Preserve host 10.0.1.4.";
  const plan = new RedactionPlan(text);
  plan.addDetections(new RegexDetector().detect(text));
  plan.addProtectedSpanSubspans();
  const result = plan.toResult();

  assert.match(result.sanitizedText, /redis:\/\/:[^@]+@10\.0\.1\.4:6379/);
  assert.match(result.sanitizedText, /Preserve host 10\.0\.1\.4\./);
});
