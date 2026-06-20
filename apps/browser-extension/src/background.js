import { isSupportedChatUrl } from "./supported-sites.js";
import { initializeDefaultConfig } from "./background/config-store.js";
import { sanitizeText, invalidateClientCache } from "./background/sanitize-service.js";
import { injectPageBridge } from "./background/page-bridge-service.js";

console.log("PrivacyAI background service worker loaded");

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tabId && isSupportedChatUrl(tab.url)) {
    injectPageBridge(tabId).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await initializeDefaultConfig();
});

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
    invalidateClientCache();
    sendResponse({ success: true });
    return false;
  }
});