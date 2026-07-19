#!/usr/bin/env node
import { loadPrivacyConfig } from "../src/config-store.js";
import { createPrivacySanitizer } from "../src/privacy-sanitizer.js";
import { processPromptSubmission } from "../src/prompt-flow.js";

try {
  const event = JSON.parse(await readStdin());
  const loaded = await loadPrivacyConfig();

  if (!loaded.configured) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: "PrivacyAI is not configured. Run `privacyai onboard` before sending private prompts."
      })
    );
  } else {
    const result = await processPromptSubmission(event, {
      runtimeDir: process.env.PRIVACYAI_WRAPPER_DIR,
      sanitizer: createPrivacySanitizer(loaded.config)
    });
    if (result?.output) process.stdout.write(JSON.stringify(result.output));
  }
} catch {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: "PrivacyAI blocked this prompt because local sanitization failed. No prompt was sent."
    })
  );
  process.exitCode = 2;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) throw new Error("empty hook input");
  return input;
}
