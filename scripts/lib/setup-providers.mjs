import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { isInteractive, log, prompt, promptChoice, promptSecret, runQuiet } from "./setup-ui.mjs";

const IS_WIN = platform() === "win32";

const PROVIDERS = {
  ollama: {
    name: "ollama",
    label: "Ollama",
    type: "ollama",
    baseURL: "http://127.0.0.1:11434",
    apiKey: "ollama",
    model: "qwen3.5:2b",
    needsApiKey: false
  },
  lmstudio: {
    name: "lmstudio",
    label: "LM Studio",
    type: "openai-compatible",
    baseURL: "http://localhost:1234/v1",
    apiKey: "lm-studio",
    model: "qwen2.5-coder-3b-instruct",
    needsApiKey: false
  },
  openai: {
    name: "openai",
    label: "OpenAI",
    type: "openai-compatible",
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4.1-mini",
    needsApiKey: true
  },
  gemini: {
    name: "gemini",
    label: "Gemini",
    type: "openai-compatible",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "",
    model: "gemini-2.5-flash",
    needsApiKey: true
  },
  groq: {
    name: "groq",
    label: "Groq",
    type: "openai-compatible",
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: "",
    model: "llama-3.3-70b-versatile",
    needsApiKey: true
  },
  custom: {
    name: "custom",
    label: "Custom",
    type: "openai-compatible",
    baseURL: "",
    apiKey: "",
    model: "",
    needsApiKey: false
  }
};

const MENU = [
  { key: "ollama", label: "Ollama (local)" },
  { key: "lmstudio", label: "LM Studio (local)" },
  { key: "openai", label: "OpenAI (cloud)" },
  { key: "gemini", label: "Gemini (cloud)" },
  { key: "groq", label: "Groq (cloud)" },
  { key: "custom", label: "Custom" }
];

function normalizeBaseURL(value) {
  return String(value || "").replace(/\/+$/, "");
}

function commandExists(command) {
  const checker = IS_WIN ? "where" : "command";
  const checkerArgs = IS_WIN ? [command] : ["-v", command];
  const result = spawnSync(checker, checkerArgs, { stdio: "ignore", shell: IS_WIN });
  return result.status === 0;
}

function cloneProvider(key) {
  return { ...PROVIDERS[key] };
}

export async function testConnection(provider) {
  const baseURL = normalizeBaseURL(provider.baseURL);

  try {
    if (provider.type === "ollama") {
      const response = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        return { ok: false, details: `HTTP ${response.status}` };
      }
      return { ok: true, details: "" };
    }

    const response = await fetch(`${baseURL}/models`, {
      headers: { authorization: `Bearer ${provider.apiKey || "not-required"}` },
      signal: AbortSignal.timeout(20_000)
    });

    if (!response.ok) {
      const body = await response.text();
      return { ok: false, details: body.slice(0, 300) || `HTTP ${response.status}` };
    }

    return { ok: true, details: "" };
  } catch (error) {
    return {
      ok: false,
      details: error instanceof Error ? error.message : "Connection failed."
    };
  }
}

async function ensureOllamaRunning(provider, rootDir) {
  const result = await testConnection(provider);
  if (result.ok) return true;

  if (!commandExists("ollama")) {
    log("Ollama is not installed. Get it from https://ollama.com/download");
    return false;
  }

  log("Starting Ollama...");
  const logPath = path.join(rootDir, ".ollama.log");
  const out = fs.openSync(logPath, "a");
  const child = spawn("ollama", ["serve"], {
    detached: true,
    stdio: ["ignore", out, out],
    shell: IS_WIN
  });
  child.unref();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const retry = await testConnection(provider);
    if (retry.ok) return true;
  }

  return false;
}

async function pullModelIfNeeded(model, rootDir) {
  if (!commandExists("ollama")) return true;

  const listed = spawnSync("ollama", ["list"], { encoding: "utf8", shell: IS_WIN });
  if (listed.status === 0 && listed.stdout.split("\n").some((line) => line.trim().startsWith(model))) {
    log(`Model already present: ${model}`);
    return true;
  }

  const ok = await runQuiet("ollama", ["pull", model], `Pulling model: ${model}`, {
    cwd: rootDir,
    shell: IS_WIN
  });

  if (!ok) {
    log(`Model pull failed. Retry later with: ollama pull ${model}`);
  }

  return ok;
}

