import { joinCodexArguments, splitCodexArguments } from "./codex-arguments.js";

const PROTECTED_PROVIDER_ID = "privacyai";

export const CODEX_GATEWAY_DISABLED_FEATURES = Object.freeze([
  "enable_request_compression",
  "responses_websockets",
  "responses_websockets_v2",
  "realtime_conversation",
  "apps",
  "enable_mcp_apps",
  "in_app_browser",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "remote_plugin"
]);

export function resolveCodexHostedToolPolicy(args = []) {
  let webSearch = false;
  let imageGeneration = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === "--") break;
    if (arg === "--search") webSearch = true;
    if (arg === "--enable" || arg === "--disable") {
      const feature = String(args[index + 1] || "");
      if (feature === "image_generation") imageGeneration = arg === "--enable";
      index += 1;
      continue;
    }
    if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      const enabled = arg.startsWith("--enable=");
      const feature = arg.slice(arg.indexOf("=") + 1);
      if (feature === "image_generation") imageGeneration = enabled;
      continue;
    }
    if (arg === "-c" || arg === "--config") {
      const assignment = String(args[index + 1] || "");
      const imageToggle = parseBooleanFeatureAssignment(assignment, "image_generation");
      if (imageToggle != null) imageGeneration = imageToggle;
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const imageToggle = parseBooleanFeatureAssignment(
        arg.slice("--config=".length),
        "image_generation"
      );
      if (imageToggle != null) imageGeneration = imageToggle;
    }
  }
  return Object.freeze({ webSearch, imageGeneration });
}

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
  // PrivacyAI owns retry policy at the gateway boundary. Letting Codex replay a
  // transformed request hides deterministic failures behind reconnect loops and
  // can repeat stateful tool/history processing.
  for (const [field, value] of [
    ["request_max_retries", options.requestMaxRetries ?? 0],
    ["stream_max_retries", options.streamMaxRetries ?? 0]
  ]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw new TypeError(`${field} must be an integer between 0 and 100.`);
    }
    providerFields.push(`${field}=${value}`);
  }
  const provider = providerFields.join(",");

  return [
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
  const parts = splitCodexArguments(args);
  const explicit = [];
  const forwarded = [];
  for (const arg of parts.beforeDelimiter) {
    if (arg === "--privacy-strict") explicit.push("strict");
    else if (arg === "--privacy-gateway") explicit.push("gateway");
    else forwarded.push(arg);
  }
  if (new Set(explicit).size > 1) {
    throw new Error("Choose only one Codex privacy mode: --privacy-gateway or --privacy-strict.");
  }
  const configured = options.mode || process.env.PRIVACYAI_CODEX_MODE || "gateway";
  const mode = explicit.at(-1) || configured;
  if (!new Set(["gateway", "strict"]).has(mode)) {
    throw new Error(`Unsupported PrivacyAI Codex mode: ${mode}`);
  }
  return {
    mode,
    args: joinCodexArguments({ ...parts, beforeDelimiter: forwarded })
  };
}

function parseBooleanFeatureAssignment(value, feature) {
  const assignment = String(value || "").trim();
  const match = assignment.match(/^features\.([A-Za-z0-9_-]+)\s*=\s*(true|false|1|0|"true"|"false")$/i);
  if (!match || match[1] !== feature) return null;
  return new Set(["true", "1", '"true"']).has(match[2].toLowerCase());
}

function tomlString(value) {
  return JSON.stringify(String(value));
}
