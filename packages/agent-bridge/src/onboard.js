import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { savePrivacyConfig } from "./config-store.js";
import { resolveExecutable } from "./executable.js";
import { checkPrivacyModel } from "./model-health.js";

export const DEFAULT_PRIVACY_MODEL = "ministral-3:3b";
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const PROJECT_URL = "https://github.com/ru-aish/PrivacyAI";

export async function runOnboarding(options = {}) {
  const output = options.output || process.stdout;
  const input = options.input || process.stdin;
  const ollamaPath = Object.hasOwn(options, "ollamaPath")
    ? options.ollamaPath
    : await resolveExecutable("ollama");
  const ollamaBaseURL = options.baseURL || options.ollamaBaseURL || DEFAULT_OLLAMA_BASE_URL;
  const lmStudioBaseURL = normalizeLmStudioBaseURL(
    options.lmStudioBaseURL ||
      process.env.PRIVACYAI_LM_STUDIO_BASE_URL ||
      DEFAULT_LM_STUDIO_BASE_URL
  );
  const lmStudioApiKey =
    options.lmStudioApiKey ||
    process.env.LM_STUDIO_API_TOKEN ||
    process.env.LM_API_TOKEN ||
    "not-required";

  writeLine(output, "PrivacyAI local setup");
  writeLine(output, "Your prompts stay on this machine while the privacy model replaces sensitive values.");

  let ollamaModels = [];
  let ollamaError = null;
  if (ollamaPath) {
    try {
      ollamaModels = options.listModels
        ? normalizeProviderModels(await options.listModels({ baseURL: ollamaBaseURL }), {
            provider: "ollama",
            baseURL: ollamaBaseURL
          })
        : await listDownloadedLanguageModels({
            baseURL: ollamaBaseURL,
            fetch: options.fetch,
            timeoutMs: options.discoveryTimeoutMs
          });
    } catch (error) {
      ollamaError = error;
    }
  }

  let lmStudioModels = [];
  let lmStudioError = null;
  try {
    lmStudioModels = options.listLmStudioModels
      ? normalizeProviderModels(
          await options.listLmStudioModels({
            baseURL: lmStudioBaseURL,
            apiKey: lmStudioApiKey
          }),
          {
            provider: "lm-studio",
            baseURL: lmStudioBaseURL,
            apiKey: lmStudioApiKey
          }
        )
      : await listLmStudioLanguageModels({
          baseURL: lmStudioBaseURL,
          apiKey: lmStudioApiKey,
          fetch: options.fetch,
          timeoutMs: options.discoveryTimeoutMs
        });
  } catch (error) {
    lmStudioError = error;
  }

  writeProviderStatus(output, {
    ollamaPath,
    ollamaModels,
    ollamaError,
    lmStudioModels,
    lmStudioError
  });

  const choices = buildModelChoices(ollamaModels, lmStudioModels, {
    includeOllamaDefault: Boolean(ollamaPath),
    ollamaBaseURL,
    lmStudioBaseURL,
    lmStudioApiKey
  });

  if (choices.length === 0) {
    throw new Error(
      "No local language-model provider is available. Start LM Studio's local server, or install and start Ollama, then run `privacyai onboard` again."
    );
  }

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
      await ask("Choose a model number, press Enter for the recommended model, or type another Ollama model name: ")
    ).trim();
    const choice = resolveModelChoice(answer, choices, {
      ollamaPath,
      ollamaBaseURL
    });

    if (choice.provider === "ollama" && !choice.downloaded) {
      if (!ollamaPath) {
        throw new Error(
          "Ollama is not installed. Select an LM Studio model by number, or install Ollama before entering an Ollama model name."
        );
      }
      writeLine(output, `Downloading Ollama privacy model: ${choice.name}`);
      const code = await runInherited(ollamaPath, ["pull", choice.name], options);
      if (code !== 0) {
        throw new Error(`Ollama could not download ${choice.name} (exit code ${code}).`);
      }
    } else {
      writeLine(output, `Using ${providerLabel(choice.provider)} privacy model: ${choice.name}`);
    }

    const saved = await savePrivacyConfig(
      {
        provider: choice.provider,
        baseURL: choice.baseURL,
        model: choice.name,
        apiKey: choice.apiKey || "not-required",
        timeoutMs: choice.provider === "lm-studio" ? 180000 : 60000,
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
    writeLine(output, `Provider: ${providerLabel(saved.config.provider)}`);
    writeLine(output, `Model:    ${saved.config.model}`);
    writeLine(output, "Start with: privacyai claude");
    writeLine(output, "Or use:    privacyai codex");
    writeLine(output, `Project: ${PROJECT_URL}`);
    return saved;
  } finally {
    if (closeReadline) readline.close();
  }
}

