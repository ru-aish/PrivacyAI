export function getEffectiveConfig(data = {}) {
  const config = {
    provider: data.provider || "openai-compatible",
    model: data.model || "gemini-1.5-flash",
    baseUrl: data.baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: data.apiKey || "",
    sanitizeContextBeforeProvider: data.sanitizeContextBeforeProvider !== undefined
      ? data.sanitizeContextBeforeProvider
      : isRemoteProviderUrl(data.baseUrl || "https://generativelanguage.googleapis.com/v1beta/openai")
  };

  if (!config.apiKey.trim() && isLocalProviderUrl(config.baseUrl)) {
    config.apiKey = config.provider === "ollama" ? "ollama" : "local";
  }

  return config;
}

export function hasRemoteProvider(data = {}) {
  const config = getEffectiveConfig(data);
  if (config.provider === "ollama") return true;
  if (isLocalProviderUrl(config.baseUrl)) return true;
  return Boolean(config.apiKey && config.apiKey.trim());
}

export function isRemoteProvider(data = {}) {
  const config = getEffectiveConfig(data);
  return !isLocalProviderUrl(config.baseUrl) && Boolean(config.apiKey?.trim());
}

export function isLocalProviderUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

export function isRemoteProviderUrl(baseUrl) {
  if (!baseUrl) return false;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname !== "127.0.0.1" && hostname !== "localhost";
  } catch {
    return false;
  }
}

export const PROVIDER_PRESETS = {
  ollama: {
    provider: "ollama",
    model: "qwen3.5:2b",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: "ollama"
  },
  lmstudio: {
    provider: "openai-compatible",
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "lm-studio"
  }
};
