import { createPrivacyError } from "@privacy-ai/sdk";

import { antigravityProviderAdapter } from "./antigravity-provider-adapter.js";
import { claudeProviderAdapter } from "./claude-provider-adapter.js";
import { codexProviderAdapter } from "./codex-provider-adapter.js";

const PROVIDERS = Object.freeze([
  claudeProviderAdapter,
  codexProviderAdapter,
  antigravityProviderAdapter
]);
const PROVIDERS_BY_NAME = buildProviderLookup(PROVIDERS);

export function listProviderAdapters() {
  return PROVIDERS;
}

export function getProviderAdapter(name) {
  const normalized = normalizedProviderName(name);
  return normalized ? PROVIDERS_BY_NAME.get(normalized) || null : null;
}

export function requireProviderAdapter(name) {
  const adapter = getProviderAdapter(name);
  if (adapter) return adapter;
  const label = safeProviderLabel(name);
  throw createPrivacyError({
    code: "PRIVACYAI_UNSUPPORTED_AGENT_PROVIDER",
    category: "internal",
    phase: "startup",
    status: 400,
    retryable: false,
    message: `PrivacyAI does not support the agent provider ${label}.`,
    publicMessage: "PrivacyAI does not support the requested agent provider."
  });
}

function buildProviderLookup(adapters) {
  const lookup = new Map();
  for (const adapter of adapters) {
    for (const name of [adapter.id, ...adapter.aliases]) {
      if (lookup.has(name)) {
        throw new TypeError(`PrivacyAI provider adapter name ${name} is registered more than once.`);
      }
      lookup.set(name, adapter);
    }
  }
  return lookup;
}

function normalizedProviderName(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function safeProviderLabel(value) {
  const normalized = normalizedProviderName(value);
  return /^[a-z][a-z0-9-]{1,63}$/.test(normalized)
    ? JSON.stringify(normalized)
    : "requested by the caller";
}
