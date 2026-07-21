#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const executable = basename(process.argv[1]);
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-V") || args.includes("version")) {
  if (process.env.PRIVACYAI_FAKE_VERSION_FAILURE === "1") {
    process.stderr.write(`${process.env.PRIVACYAI_FAKE_VERSION_SECRET || "fixture-version-secret"}\n`);
    process.exit(7);
  }
  process.stdout.write(`${executable} fixture 1.0.0\n`);
  process.exit(0);
}

const logPath = process.env.PRIVACYAI_FAKE_AGENT_LOG;
if (logPath) {
  await appendFile(logPath, `${JSON.stringify({
    executable,
    args,
    flavor: process.env.PRIVACYAI_AGENT_FLAVOR || null,
    privacyMode: process.env.PRIVACYAI_AGY_PRIVACY_MODE || null,
    wrapperDir: process.env.PRIVACYAI_WRAPPER_DIR || null
  })}\n`, { mode: 0o600 });
}

if (process.env.PRIVACYAI_FAKE_AGENT_BLOCK === "1") {
  const resistantSource = [
    "process.on('SIGTERM', () => {});",
    "process.on('SIGINT', () => {});",
    "setInterval(() => {}, 1000);"
  ].join("");
  const descendant = spawn(process.execPath, ["-e", resistantSource], {
    stdio: "ignore"
  });
  if (process.env.PRIVACYAI_FAKE_AGENT_PID_FILE) {
    await writeFile(
      process.env.PRIVACYAI_FAKE_AGENT_PID_FILE,
      `${JSON.stringify({ parent: process.pid, descendant: descendant.pid })}\n`,
      { mode: 0o600 }
    );
  }
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("fixture native agent completed\n");
  process.exit(Number(process.env.PRIVACYAI_FAKE_AGENT_EXIT || 0));
}
