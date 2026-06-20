import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AiSanitizer } from "../src/ai-sanitizer.js";
import { restore } from "../src/redactor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.join(__dirname, "fixtures", "hard-prompts.json");
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

test("hard prompts evaluation suite", async () => {
  for (const fixture of fixtures) {
    const { id, prompt, mustRedact, mustKeep, mode } = fixture;

    for (const testMode of mode) {
      const provider = {
        async chat(request) {
          if (testMode === "good-json") {
            // Standard fully redacted JSON
            let safePrompt = prompt;
            const sessionMap = {};
            mustRedact.forEach((val, idx) => {
              const dummy = val.includes("@") ? `contact${idx+1}@example.com` : `gsk_dummy_${idx+1}_redacted`;
              safePrompt = safePrompt.replace(new RegExp(val, "g"), dummy);
              sessionMap[dummy] = val;
            });
            return {
              text: JSON.stringify({
                safe_prompt: safePrompt,
                session_map: sessionMap
              })
            };
          } else if (testMode === "leaky-json") {
            // Misses redacting one of the sensitive values in safe_prompt and session_map
            let safePrompt = prompt;
            const sessionMap = {};
            mustRedact.forEach((val, idx) => {
              if (idx === 0) {
                // First value is leaked/unredacted by LLM
                return;
              }
              const dummy = val.includes("@") ? `contact${idx+1}@example.com` : `gsk_dummy_${idx+1}_redacted`;
              safePrompt = safePrompt.replace(new RegExp(val, "g"), dummy);
              sessionMap[dummy] = val;
            });
            return {
              text: JSON.stringify({
                safe_prompt: safePrompt,
                session_map: sessionMap
              })
            };
          } else {
            // Invalid JSON
            return {
              text: "Here is your sanitized output which is not valid JSON."
            };
          }
        }
      };

      const sanitizer = new AiSanitizer({ provider });
      const result = await sanitizer.sanitize(prompt);

      // 1. Leak Checks (Must Redact)
      mustRedact.forEach((secret) => {
        const containsSecret = result.sanitizedText.toLowerCase().includes(secret.toLowerCase());
        assert.equal(
          containsSecret,
          false,
          `Fixture ${id} under mode ${testMode} leaked secret: "${secret}". Sanitized prompt: "${result.sanitizedText}"`
        );
      });

      // 2. Context Preservation Checks (Must Keep)
      mustKeep.forEach((keepVal) => {
        const containsKeep = result.sanitizedText.toLowerCase().includes(keepVal.toLowerCase());
        assert.equal(
          containsKeep,
          true,
          `Fixture ${id} under mode ${testMode} dropped keep value: "${keepVal}". Sanitized prompt: "${result.sanitizedText}"`
        );
      });

      // 3. Reversibility check
      const restored = restore(result.sanitizedText, result.sessionMap);
      assert.equal(restored, prompt, `Fixture ${id} under mode ${testMode} did not restore perfectly.`);
    }
  }
});
