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

const tabStateMap = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tabId && isSupportedChatUrl(tab.url)) {
    injectPageBridge(tabId).catch(() => {});
    tabStateMap.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStateMap.delete(tabId);
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

async function sanitizeText(text, context, tabId) {
  const stored = await getStoredConfig();
  const config = getEffectiveConfig(stored);

  if (!hasRemoteProvider(stored)) {
    console.log("PrivacyAI: no provider configured, using local regex sanitization");
    return localSanitize(text);
  }

  const client = await getClient();

  const key = tabId || "default";
  if (!tabStateMap.has(key)) {
    tabStateMap.set(key, {
      safe_context_summary: "",
      private_memory: {},
      open_tasks: [],
      stable_user_intent: [],
      privacy_sensitive_refs: [],
      warnings: [],
      lastCompactedTurnCount: 0
    });
  }
  let state = tabStateMap.get(key);

  if (state && Array.isArray(context) && context.length > state.lastCompactedTurnCount) {
    const newTurns = context.slice(state.lastCompactedTurnCount);
    for (let i = 0; i < newTurns.length; i += 2) {
      const userTurn = newTurns[i];
      const assistantTurn = newTurns[i + 1];
      if (userTurn) {
        const userPrompt = userTurn.text;
        const assistantResponse = assistantTurn ? assistantTurn.text : "";
        try {
          state = await client.compactor.compact(
            state,
            userPrompt,
            assistantResponse,
            {}
          );
        } catch (compactError) {
          console.error("Compaction error:", compactError);
        }
      }
    }
    state.lastCompactedTurnCount = context.length;
    tabStateMap.set(key, state);
  }

  try {
    console.log("PrivacyAI: sanitizing via API", {
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      compactedContextSummary: state?.safe_context_summary || ""
    });

    const options = {};
    if (state?.safe_context_summary) {
      options.compactedContextSummary = state.safe_context_summary;
    } else if (context) {
      options.context = context;
    }

    return await client.sanitize(text, options);
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
        const result = await sanitizeText(request.text, request.context, sender.tab?.id);
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
