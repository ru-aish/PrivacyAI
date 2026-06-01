import fs from "node:fs";
import path from "node:path";

const ENV_KEY_MAP = {
  apiKey: ["PRIVATE_AI_API_KEY", "OPENAI_API_KEY"],
  baseURL: ["PRIVATE_AI_BASE_URL", "OPENAI_BASE_URL"],
  model: ["PRIVATE_AI_MODEL", "OPENAI_MODEL"],
  provider: ["PRIVATE_AI_PROVIDER"],
  timeoutMs: ["PRIVATE_AI_TIMEOUT_MS", "OPENAI_TIMEOUT_MS"],
  numCtx: ["PRIVATE_AI_NUM_CTX"],
  localDetectorEnabled: ["PRIVATE_AI_LOCAL_DETECTOR_ENABLED"],
  localDetectorModel: ["PRIVATE_AI_LOCAL_DETECTOR_MODEL"]
};

export function loadEnvFile(envFile = process.env.PRIVATE_AI_ENV_FILE || ".env", cwd = process.cwd()) {
  const resolved = path.isAbsolute(envFile) ? envFile : path.join(cwd, envFile);
  if (!fs.existsSync(resolved)) {
    return {};
  }

  const env = {};
  const lines = fs.readFileSync(resolved, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    env[key] = stripEnvQuotes(rawValue.trim());
  }
  return env;
}

export function configFromEnv(options = {}) {
  const fileEnv = options.loadEnv === false ? {} : loadEnvFile(options.envFile, options.cwd);
  const merged = { ...fileEnv, ...process.env };

  return {
    apiKey: firstValue(merged, ENV_KEY_MAP.apiKey) || "not-required",
    baseURL: normalizeBaseURL(firstValue(merged, ENV_KEY_MAP.baseURL) || "http://127.0.0.1:11434/v1"),
    model: firstValue(merged, ENV_KEY_MAP.model) || "qwen3.5:2b",
    provider: firstValue(merged, ENV_KEY_MAP.provider) || "openai-compatible",
    timeoutMs: Number(firstValue(merged, ENV_KEY_MAP.timeoutMs) || 60000),
    numCtx: Number(firstValue(merged, ENV_KEY_MAP.numCtx) || 4096),
    localDetectorEnabled: parseBoolean(firstValue(merged, ENV_KEY_MAP.localDetectorEnabled)),
    localDetectorModel: firstValue(merged, ENV_KEY_MAP.localDetectorModel)
  };
}

export function normalizeBaseURL(baseURL) {
  return String(baseURL).replace(/\/+$/, "");
}

function firstValue(env, keys) {
  for (const key of keys) {
    if (env[key] !== undefined && env[key] !== "") return env[key];
  }
  return undefined;
}

function parseBoolean(value) {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function stripEnvQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
