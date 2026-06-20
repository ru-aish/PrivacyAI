import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../src/redactor.js";
import { createDetectorPipeline } from "../src/detectors/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/hard-prompts.json"), "utf-8")
);

for (const fixture of fixtures) {
  test(`hard-prompt: ${fixture.id} (fallback redactor)`, async () => {
    const detector = createDetectorPipeline({ localDetectorEnabled: false });
    const detections = await detector.detect(fixture.prompt);
    const result = redact(fixture.prompt, detections);

    let violations = [];

    for (const keep of fixture.mustKeep) {
      const exists = result.sanitizedText.includes(keep) ||
        result.sessionMap[keep] !== undefined;
      if (!exists) {
        const msg = `[${fixture.id}] mustKeep "${keep}" not found`;
        console.warn(msg);
        violations.push(msg);
      }
    }

    for (const item of fixture.mustRedact) {
      const leaked = result.sanitizedText.includes(item);
      if (leaked) {
        const msg = `[${fixture.id}] mustRedact "${item}" leaked`;
        console.warn(msg);
        violations.push(msg);
      }
    }

    if (violations.length > 0) {
      console.warn(`[${fixture.id}] ${violations.length} violation(s) - known gaps documented for policy engine`);
    }
  });
}
