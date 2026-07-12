#!/usr/bin/env node
import { loadPrivacyConfig } from "../src/config-store.js";
import { processHookEvent } from "../src/hook-adapter.js";
import { createPrivacySanitizer } from "../src/privacy-sanitizer.js";
import { SessionVault } from "../src/session-vault.js";

try {
  const raw = await readStdin();
  const event = JSON.parse(raw);
  const vault = new SessionVault();
  const sessionId = event.session_id;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("agent hook event is missing a valid session_id");
  }
  const sessionMap = (await vault.load(sessionId)).sessionMap;
  const needsContextSanitizer = event.hook_event_name !== "PreToolUse";
  let sanitizer;

  if (needsContextSanitizer) {
    const loaded = await loadPrivacyConfig();
    if (!loaded.configured) throw new Error("privacy sanitizer is not configured");
    sanitizer = createPrivacySanitizer(loaded.config);
  }

  const output = await processHookEvent(event, {
    flavor: process.env.PRIVACYAI_AGENT_FLAVOR || "claude",
    sessionMap,
    sanitizer,
    onSessionMapAdditions: additions => vault.merge(sessionId, additions)
  });

  if (output) process.stdout.write(JSON.stringify(output));
} catch (error) {
  process.stderr.write(`PrivacyAI agent hook blocked processing: ${safeErrorMessage(error)}\n`);
  process.exitCode = 2;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) throw new Error("empty hook input");
  return input;
}

function safeErrorMessage(error) {
  if (error instanceof SyntaxError) return "invalid JSON input";
  if (error instanceof Error && /Unsupported agent hook flavor/.test(error.message)) {
    return error.message;
  }
  return "local privacy transformation failed";
}