export function writeEnvFile(envFile, provider) {
  const contents = [
    `PRIVATE_AI_PROVIDER=${provider.type}`,
    `PRIVATE_AI_BASE_URL=${provider.baseURL}`,
    `PRIVATE_AI_API_KEY=${provider.apiKey}`,
    `PRIVATE_AI_MODEL=${provider.model}`,
    "PRIVATE_AI_NUM_CTX=8192",
    "PRIVATE_AI_TIMEOUT_MS=120000",
    "PRIVATE_AI_LOCAL_DETECTOR_ENABLED=false",
    ""
  ].join("\n");

  fs.writeFileSync(envFile, contents, "utf8");
}

async function collectCustomValues(provider) {
  provider.baseURL = await prompt("Base URL (OpenAI-compatible /v1 endpoint)", provider.baseURL);
  provider.apiKey = await prompt("API key (leave blank if not required)", provider.apiKey);
  provider.model = await prompt("Model", provider.model);
  provider.type = await prompt("Provider type (ollama or openai-compatible)", provider.type);
}

async function collectApiKey(provider) {
  while (!provider.apiKey) {
    provider.apiKey = await promptSecret(`${provider.label} API key`);
    if (!provider.apiKey) {
      log(`An API key is required for ${provider.label}.`);
    }
  }
}

async function handleFailure(provider, details, rootDir) {
  while (true) {
    log("");
    log(`Connection failed for ${provider.label}.`);
    if (details) {
      log("Details:");
      for (const line of details.split("\n").slice(0, 5)) {
        log(`  ${line}`);
      }
    }
    log("");
    log("  1) Retry");
    log("  2) Change URL");
    if (provider.needsApiKey) {
      log("  3) Change API key");
      log("  4) Choose a different provider");
    } else if (provider.name === "ollama") {
      log("  3) Start Ollama");
      log("  4) Choose a different provider");
    } else {
      log("  3) Choose a different provider");
    }

    const choice = await promptChoice("What would you like to do", "1");

    if (choice === "1") return "retry";
    if (choice === "2") {
      provider.baseURL = await prompt("Base URL", provider.baseURL);
      return "retry";
    }
    if (choice === "3" && provider.needsApiKey) {
      provider.apiKey = "";
      await collectApiKey(provider);
      return "retry";
    }
    if (choice === "3" && provider.name === "ollama") {
      await ensureOllamaRunning(provider, rootDir);
      return "retry";
    }
    if (choice === "3" || choice === "4") return "restart";
    log("Please choose a valid option.");
  }
}

async function configureInteractive(rootDir) {
  while (true) {
    log("");
    log("Choose your AI provider:");
    log("");
    MENU.forEach((item, index) => {
      log(`  ${index + 1}) ${item.label}`);
    });
    log("");

    const choice = await promptChoice("Enter choice", "1");
    const index = Number(choice) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= MENU.length) {
      log("Invalid choice. Try again.");
      continue;
    }

    const provider = cloneProvider(MENU[index].key);
    if (provider.name === "custom") {
      await collectCustomValues(provider);
    } else if (provider.needsApiKey) {
      await collectApiKey(provider);
    }

    if (provider.name === "ollama") {
      await ensureOllamaRunning(provider, rootDir);
    }

    while (true) {
      log("");
      log(`Testing ${provider.label} at ${provider.baseURL}...`);
      const result = await testConnection(provider);

      if (result.ok) {
        log(`✓ ${provider.label} is reachable.`);
        if (provider.name === "ollama") {
          await pullModelIfNeeded(provider.model, rootDir);
        }
        return provider;
      }

      const action = await handleFailure(provider, result.details, rootDir);
      if (action === "restart") break;
    }
  }
}

async function configureNonInteractive(rootDir) {
  const selected = process.env.PRIVACY_AI_SETUP_PROVIDER || "ollama";
  const provider = cloneProvider(PROVIDERS[selected] ? selected : "ollama");

  if (provider.needsApiKey) {
    provider.apiKey = process.env.PRIVATE_AI_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!provider.apiKey) {
      throw new Error(`Missing API key for ${provider.label}. Set PRIVATE_AI_API_KEY before non-interactive setup.`);
    }
  }

  if (provider.name === "ollama") {
    const running = await ensureOllamaRunning(provider, rootDir);
    if (!running) throw new Error("Ollama is not reachable.");
    await pullModelIfNeeded(provider.model, rootDir);
  }

  const result = await testConnection(provider);
  if (!result.ok) {
    throw new Error(`Connection failed for ${provider.label}: ${result.details}`);
  }

  log(`✓ ${provider.label} is reachable.`);
  return provider;
}

export async function configureProvider(rootDir) {
  return isInteractive() ? configureInteractive(rootDir) : configureNonInteractive(rootDir);
}