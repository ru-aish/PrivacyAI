import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS,
  createPrivacyError,
  normalizeClassifierConcurrency,
  normalizeLocalModelContextTokens,
  normalizeOllamaKeepAlive
} from "@privacy-ai/sdk";

const CONFIG_VERSION = 1;

export function defaultConfigPath() {
  return resolve(
    process.env.PRIVACYAI_CONFIG_FILE ||
      join(
        process.env.PRIVACYAI_CONFIG_DIR || join(homedir(), ".config", "privacyai"),
        "config.json"
      )
  );
}

export async function loadPrivacyConfig(options = {}) {
  const path = resolve(options.path || defaultConfigPath());
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return { configured: true, path, config: normalizeConfig(parsed) };
  } catch (error) {
    if (error?.code === "ENOENT") return { configured: false, path, config: null };
    throw createPrivacyError({
      code: "PRIVACYAI_CONFIG_INVALID",
      category: "storage",
      phase: "storage_read",
      message: "PrivacyAI configuration is invalid or unreadable.",
      publicMessage: "PrivacyAI configuration is invalid or unreadable.",
      cause: error
    });
  }
}

export async function savePrivacyConfig(config, options = {}) {
  const path = resolve(options.path || defaultConfigPath());
  const normalized = normalizeConfig(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, path);
  return { path, config: normalized };
}

export function normalizeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("PrivacyAI configuration must be an object.");
  }

  const provider = String(value.provider || "ollama").trim();
  const model = String(value.model || "").trim();
  const baseURL = String(value.baseURL || "").trim().replace(/\/+$/, "");

  if (!model) throw new TypeError("PrivacyAI configuration requires a model.");
  if (!baseURL) throw new TypeError("PrivacyAI configuration requires a baseURL.");
  if (!new Set(["ollama", "lm-studio", "openai-compatible"]).has(provider)) {
    throw new TypeError(`Unsupported PrivacyAI provider: ${provider}`);
  }
  assertLocalPrivacyEndpoint(baseURL);

  const numCtx = normalizeLocalModelContextTokens(
    value.numCtx,
    DEFAULT_LOCAL_MODEL_CONTEXT_TOKENS
  );
  const fallbackNumCtx = normalizeFallbackContext(value.fallbackNumCtx, numCtx);

  return {
    version: CONFIG_VERSION,
    provider,
    model,
    baseURL,
    apiKey: typeof value.apiKey === "string" && value.apiKey ? value.apiKey : "not-required",
    timeoutMs: Number.isFinite(Number(value.timeoutMs)) ? Number(value.timeoutMs) : 60000,
    numCtx,
    fallbackNumCtx,
    keepAlive: normalizeOllamaKeepAlive(value.keepAlive, DEFAULT_OLLAMA_KEEP_ALIVE),
    classifierConcurrency: normalizeClassifierConcurrency(value.classifierConcurrency),
    onboardedAt: value.onboardedAt || new Date().toISOString()
  };
}


function normalizeFallbackContext(value, numCtx) {
  if (value != null) {
    const fallback = normalizeLocalModelContextTokens(value);
    if (fallback >= numCtx) {
      throw new TypeError("fallbackNumCtx must be smaller than numCtx.");
    }
    return fallback;
  }
  if (numCtx <= 2048) return null;
  return Math.min(
    OLLAMA_MEMORY_FALLBACK_CONTEXT_TOKENS,
    Math.max(2048, Math.floor(numCtx * 0.75))
  );
}

export function assertLocalPrivacyEndpoint(baseURL, options = {}) {
  const allowRemote =
    options.allowRemote === true || process.env.PRIVACYAI_ALLOW_REMOTE_SANITIZER === "1";
  if (allowRemote) return;

  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new TypeError("PrivacyAI baseURL must be a valid URL.");
  }

  const hostname = parsed.hostname.toLowerCase();
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const isIpv4Loopback =
    isIP(unbracketedHostname) === 4 && unbracketedHostname.split(".")[0] === "127";
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIpv4Loopback ||
    unbracketedHostname === "::1";

  if (!isLoopback) {
    throw new TypeError(
      "PrivacyAI refuses a remote sanitizer endpoint by default because raw prompts are sent to the sanitizer. " +
        "Use a loopback address, or explicitly set PRIVACYAI_ALLOW_REMOTE_SANITIZER=1."
    );
  }
}
