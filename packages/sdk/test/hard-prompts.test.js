import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RedactionPlan } from "../src/redaction-plan.js";
import { RegexDetector } from "../src/detectors/regex.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, "fixtures", "hard-prompts.json"), "utf-8"));

function runRedactionPlan(text) {
  const detector = new RegexDetector();
  const detections = detector.detect(text);
  const plan = new RedactionPlan(text);
  plan.addProtectedSpanSubspans();
  plan.addDetections(detections);
  return plan.toResult();
}

for (const fixture of fixtures) {
  test(`hard-prompt: ${fixture.id} (regex fallback)`, () => {
    const result = runRedactionPlan(fixture.prompt);

    for (const mustKeep of fixture.mustKeep) {
      assert.match(
        result.sanitizedText,
        new RegExp(escapeRegex(mustKeep)),
        `Expected "${mustKeep}" to be preserved in: ${result.sanitizedText}`
      );
    }

    const redactableItems = fixture.mustRedact.filter(item => {
      return fixture.prompt.includes(item);
    });

    for (const mustRedact of redactableItems) {
      assert.doesNotMatch(
        result.sanitizedText,
        new RegExp(escapeRegex(mustRedact), "i"),
        `Expected "${mustRedact}" to be redacted in: ${result.sanitizedText}`
      );
    }
  });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
