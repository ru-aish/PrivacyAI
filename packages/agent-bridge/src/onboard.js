import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { savePrivacyConfig } from "./config-store.js";
import { resolveExecutable } from "./executable.js";
import { checkPrivacyModel } from "./model-health.js";

export const DEFAULT_PRIVACY_MODEL = "qwen3.5:2b";
export const PROJECT_URL = "https://github.com/ru-aish/PrivacyAI";

export async function runOnboarding(options = {}) {
  const output = options.output || process.stdout;
  const input = options.input || process.stdin;
  const ollamaPath = options.ollamaPath || (await resolveExecutable("ollama"));

  writeLine(output, "PrivacyAI local setup");
  writeLine(output, "Your prompts stay on this machine while the privacy model replaces sensitive values.");

  if (!ollamaPath) {
    throw new Error(
      "Ollama is not installed. Install it from https://ollama.com/download, then run `privacyai onboard` again."
    );
  }

  let closeReadline = false;
  let ask = options.ask;
  let readline;
  if (!ask) {
    readline = createInterface({ input, output });
    closeReadline = true;
    ask = question => readline.question(question);
  }

  try {
    const answer = String(
      await ask(`Press Enter to download ${DEFAULT_PRIVACY_MODEL}, or type another model name: `)
    ).trim();
    const model = answer || DEFAULT_PRIVACY_MODEL;

    writeLine(output, `Downloading local privacy model: ${model}`);
    const code = await runInherited(ollamaPath, ["pull", model], options);
    if (code !== 0) throw new Error(`Ollama could not download ${model} (exit code ${code}).`);

    const saved = await savePrivacyConfig(
      {
        provider: "ollama",
        baseURL: options.baseURL || "http://127.0.0.1:11434",
        model,
        apiKey: "not-required",
        timeoutMs: 60000,
        numCtx: 4096,
        onboardedAt: new Date().toISOString()
      },
      { path: options.configPath }
    );

    const health = await checkPrivacyModel(saved.config, {
      fetch: options.fetch,
      timeoutMs: options.healthTimeoutMs || 5000,
      skip: options.skipHealthCheck
    });
    if (!health.ok) {
      throw new Error(`${health.reason} The configuration was saved at ${saved.path}.`);
    }

    writeLine(output, "PrivacyAI is ready.");
    writeLine(output, "Start with: privacyai claude");
    writeLine(output, "Or use:    privacyai codex");
    writeLine(output, `Project: ${PROJECT_URL}`);
    return saved;
  } finally {
    if (closeReadline) readline.close();
  }
}

function runInherited(command, args, options) {
  if (options.runCommand) return options.runCommand(command, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", code => resolve(code ?? 1));
  });
}

function writeLine(output, text) {
  output.write(`${text}\n`);
}