export async function listDownloadedLanguageModels(options = {}) {
  const fetchImpl = requireFetch(options.fetch);
  const baseURL = normalizeBaseURL(options.baseURL || DEFAULT_OLLAMA_BASE_URL);
  const tagsResponse = await fetchWithTimeout(
    fetchImpl,
    `${baseURL}/api/tags`,
    { headers: { accept: "application/json" } },
    options.timeoutMs
  );
  if (!tagsResponse.ok) {
    throw new Error(`Ollama returned HTTP ${tagsResponse.status} while listing models.`);
  }

  const tagsBody = await tagsResponse.json();
  const taggedModels = normalizeProviderModels(tagsBody?.models || [], {
    provider: "ollama",
    baseURL
  });
  const inspected = await Promise.all(
    taggedModels.map(async item => {
      try {
        const response = await fetchWithTimeout(
          fetchImpl,
          `${baseURL}/api/show`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json"
            },
            body: JSON.stringify({ model: item.name, verbose: false })
          },
          options.timeoutMs
        );
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

export async function listLmStudioLanguageModels(options = {}) {
  const fetchImpl = requireFetch(options.fetch);
  const baseURL = normalizeLmStudioBaseURL(options.baseURL || DEFAULT_LM_STUDIO_BASE_URL);
  const apiRoot = baseURL.replace(/\/v1$/, "");
  const apiKey = options.apiKey || "not-required";
  const response = await fetchWithTimeout(
    fetchImpl,
    `${apiRoot}/api/v0/models`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`
      }
    },
    options.timeoutMs
  );
  if (!response.ok) {
    throw new Error(`LM Studio returned HTTP ${response.status} while listing models.`);
  }

  const body = await response.json();
  const models = Array.isArray(body?.data) ? body.data : [];
  return normalizeProviderModels(
    models
      .filter(item => item?.type === "llm" || item?.type === "vlm")
      .map(item => ({
        name: item.id,
        type: item.type,
        state: item.state,
        publisher: item.publisher,
        architecture: item.arch,
        compatibilityType: item.compatibility_type,
        quantizationLevel: item.quantization,
        maxContextLength: item.max_context_length,
        loadedContextLength: item.loaded_context_length,
        capabilities: item.capabilities
      })),
    {
      provider: "lm-studio",
      baseURL,
      apiKey
    }
  );
}

export function buildModelChoices(ollamaModels = [], lmStudioModels = [], options = {}) {
  const ollamaBaseURL = normalizeBaseURL(options.ollamaBaseURL || DEFAULT_OLLAMA_BASE_URL);
  const lmStudioBaseURL = normalizeLmStudioBaseURL(
    options.lmStudioBaseURL || DEFAULT_LM_STUDIO_BASE_URL
  );
  const normalizedOllama = normalizeProviderModels(ollamaModels, {
    provider: "ollama",
    baseURL: ollamaBaseURL
  });
  const normalizedLmStudio = normalizeProviderModels(lmStudioModels, {
    provider: "lm-studio",
    baseURL: lmStudioBaseURL,
    apiKey: options.lmStudioApiKey || "not-required"
  });

  const choices = [];
  if (options.includeOllamaDefault !== false) {
    const recommended = normalizedOllama.find(item => item.name === DEFAULT_PRIVACY_MODEL);
    choices.push(
      recommended || {
        name: DEFAULT_PRIVACY_MODEL,
        provider: "ollama",
        baseURL: ollamaBaseURL,
        apiKey: "not-required",
        downloaded: false,
        capabilities: []
      }
    );
  }
  choices.push(...normalizedOllama.filter(item => item.name !== DEFAULT_PRIVACY_MODEL));

  const sortedLmStudio = [...normalizedLmStudio].sort((a, b) => {
    const loadedDifference = Number(b.state === "loaded") - Number(a.state === "loaded");
    if (loadedDifference !== 0) return loadedDifference;
    return a.name.localeCompare(b.name);
  });
  choices.push(...sortedLmStudio);

  const recommendation = chooseRecommendation(choices);
  const ordered = recommendation
    ? [
        recommendation,
        ...choices.filter(
          choice =>
            choice.provider !== recommendation.provider || choice.name !== recommendation.name
        )
      ]
    : choices;
  return ordered.map(choice => ({
    ...choice,
    recommended:
      choice.provider === recommendation?.provider && choice.name === recommendation?.name
  }));
}

export function resolveModelSelection(answer, choices) {
  return resolveModelChoice(answer, choices, {
    ollamaPath: true,
    ollamaBaseURL: DEFAULT_OLLAMA_BASE_URL
  }).name;
}

function resolveModelChoice(answer, choices, options) {
  if (!answer) {
    return choices.find(item => item.recommended) || choices[0];
  }
  if (/^\d+$/.test(answer)) {
    const index = Number(answer) - 1;
    if (index < 0 || index >= choices.length) {
      throw new Error(`Model choice must be between 1 and ${choices.length}.`);
    }
    return choices[index];
  }
  if (!options.ollamaPath) {
    throw new Error(
      "Typing a model name downloads it through Ollama. Select an LM Studio model by number, or install Ollama first."
    );
  }
  return {
    name: answer,
    provider: "ollama",
    baseURL: normalizeBaseURL(options.ollamaBaseURL || DEFAULT_OLLAMA_BASE_URL),
    apiKey: "not-required",
    downloaded: false,
    capabilities: [],
    recommended: false
  };
}

function chooseRecommendation(choices) {
  return (
    choices.find(
      item =>
        item.provider === "ollama" &&
        item.name === DEFAULT_PRIVACY_MODEL &&
        item.downloaded !== false
    ) ||
    choices.find(
      item => item.provider === "lm-studio" && /(^|\/)ministral-3-3b$/i.test(item.name)
    ) ||
    choices.find(
      item => item.provider === "ollama" && item.name === DEFAULT_PRIVACY_MODEL
    ) ||
    choices[0]
  );
}

function normalizeProviderModels(models, defaults) {
  const seen = new Set();
  const normalized = [];
  for (const model of models || []) {
    const source = typeof model === "string" ? { name: model } : model || {};
    const name = String(source.name || source.model || source.id || "").trim();
    const provider = String(source.provider || defaults.provider || "").trim();
    const key = `${provider}\0${name}`;
    if (!name || !provider || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      name,
      provider,
      baseURL: normalizeProviderBaseURL(
        provider,
        source.baseURL || defaults.baseURL
      ),
      apiKey: source.apiKey || defaults.apiKey || "not-required",
      downloaded: source.downloaded !== false,
      size: Number(source.size || 0),
      parameterSize: source.parameterSize || source.details?.parameter_size || "",
      quantizationLevel:
        source.quantizationLevel || source.quantization || source.details?.quantization_level || "",
      capabilities: Array.isArray(source.capabilities) ? source.capabilities : [],
      type: source.type || "",
      state: source.state || "",
      publisher: source.publisher || "",
      architecture: source.architecture || source.arch || "",
      compatibilityType: source.compatibilityType || source.compatibility_type || "",
      maxContextLength: Number(source.maxContextLength || source.max_context_length || 0),
      loadedContextLength: Number(source.loadedContextLength || source.loaded_context_length || 0)
    });
  }
  return normalized;
}

function writeProviderStatus(output, status) {
  if (!status.ollamaPath) {
    writeLine(output, "Ollama: not installed.");
  } else if (status.ollamaError) {
    writeLine(output, "Ollama: installed, but its local server is not currently reachable.");
  } else {
    writeLine(output, `Ollama: ${status.ollamaModels.length} usable downloaded model(s).`);
  }

  if (status.lmStudioError) {
    writeLine(output, "LM Studio: local server not detected at the configured address.");
  } else {
    writeLine(output, `LM Studio: ${status.lmStudioModels.length} usable downloaded model(s).`);
  }
}

function writeModelChoices(output, choices) {
  writeLine(output, "Available local language models:");
  choices.forEach((model, index) => {
    const labels = [];
    if (model.recommended) labels.push("recommended");
    labels.push(providerLabel(model.provider));
    if (model.provider === "ollama") {
      labels.push(model.downloaded === false ? "not downloaded" : "downloaded");
    } else if (model.state) {
      labels.push(model.state);
    } else {
      labels.push("downloaded");
    }
    if (model.type) labels.push(model.type.toUpperCase());
    if (model.parameterSize) labels.push(model.parameterSize);
    if (model.quantizationLevel) labels.push(model.quantizationLevel);
    if (model.maxContextLength) labels.push(`${formatCompactNumber(model.maxContextLength)} ctx`);
    if (model.size) labels.push(formatBytes(model.size));
    writeLine(output, `  ${index + 1}. ${model.name} (${labels.join(", ")})`);
  });
  writeLine(output, "Select an LM Studio model by number, or type another Ollama model name to download it.");
}

function providerLabel(provider) {
  if (provider === "lm-studio") return "LM Studio";
  if (provider === "ollama") return "Ollama";
  return provider;
}

function normalizeProviderBaseURL(provider, baseURL) {
  return provider === "lm-studio"
    ? normalizeLmStudioBaseURL(baseURL || DEFAULT_LM_STUDIO_BASE_URL)
    : normalizeBaseURL(baseURL || DEFAULT_OLLAMA_BASE_URL);
}

function normalizeLmStudioBaseURL(value) {
  const baseURL = normalizeBaseURL(value || DEFAULT_LM_STUDIO_BASE_URL);
  return baseURL.endsWith("/v1") ? baseURL : `${baseURL}/v1`;
}

function normalizeBaseURL(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function requireFetch(fetchImpl) {
  const resolved = fetchImpl || globalThis.fetch;
  if (typeof resolved !== "function") {
    throw new Error("A fetch implementation is required to inspect local models.");
  }
  return resolved;
}

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 1500);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

function formatCompactNumber(value) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
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
