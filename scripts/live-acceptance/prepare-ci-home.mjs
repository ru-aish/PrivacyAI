#!/usr/bin/env node
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  absolute,
  ensurePrivateDirectory,
  one,
  parseRepeatedArgs,
  writeJson,
  writePrivateFile
} from "./common.mjs";

const AGY_AUTH_PATHS = Object.freeze({
  "antigravity-oauth-token": [".gemini", "antigravity-cli", "antigravity-oauth-token"],
  installation_id: [".gemini", "antigravity-cli", "installation_id"],
  "jetski_state.pbtxt": [".gemini", "antigravity-cli", "jetski_state.pbtxt"],
  "settings.json": [".gemini", "antigravity-cli", "settings.json"],
  "config.json": [".gemini", "config", "config.json"]
});

export async function prepareCiHome(options) {
  const home = absolute(options.home);
  const providers = normalizeProviders(options.providers);
  const model = String(options.model || "").trim();
  const apiKey = String(options.apiKey || "");
  if (!model) throw new Error("PRIVACYAI_CI_SANITIZER_MODEL is required.");
  if (!apiKey) throw new Error("MISTRAL_API_KEY is required.");
  if (providers.includes("codex") && !options.codexAuthJson) {
    throw new Error("CODEX_AUTH_JSON is required for the selected provider set.");
  }
  if (providers.includes("agy") && !options.agyAuthJson) {
    throw new Error("AGY_AUTH_JSON is required for the selected provider set.");
  }
  if (options.reset !== false) await rm(home, { recursive: true, force: true });
  await ensurePrivateDirectory(home);

  const configPath = join(home, ".config", "privacyai", "config.json");
  await writeJson(configPath, {
    version: 1,
    provider: "openai-compatible",
    model,
    baseURL: String(options.baseURL || "https://api.mistral.ai/v1").replace(/\/+$/, ""),
    apiKey,
    timeoutMs: Number(options.timeoutMs || 120_000),
    numCtx: Number(options.numCtx || 32_768),
    fallbackNumCtx: Number(options.fallbackNumCtx || 16_384),
    onboardedAt: new Date().toISOString()
  }, { private: true });

  if (options.codexAuthJson) {
    const parsed = parseJsonSecret(options.codexAuthJson, "CODEX_AUTH_JSON");
    await writeJson(join(home, ".codex", "auth.json"), parsed, { private: true });
  }
  if (options.agyAuthJson) await writeAgyAuth(home, options.agyAuthJson);

  for (const directory of [
    join(home, ".cache"),
    join(home, ".local", "share"),
    join(home, ".config"),
    join(home, ".codex"),
    join(home, ".gemini")
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  const paths = {
    home,
    configPath,
    codexHome: join(home, ".codex"),
    geminiDir: join(home, ".gemini"),
    cacheHome: join(home, ".cache"),
    dataHome: join(home, ".local", "share"),
    configHome: join(home, ".config"),
    contextDb: join(home, ".local", "share", "privacyai", "context-gateway.sqlite3"),
    lineageDb: join(home, ".local", "share", "privacyai", "lineage.sqlite3"),
    identityKey: join(home, ".local", "share", "privacyai", "identity", "key-v1.json"),
    vaultDir: join(home, ".local", "share", "privacyai", "agent-sessions")
  };
  await writeJson(join(home, "ci-paths.json"), paths, { private: true });
  return paths;
}

async function writeAgyAuth(home, raw) {
  const parsed = parseJsonSecret(raw, "AGY_AUTH_JSON");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGY_AUTH_JSON must be an object of approved file names to base64 values.");
  }
  const keys = Object.keys(parsed);
  if (!keys.includes("antigravity-oauth-token")) {
    throw new Error("AGY_AUTH_JSON must include antigravity-oauth-token.");
  }
  for (const key of keys) {
    const components = AGY_AUTH_PATHS[key];
    if (!components) throw new Error(`AGY_AUTH_JSON contains unsupported file: ${key}`);
    const bytes = decodeBase64(parsed[key], key);
    await writePrivateFile(join(home, ...components), bytes);
  }
}

function parseJsonSecret(raw, name) {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

function normalizeProviders(value) {
  const normalized = String(value || "both").toLowerCase();
  if (normalized === "both") return ["codex", "agy"];
  if (normalized === "codex" || normalized === "agy") return [normalized];
  throw new Error("providers must be both, codex, or agy.");
}

function decodeBase64(value, name) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error(`${name} must be non-empty base64.`);
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error(`${name} must be canonical base64.`);
  }
  return bytes;
}

async function main() {
  const values = parseRepeatedArgs(process.argv.slice(2));
  const paths = await prepareCiHome({
    home: one(values, "--home", { required: true }),
    providers: one(values, "--providers", { defaultValue: "both" }),
    model: process.env.PRIVACYAI_CI_SANITIZER_MODEL,
    apiKey: process.env.MISTRAL_API_KEY,
    baseURL: process.env.PRIVACYAI_CI_SANITIZER_BASE_URL,
    codexAuthJson: process.env.CODEX_AUTH_JSON,
    agyAuthJson: process.env.AGY_AUTH_JSON
  });
  process.stdout.write(`Prepared isolated live-review home at ${paths.home}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
