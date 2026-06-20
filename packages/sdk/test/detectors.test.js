import test from "node:test";
import assert from "node:assert/strict";
import { RegexDetector } from "../src/detectors/regex.js";

test("RegexDetector detects basic patterns like email, ssn, IP, and credit cards", () => {
  const detector = new RegexDetector();
  const text = "Contact alice@example.com or call 555-123-4567. SSN is 000-12-3456. IP is 192.168.1.1.";
  const detections = detector.detect(text);

  const email = detections.find(d => d.type === "EMAIL");
  const ssn = detections.find(d => d.type === "SSN");
  const ip = detections.find(d => d.type === "IP_ADDRESS");

  assert.ok(email);
  assert.equal(email.value, "alice@example.com");

  assert.ok(ssn);
  assert.equal(ssn.value, "000-12-3456");

  assert.ok(ip);
  assert.equal(ip.value, "192.168.1.1");
});

test("RegexDetector detects API keys and AWS keys", () => {
  const detector = new RegexDetector();
  const text = "AWS Key: AKIAIOSFODNN7EXAMPLE. Stripe key: sk_live_1234567890abcdef. GSK: gsk_12345678901234567890";
  const detections = detector.detect(text);

  const aws = detections.find(d => d.type === "AWS_ACCESS_KEY");
  const stripe = detections.find(d => d.type === "API_KEY" && d.value.startsWith("sk_"));
  const gsk = detections.find(d => d.type === "API_KEY" && d.value.startsWith("gsk_"));

  assert.ok(aws);
  assert.equal(aws.value, "AKIAIOSFODNN7EXAMPLE");

  assert.ok(stripe);
  assert.equal(stripe.value, "sk_live_1234567890abcdef");

  assert.ok(gsk);
  assert.equal(gsk.value, "gsk_12345678901234567890");
});
