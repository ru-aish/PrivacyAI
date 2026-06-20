import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { localSanitize } from "../src/index.js";
import { validateSanitizedOutput } from "../src/enforcement/output-validator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.join(__dirname, "fixtures", "hard-prompts.json");
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

test("hard prompts regression suite", async () => {
  for (const fixture of fixtures) {
    const result = await localSanitize(fixture.prompt);

    const validation = validateSanitizedOutput({
      originalText: fixture.prompt,
      sanitizedText: result.sanitizedText,
      sessionMap: result.sessionMap,
      requiredKeeps: fixture.mustKeep,
      requiredRedacts: fixture.mustRedact
    });

    if (!validation.ok) {
      console.error(`Fixture failed: ${fixture.id}`);
      console.error("Sanitized Text:", result.sanitizedText);
      console.error("Leaks:", validation.leaks);
      console.error("Missing Context:", validation.missingContext);
    }

    assert.ok(validation.ok, `Fixture ${fixture.id} should pass output validation`);
  }
});
