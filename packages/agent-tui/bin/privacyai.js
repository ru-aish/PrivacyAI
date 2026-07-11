#!/usr/bin/env node

let runPrivacyAiCli;
try {
  ({ runPrivacyAiCli } = await import("@privacy-ai/agent-bridge/cli"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  // Monorepo development fallback before workspace dependencies are installed.
  ({ runPrivacyAiCli } = await import("../../agent-bridge/src/cli.js"));
}

process.exitCode = await runPrivacyAiCli();
