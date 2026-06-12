#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { configureProvider, writeEnvFile } from "./lib/setup-providers.mjs";
import { isInteractive, log, runQuiet } from "./lib/setup-ui.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT_DIR, ".env");
const IS_WIN = platform() === "win32";

function parseArgs(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--provider") {
      process.env.PRIVACY_AI_SETUP_PROVIDER = argv[index + 1] || "ollama";
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      log("Usage: npm run setup [-- --provider ollama|lmstudio|openai|gemini|custom]");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
}

async function installDependencies() {
  const packageManager = IS_WIN ? "pnpm.cmd" : "pnpm";
  const ok = await runQuiet(
    packageManager,
    ["install", "--reporter=append-only"],
    "Installing Node dependencies...",
    { cwd: ROOT_DIR, shell: IS_WIN }
  );

  if (!ok) {
    throw new Error("Dependency installation failed. Make sure pnpm is installed: https://pnpm.io/installation");
  }
}

async function main() {
  parseArgs(process.argv.slice(2));

  log("PrivacyAI setup");
  log(`Repository: ${ROOT_DIR}`);
  log("");

  await installDependencies();

  const provider = await configureProvider(ROOT_DIR);
  writeEnvFile(ENV_FILE, provider);

  log("");
  log(`Wrote env file: ${ENV_FILE}`);
  log("");
  log("Ready.");
  log("SDK docs: packages/sdk/README.md");
  log("Web demo: npm run demo");

  if (!isInteractive()) {
    log("");
    log("Non-interactive setup complete.");
  }
}

main().catch((error) => {
  log("");
  log(error instanceof Error ? error.message : "Setup failed.");
  process.exit(1);
});