import { extractConversationContext } from "./content/context-extractor.js";
import { shouldRestoreNode, startRestoreObserver } from "./content/restore-observer.js";
import { showBadge } from "./content/badge.js";
import { sendBackgroundMessage } from "./content/background-client.js";

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function quickLocalSanitize(text) {
  const sessionMap = {};
  let sanitizedText = text;
  let index = 0;

  for (const match of text.matchAll(EMAIL_REGEX)) {
    index += 1;
    const dummy = `contact${index}@example.com`;
    sessionMap[dummy] = match[0];
    sanitizedText = sanitizedText.replace(match[0], dummy);
  }

  return { originalText: text, sanitizedText, sessionMap, privacySource: "content-regex-fallback" };
}

let shieldEnabled = true;
let currentSessionMap = {};
let restoreRegex = null;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rebuildRestoreRegex() {
  const keys = Object.keys(currentSessionMap).sort((a, b) => b.length - a.length);
  if (keys.length === 0) {
    restoreRegex = null;
    return;
  }

  restoreRegex = new RegExp(keys.map(escapeRegExp).join("|"), "g");
}

chrome.storage.local.get(['shieldEnabled'], (data) => {
  if (data.shieldEnabled !== undefined) {
    shieldEnabled = data.shieldEnabled;
  }
  postToPage('shield-state', { value: shieldEnabled });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.shieldEnabled) {
    shieldEnabled = changes.shieldEnabled.newValue;
    postToPage('shield-state', { value: shieldEnabled });
  }
});

document.documentElement.setAttribute('data-privacyai', 'active');
requestPageBridge();

window.addEventListener('pageshow', () => requestPageBridge());

let lastUrl = location.href;
const navigationObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    requestPageBridge();
  }
});

function startNavigationObserver() {
  if (!document.body) return;
  navigationObserver.observe(document.body, { childList: true, subtree: true });
}

if (document.body) {
  startNavigationObserver();
} else {
  document.addEventListener('DOMContentLoaded', startNavigationObserver, { once: true });
}

function postToPage(type, payload = {}) {
  window.postMessage({ source: 'privacyai-content', type, ...payload }, '*');
}

function requestPageBridge() {
  chrome.runtime.sendMessage({ action: 'inject-page-bridge' }, (response) => {
    if (chrome.runtime.lastError) {
      console.error('PrivacyAI failed to inject page bridge:', chrome.runtime.lastError.message);
      return;
    }
    postToPage('shield-state', { value: shieldEnabled });
    if (response?.success) {
      console.log('PrivacyAI page bridge injected');
    }
  });
}

function restoreTextNode(node, rx, sessionMap) {
  if (!shouldRestoreNode(node) || !rx) return;

  const text = node.nodeValue;
  if (!text) return;

  const restored = text.replace(rx, (match) => sessionMap[match] || match);
  if (restored !== text) {
    node.nodeValue = restored;
  }
}

function initializeContentScript() {
  showBadge('PrivacyAI loading...');
  startRestoreObserver({
    getShieldEnabled: () => shieldEnabled,
    getCurrentSessionMap: () => currentSessionMap,
    getRestoreRegex: () => restoreRegex,
    restoreTextNode
  });

  sendBackgroundMessage({ action: 'ping' }, 5000)
    .then((response) => {
      console.log("PrivacyAI connected:", response?.message);
      showBadge('PrivacyAI connected');
    })
    .catch((error) => {
      console.error("PrivacyAI cannot reach background worker:", error.message);
      showBadge('PrivacyAI: background unreachable (local fallback only)');
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeContentScript, { once: true });
} else {
  initializeContentScript();
}

window.addEventListener('message', async (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'privacyai-page') {
    return;
  }

  if (event.data.type !== 'sanitize-request' || !shieldEnabled) {
    return;
  }

  const originalText = String(event.data.text || '');
  console.log("PrivacyAI intercepting prompt:", originalText);
  showBadge('PrivacyAI sanitizing...');

  const conversationContext = extractConversationContext(6);

  try {
    const response = await sendBackgroundMessage({
      action: 'sanitize',
      text: originalText,
      context: conversationContext
    });

    if (!response?.success || !response.result) {
      throw new Error(response?.error || 'Background sanitization failed');
    }

    const result = response.result;
    console.log(
      "PrivacyAI sanitized via background.",
      result.sanitizedText,
      `(source: ${result.privacySource || "unknown"})`
    );
    postToPage('submit-sanitized', { text: result.sanitizedText });
    Object.assign(currentSessionMap, result.sessionMap);
    rebuildRestoreRegex();
    showBadge('PrivacyAI ready');
  } catch (error) {
    console.error("PrivacyAI sanitization error:", error);
    postToPage('sanitize-error');
    showBadge('PrivacyAI error — refresh page');
  }
});