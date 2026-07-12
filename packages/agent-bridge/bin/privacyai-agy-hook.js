#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { processAgyHookEvent } from "../src/agy-hook-adapter.js";

try {
  const mapPath = requiredArgument("--session-map");
  const processToken = process.env.PRIVACYAI_AGY_SESSION_TOKEN || "";
  const event = JSON.parse(await readStdin());

  if (!processToken) {
    process.stdout.write(
      JSON.stringify({
        decision: "allow",
        reason: "PrivacyAI AGY guard is scoped to a different process."
      })
    );
  } else {
    const record = JSON.parse(await readFile(mapPath, "utf8"));
    if (record?.sessionToken !== processToken) {
      throw new Error("session token mismatch");
    }
    const sessionMap = record?.sessionMap && typeof record.sessionMap === "object"
      && !Array.isArray(record.sessionMap)
      ? record.sessionMap
      : {};
    process.stdout.write(JSON.stringify(processAgyHookEvent(event, sessionMap)));
  }
} catch {
  process.stdout.write(
    JSON.stringify({
      decision: "deny",
      reason: "PrivacyAI blocked this AGY tool call because local privacy validation failed."
    })
  );
  process.exitCode = 2;
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? "" : process.argv[index + 1];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) throw new Error("empty hook input");
  return input;
}
