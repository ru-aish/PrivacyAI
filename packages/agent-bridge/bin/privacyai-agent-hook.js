#!/usr/bin/env node
import { processHookEvent } from "../src/hook-adapter.js";
import { loadSessionMap } from "../src/session-vault.js";

try {
  const raw = await readStdin();
  const event = JSON.parse(raw);
  const sessionMap = await loadSessionMap({ sessionId: event.session_id });
  const output = processHookEvent(event, {
    flavor: process.env.PRIVACYAI_AGENT_FLAVOR || "claude",
    sessionMap
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
