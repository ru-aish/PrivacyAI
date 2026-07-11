import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { savePrivacyConfig } from "./config-store.js";
import { resolveExecutable } from "./executable.js";
import { checkPrivacyModel } from "./model-health.js";

export const DEFAULT_PRIVACY_MODEL = "ministral-3:3b";
export const PROJECT_URL = "https://github.com/ru-aish/PrivacyAI";

export async function runOnboarding(options = {}) {
  const output = options.output || process.stdout;
  const input = options.input || process.stdin;
  const ollamaPath = options.ollamaPath || (await resolveExecutable("ollama"));
  const baseURL = options.baseURL || "http://127.0.0.1:11434";

  writeLine(output, "PrivacyAI local setup");
  writeLine(output, "Your prompts stay on this machine while the privacy model replaces sensitive values.");

  if (!ollamaPath) {
    throw new Error(
      "Ollama is not installed. Install it from https://ollama.com/download, then run `privacyai onboard` again."
    );
  }

  let downloadedModels = [];
  try {
    downloadedModels = options.listModels
      ? normalizeDownloadedModels(await options.listModels({ baseURL }))
      : await listDownloadedLanguageModels({ baseURL, fetch: options.fetch });
  } catch (error) {
    writeLine(output, `Could not inspect downloaded Ollama models: ${error.message}`);
  }

  const choices = buildModelChoices(downloadedModels);
  writeModelChoices(output, choices);

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
      await ask("Choose a model number, press Enter for the recommended model, or type another model name: ")
    ).trim();
    const model = resolveModelSelection(answer, choices);
    const alreadyDownloaded = downloadedModels.some(item => item.name === model);

    if (alreadyDownloaded) {
      writeLine(output, `Using downloaded local privacy model: ${model}`);
    } else {
      writeLine(output, `Downloading local privacy model: ${model}`);
      const code = await runInherited(ollamaPath, ["pull", model], options);
      if (code !== 0) throw new Error(`Ollama could not download ${model} (exit code ${code}).`);
    }

    const saved = await savePrivacyConfig(
      {
        provider: "ollama",
        baseURL,
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

export async function listDownloadedLanguageModels(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to inspect Ollama models.");
  }

  const baseURL = String(options.baseURL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const tagsResponse = await fetchImpl(`${baseURL}/api/tags`, {
    headers: { accept: "application/json" }
  });
  if (!tagsResponse.ok) {
    throw new Error(`Ollama returned HTTP ${tagsResponse.status} while listing models.`);
  }

  const tagsBody = await tagsResponse.json();
  const taggedModels = normalizeDownloadedModels(tagsBody?.models || []);
  const inspected = await Promise.all(
    taggedModels.map(async item => {
      try {
        const response = await fetchImpl(`${baseURL}/api/show`, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({ model: item.name, verbose: false })
        });
        if (!response.ok) return item;
        const body = await response.json();
        return {
          ...item,
          capabilities: Array.isArray(body?.capabilities) ? body.capabilities : [],
          parameterSize: body?.details?.parameter_size || item.parameterSize,
          quantizationLevel: body?.details?.quantization_level || item.quantizationLevel
        };
      } catch {
        return item;
      }
    })
  );

  return inspected.filter(item =>
    item.capabilities.length === 0 || item.capabilities.includes("completion")
  );
}

export function buildModelChoices(downloadedModels = []) {
  const normalized = normalizeDownloadedModels(downloadedModels);
  const recommended = normalized.find(item => item.name === DEFAULT_PRIVACY_MODEL);
  return [
    recommended || { name: DEFAULT_PRIVACY_MODEL, downloaded: false, capabilities: [] },
    ...normalized.filter(item => item.name !== DEFAULT_PRIVACY_MODEL)
  ];
}

export function resolveModelSelection(answer, choices) {
  if (!answer) return DEFAULT_PRIVACY_MODEL;
  if (/^\d+$/.test(answer)) {
    const index = Number(answer) - 1;
    if (index < 0 || index >= choices.length) {
      throw new Error(`Model choice must be between 1 and ${choices.length}.`);
    }
    return choices[index].name;
  }
  return answer;
}

function normalizeDownloadedModels(models) {
  const seen = new Set();
  const normalized = [];
  for (const model of models || []) {
    const name = String(typeof model === "string" ? model : model?.name || model?.model || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push({
      name,
      downloaded: true,
      size: Number(model?.size || 0),
      parameterSize: model?.parameterSize || model?.details?.parameter_size || "",
      quantizationLevel: model?.quantizationLevel || model?.details?.quantization_level || "",
      capabilities: Array.isArray(model?.capabilities) ? model.capabilities : []
    });
  }
  return normalized;
}

function writeModelChoices(output, choices) {
  writeLine(output, "Available Ollama language models:");
  choices.forEach((model, index) => {
    const labels = [];
    if (model.name === DEFAULT_PRIVACY_MODEL) labels.push("recommended");
    labels.push(model.downloaded === false ? "not downloaded" : "downloaded");
    if (model.parameterSize) labels.push(model.parameterSize);
    if (model.quantizationLevel) labels.push(model.quantizationLevel);
    if (model.size) labels.push(formatBytes(model.size));
    writeLine(output, `  ${index + 1}. ${model.name} (${labels.join(", ")})`);
  });
  writeLine(output, "You can also type any other Ollama model name to download and use it.");
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
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
