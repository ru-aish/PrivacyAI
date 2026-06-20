import { createBrowserClient, localSanitize } from "@privacy-ai/sdk/browser";
import { getEffectiveConfig, hasRemoteProvider } from "../config.js";
import { getStoredConfig } from "./config-store.js";

let privateClient = null;

export function invalidateClientCache() {
  privateClient = null;
}

async function getClient() {
  if (!privateClient) {
    const data = await getStoredConfig();
    const config = getEffectiveConfig(data);

    privateClient = createBrowserClient({
      provider: config.provider,
      model: config.model,
      baseURL: config.baseUrl,
      apiKey: config.apiKey
    });
  }
  return privateClient;
}

export async function sanitizeText(text, context) {
  const stored = await getStoredConfig();
  const config = getEffectiveConfig(stored);

  if (!hasRemoteProvider(stored)) {
    console.log("PrivacyAI: no provider configured, using local regex sanitization");
    return localSanitize(text);
  }

  try {
    const client = await getClient();
    console.log("PrivacyAI: sanitizing via API", {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      contextTurns: context?.length ?? 0
    });
    return await client.sanitize(text, { context });
  } catch (error) {
    console.error("Sanitization error details:", error, error.details || error.message);
    console.log("PrivacyAI: API failed, falling back to local regex sanitization");
    return localSanitize(text);
  }
}
