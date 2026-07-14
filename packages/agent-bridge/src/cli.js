import { launchAgy } from "./agy.js";
import { loadPrivacyConfig } from "./config-store.js";
import { launchNativeTui } from "./launcher.js";
import { checkPrivacyModel } from "./model-health.js";
import { runOnboarding } from "./onboard.js";

export async function runPrivacyAiCli(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const [command, ...args] = argv;

  try {
    switch (command) {
      case "claude":
      case "codex":
        return await (options.launchNativeTui || launchNativeTui)(command, args, options.launchOptions);
      case "agy":
      case "antigravity":
        return await (options.launchAgy || launchAgy)(args, options.agyOptions);
      case "onboard":
        await (options.runOnboarding || runOnboarding)({
          ...options.onboardOptions,
          input: options.stdin || process.stdin,
          output: stdout
        });
        return 0;
      case "doctor":
        return await runDoctor({ ...options, stdout });
      case "--version":
      case "-v":
        stdout.write("privacyai 0.0.2\n");
        return 0;
      case "help":
      case "--help":
      case "-h":
      case undefined:
        printHelp(stdout);
        return 0;
      default:
        throw new Error(`Unknown PrivacyAI command: ${command}\nRun: privacyai --help`);
    }
  } catch (error) {
    stderr.write(`${safeMessage(error)}\n`);
    return 1;
  }
}

async function runDoctor(options) {
  const loaded = await loadPrivacyConfig({ path: options.configPath });
  if (!loaded.configured) {
    options.stdout.write("PrivacyAI configuration: missing\nRun: privacyai onboard\n");
    return 1;
  }

  const health = await checkPrivacyModel(loaded.config, options.healthOptions);
  options.stdout.write(`Configuration: ${loaded.path}\n`);
  options.stdout.write(`Provider: ${loaded.config.provider}\n`);
  options.stdout.write(`Model: ${loaded.config.model}\n`);
  options.stdout.write(`Local model: ${health.ok ? "ready" : health.reason}\n`);
  return health.ok ? 0 : 1;
}

export function printHelp(output = process.stdout) {
  output.write("PrivacyAI native agent wrapper\n\n");
  output.write("Usage:\n");
  output.write("  privacyai onboard       Configure the local privacy model\n");
  output.write("  privacyai claude [...]  Open the normal Claude Code TUI with prompt protection\n");
  output.write("  privacyai codex [...]   Open stock Codex through the local provider gateway\n");
  output.write("  privacyai codex --privacy-strict [...]  Use prompt-only fallback isolation\n");
  output.write("  privacyai agy --print \"...\"  Send a protected one-shot Antigravity prompt\n");
  output.write("  privacyai doctor        Check local setup\n");
}

function safeMessage(error) {
  return error instanceof Error ? error.message : "PrivacyAI failed safely.";
}
