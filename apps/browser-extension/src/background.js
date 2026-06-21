import { createBrowserClient, localSanitize } from "@privacy-ai/sdk/browser";
import { getEffectiveConfig, hasRemoteProvider, isRemoteProvider, PROVIDER_PRESETS } from "./config.js";
import { isSupportedChatUrl } from "./supported-sites.js";


let protectionHistory = [];
const MAX_HISTORY = 50;

function inferDetectionType(placeholder, originalValue) {
  if (placeholder.includes('EMAIL')) return 'email';
  if (placeholder.includes('PHONE')) return 'phone';
  if (placeholder.includes('KEY') || placeholder.includes('TOKEN')) return 'credential';
  if (placeholder.includes('NAME')) return 'name';
  if (originalValue && originalValue.includes('@')) return 'email';
  return 'pii';
}

function maskSensitiveValue(type, value) {
  if (!value) return '';
  value = String(value);
  if (type === 'email') {
    const parts = value.split('@');
    if (parts.length === 2) {
      return parts[0].charAt(0) + '***@' + parts[1];
    }
  } else if (type === 'phone' || type === 'credential') {
    if (value.length > 4) {
      return value.slice(0, 2) + '***' + value.slice(-2);
    }
    return '***';
  } else if (type === 'name') {
    return value.charAt(0) + '***';
  }
  return value.substring(0, 2) + '***';
}

function countByType(sessionMap) {
  const counts = {};
  for (const [placeholder, original] of Object.entries(sessionMap)) {
    const type = inferDetectionType(placeholder, original);
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function buildProtectionSummary(result, site) {
  const maskedSessionMap = {};
  for (const [placeholder, original] of Object.entries(result.sessionMap || {})) {
    const type = inferDetectionType(placeholder, original);
    maskedSessionMap[placeholder] = maskSensitiveValue(type, original);
  }

  return {
    timestamp: Date.now(),
    site: site,
    privacySource: result.privacySource,
    cappedPreview: result.sanitizedText ? result.sanitizedText.substring(0, 100) + (result.sanitizedText.length > 100 ? '...' : '') : '',
    counts: countByType(result.sessionMap || {}),
    maskedSessionMap: maskedSessionMap
  };
}

function recordProtection(result, siteUrl) {
  try {
    let site = 'unknown';
    if (siteUrl) {
      try {
        const urlObj = new URL(siteUrl);
        site = urlObj.hostname;
      } catch (e) {
        site = siteUrl;
      }
    }

    const summary = buildProtectionSummary(result, site);
    protectionHistory.unshift(summary);
    if (protectionHistory.length > MAX_HISTORY) {
      protectionHistory.pop();
    }
  } catch (error) {
    console.error("Failed to record protection:", error);
  }
}

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

        recordProtection(result, sender.tab?.url);
        sendResponse({ success: true, result });
      } catch (error) {
        console.error("PrivacyAI sanitization failed:", error);
        sendResponse({ success: false, error: error.message, details: error.details });
      }
    })();
    return true;
  }


  if (request.action === "getProtectionHistory") {
    sendResponse({ success: true, history: protectionHistory });
    return false;
  }

  if (request.action === "clearProtectionHistory") {
    protectionHistory = [];
    sendResponse({ success: true });
    return false;
  }

  if (request.action === "getRuntimeStatus") {
    chrome.storage.local.get(["shieldEnabled"], (data) => {
      sendResponse({
        success: true,
        shieldEnabled: data.shieldEnabled !== false,
        totalProtections: protectionHistory.length
      });
    });
    return true;
  }

  if (request.action === "testProvider") {
    (async () => {
      try {
        const startTime = Date.now();
        const config = getEffectiveConfig(request.config || {});
        let url = "";
        let isOllama = config.provider === "ollama";

        if (isOllama) {
          url = (config.baseUrl || "http://127.0.0.1:11434").replace(/\/$/, '') + "/api/tags";
        } else {
          url = (config.baseUrl || "http://127.0.0.1:1234/v1").replace(/\/$/, '') + "/models";
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);


        const headers = {};
        if (config.apiKey && config.apiKey !== "ollama" && config.apiKey !== "lm-studio" && config.apiKey !== "local") {
          headers["Authorization"] = `Bearer ${config.apiKey}`;
        }
        const res = await fetch(url, { signal: controller.signal, headers });
        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }

        const json = await res.json();
        let models = [];
        if (isOllama && json.models) {
          models = json.models.map(m => m.name);
        } else if (!isOllama && json.data) {
          models = json.data.map(m => m.id);
        }

        sendResponse({
          success: true,
          healthy: true,
          responseTime: Date.now() - startTime,
          model: config.model,
          availableModels: models,
          message: "Connection successful"
        });
      } catch (error) {
        sendResponse({
          success: false,
          healthy: false,
          error: error.message || "Failed to connect to provider",
          message: "Connection failed"
        });
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
