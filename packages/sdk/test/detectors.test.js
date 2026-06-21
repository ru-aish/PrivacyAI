import test from "node:test";
import assert from "node:assert/strict";
import { RegexDetector } from "../src/detectors/regex.js";

function detect(text) {
  return new RegexDetector().detect(text);
}

test("detects email addresses", () => {
  const results = detect("Contact john.smith@example.com for info");
  assert.ok(results.some(d => d.type === "EMAIL"));
});

test("detects API keys", () => {
  const results = detect("My key is gsk_abc123def456ghi789jkl012");
  assert.ok(results.some(d => d.type === "API_KEY"));
});

test("detects AWS access keys", () => {
  const results = detect("AKIA4QW7J2KEXAMPLE");
  assert.ok(results.some(d => d.type === "AWS_ACCESS_KEY"));
});

test("detects SSN", () => {
  const results = detect("My SSN is 123-45-6789");
  assert.ok(results.some(d => d.type === "SSN"));
});

test("detects credit card with Luhn validation", () => {
  const results = detect("Card: 4111 1111 1111 1111");
  assert.ok(results.some(d => d.type === "CREDIT_CARD"));
});

test("rejects invalid credit card numbers", () => {
  const results = detect("Card: 1234 5678 9012 3456");
  assert.ok(results.every(d => d.type !== "CREDIT_CARD"));
});

test("detects phone numbers", () => {
  const results = detect("Call +1 (555) 123-4567");
  assert.ok(results.some(d => d.type === "PHONE"));
});

test("detects IP addresses", () => {
  const results = detect("Server: 192.168.1.1");
  assert.ok(results.some(d => d.type === "IP_ADDRESS"));
});

test("does NOT detect ordinary URLs as sensitive", () => {
  const results = detect("Visit https://github.com/ru-aish/PrivacyAI");
  assert.ok(results.every(d => d.type !== "URL"));
});

test("detects URL credentials (user:password@host)", () => {
  const results = detect("https://user:supersecret@example.com/path");
  assert.ok(results.some(d => d.type === "URL_CREDENTIAL"));
});

test("detects URL query secrets", () => {
  const results = detect("https://api.example.com/callback?token=abc123secret&tab=oauth");
  assert.ok(results.some(d => d.type === "URL_QUERY_SECRET"));
});

test("detects connection string credentials (postgres)", () => {
  const results = detect("postgres://sam:supersecret@prod-db.internal:5432/acme");
  assert.ok(results.some(d => d.type === "CONNECTION_STRING_CREDENTIAL"));
});

test("detects connection string credentials (redis)", () => {
  const results = detect("REDIS_URL=redis://:redispass@10.0.1.4:6379");
  assert.ok(results.some(d => d.type === "CONNECTION_STRING_CREDENTIAL"));
});

test("detects medical record numbers", () => {
  const results = detect("Patient MRN-12345 needs review");
  assert.ok(results.some(d => d.type === "MRN"));
});

test("detects patient ID patterns", () => {
  const results = detect("Patient ID: P12345 needs treatment");
  assert.ok(results.some(d => d.type === "MEDICAL_ID"));
});

test("detects person names via context", () => {
  const results = detect("My name is Alice Johnson");
  assert.ok(results.some(d => d.type === "PERSON"));
});

test("detects person names via contact pattern", () => {
  const results = detect("Contact John Smith at john@example.com");
  assert.ok(results.some(d => d.type === "PERSON"));
});

test("detects organizations via context", () => {
  const results = detect("My company is Acme Corp");
  assert.ok(results.some(d => d.type === "ORGANIZATION"));
});

test("detects organizations via suffix", () => {
  const results = detect("Work at Northwind Labs");
  assert.ok(results.some(d => d.type === "ORGANIZATION"));
});

test("detects locations via context", () => {
  const results = detect("I live in San Francisco");
  assert.ok(results.some(d => d.type === "LOCATION"));
});

test("preserves common technical terms and public names", () => {
  const results = detect("Using React, TypeScript, and GitHub");
  assert.ok(results.every(d => d.type !== "PERSON"));
});
