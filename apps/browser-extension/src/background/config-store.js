import { PROVIDER_PRESETS } from "../config.js";

export async function getStoredConfig() {
  return chrome.storage.local.get(["provider", "model", "baseUrl", "apiKey"]);
}

export async function initializeDefaultConfig() {
  const data = await chrome.storage.local.get(["provider", "baseUrl"]);
  if (!data.provider && !data.baseUrl) {
    await chrome.storage.local.set({
      shieldEnabled: true,
      ...PROVIDER_PRESETS.ollama
    });
    console.log("PrivacyAI: seeded default Ollama provider config");
  }
}
