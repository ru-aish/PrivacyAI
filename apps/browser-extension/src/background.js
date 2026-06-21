import { createBrowserClient, localSanitize } from "@privacy-ai/sdk/browser";
import { getEffectiveConfig, hasRemoteProvider, isRemoteProvider, PROVIDER_PRESETS } from "./config.js";
import { isSupportedChatUrl } from "./supported-sites.js";


let privateClient = null;

console.log("PrivacyAI background service worker loaded");

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tabId && isSupportedChatUrl(tab.url)) {
    injectPageBridge(tabId).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["provider", "baseUrl"]);
  if (!data.provider && !data.baseUrl) {
    await chrome.storage.local.set({
      shieldEnabled: true,
      ...PROVIDER_PRESETS.ollama
    });
    console.log("PrivacyAI: seeded default Ollama provider config");
  }
});

async function getStoredConfig() {
  return chrome.storage.local.get(["provider", "model", "baseUrl", "apiKey", "sanitizeContextBeforeProvider"]);
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

async function sanitizeText(text, context) {
  const stored = await getStoredConfig();
  const config = getEffectiveConfig(stored);

  if (!hasRemoteProvider(stored)) {
    console.log("PrivacyAI: no provider configured, using local regex sanitization");
    return localSanitize(text);
  }

  let contextToSend = context;
  const remoteMode = isRemoteProvider(stored);
  const sanitizeContext = config.sanitizeContextBeforeProvider === true || (remoteMode && config.sanitizeContextBeforeProvider !== false);

  if (sanitizeContext && Array.isArray(context) && context.length > 0) {
    console.log("PrivacyAI: sanitizing context before sending to remote provider");
    contextToSend = await Promise.all(context.map(async (turn) => {
      const sanitized = await localSanitize(turn.text);
      return { ...turn, text: sanitized.sanitizedText };
    }));
  } else if (!sanitizeContext && remoteMode && Array.isArray(context) && context.length > 0) {
    console.warn("PrivacyAI: forwarding raw context to remote provider - enable sanitizeContextBeforeProvider for safety");
  }

  try {
    const client = await getClient();
    console.log("PrivacyAI: sanitizing via API", {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      contextTurns: contextToSend?.length ?? 0
    });
    return await client.sanitize(text, { context: contextToSend });
  } catch (error) {
    console.error("Sanitization error details:", error, error.details || error.message);
    console.log("PrivacyAI: API failed, falling back to local regex sanitization");
    return localSanitize(text);
  }
}

async function injectPageBridge(tabId) {
  if (!tabId) return false;

  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedChatUrl(tab.url)) return false;

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    files: ["page-bridge-main.js"]
  });

  return true;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "inject-page-bridge") {
    (async () => {
      try {
        const success = await injectPageBridge(sender.tab?.id);
        sendResponse({ success });
      } catch (error) {
        console.error("PrivacyAI page bridge injection failed:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  if (request.action === "ping") {
    sendResponse({ success: true, message: "PrivacyAI background is running" });
    return false;
  }

  if (request.action === "sanitize") {
    console.log("PrivacyAI: received sanitize request", {
      length: request.text?.length,
      from: sender.tab?.url || "unknown"
    });

    (async () => {
      try {
        const result = await sanitizeText(request.text, request.context);
        console.log("PrivacyAI: sanitize complete", {
          source: result.privacySource || "local-regex",
          preview: result.sanitizedText?.slice(0, 80)
        });

        sendResponse({ success: true, result });
      } catch (error) {
        console.error("PrivacyAI sanitization failed:", error);
        sendResponse({ success: false, error: error.message, details: error.details });
      }
    })();
    return true;
  }

  if (request.action === "updateConfig") {
    privateClient = null;
    sendResponse({ success: true });
    return false;
  }
});
