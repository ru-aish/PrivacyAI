const PROTECTED_PROVIDER_ID = "privacyai";

export const CODEX_GATEWAY_DISABLED_FEATURES = Object.freeze([
  "enable_request_compression",
  "responses_websockets",
  "responses_websockets_v2",
  "realtime_conversation",
  "standalone_web_search",
  "search_tool",
  "apps",
  "enable_mcp_apps",
  "in_app_browser",
  "browser_use",
  "computer_use",
  "remote_plugin",
  "image_generation"
]);

export function buildCodexProviderArgs(baseURL, options = {}) {
  const parsed = new URL(baseURL);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new TypeError("Codex PrivacyAI provider must use a literal IPv4 loopback URL.");
  }

  const providerFields = [
    `name=${tomlString(options.providerName || "OpenAI through PrivacyAI")}`,
    `base_url=${tomlString(parsed.toString().replace(/\/$/, ""))}`,
    'wire_api="responses"',
    "requires_openai_auth=true",
    "supports_websockets=false"
  ];
  for (const [field, value] of [
    ["request_max_retries", options.requestMaxRetries],
    ["stream_max_retries", options.streamMaxRetries]
  ]) {
    if (value == null) continue;
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw new TypeError(`${field} must be an integer between 0 and 100.`);
    }
    providerFields.push(`${field}=${value}`);
  }
  const provider = providerFields.join(",");

  return [
    "-c",
    'web_search="disabled"',
    "-c",
    `model_provider=${tomlString(PROTECTED_PROVIDER_ID)}`,
    "-c",
    `model_providers.${PROTECTED_PROVIDER_ID}={${provider}}`,
    ...CODEX_GATEWAY_DISABLED_FEATURES.flatMap(feature => ["--disable", feature])
  ];
}

export function isProtectedCodexConfigOverride(value) {
  const assignment = String(value || "").trim();
  const key = assignment.split("=", 1)[0].trim();
  if (!key) return false;
  return (
    key === "model_provider" ||
    key === "model_providers" ||
    key.startsWith("model_providers.") ||
    key === "openai_base_url" ||
    key === "chatgpt_base_url" ||
    key === "web_search" ||
    key === "enable_request_compression" ||
    key === "features.enable_request_compression" ||
    key === "features.responses_websockets" ||
    key === "features.responses_websockets_v2"
  );
}

export function parseCodexPrivacyMode(args, options = {}) {
  const explicit = [];
  const forwarded = [];
  for (const raw of args) {
    const arg = String(raw);
    if (arg === "--privacy-strict") explicit.push("strict");
    else if (arg === "--privacy-gateway") explicit.push("gateway");
    else forwarded.push(raw);
  }
  if (new Set(explicit).size > 1) {
    throw new Error("Choose only one Codex privacy mode: --privacy-gateway or --privacy-strict.");
  }
  const configured = options.mode || process.env.PRIVACYAI_CODEX_MODE || "gateway";
  const mode = explicit.at(-1) || configured;
  if (!new Set(["gateway", "strict"]).has(mode)) {
    throw new Error(`Unsupported PrivacyAI Codex mode: ${mode}`);
  }
  return { mode, args: forwarded };
}

function tomlString(value) {
  return JSON.stringify(String(value));
}
