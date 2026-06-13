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
let observerStarted = false;

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

function mountBadgeHost() {
  return document.body || document.documentElement;
}

function showBadge(text) {
  let badge = document.getElementById('privacyai-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'privacyai-badge';
    badge.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'right:12px',
      'z-index:2147483647',
      'padding:6px 10px',
      'border-radius:6px',
      'background:#111',
      'color:#fff',
      'font:12px/1.4 sans-serif',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)'
    ].join(';');
    mountBadgeHost().appendChild(badge);
  }
  badge.textContent = text;
}

function startRestoreObserver() {
  if (observerStarted || !document.body) return;
  observerStarted = true;

  const observer = new MutationObserver((mutations) => {
    if (!shieldEnabled || Object.keys(currentSessionMap).length === 0) return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        restoreTextNode(mutation.target);
      } else if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            restoreTextNode(node);
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            walkAndRestore(node);
          }
        });
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function sendBackgroundMessage(message, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Background worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timer);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function requestSanitize(text) {
  try {
    const response = await sendBackgroundMessage({ action: 'sanitize', text });
    if (response?.success && response.result) {
      console.log(
        "PrivacyAI sanitized via background.",
        response.result.sanitizedText,
        `(source: ${response.result.privacySource || "unknown"})`
      );
      return response.result;
    }
    throw new Error(response?.error || 'Background sanitization failed');
  } catch (error) {
    console.warn("PrivacyAI background sanitize unavailable, using in-page local regex:", error.message);
    const result = quickLocalSanitize(text);
    console.log("PrivacyAI sanitized locally.", result.sanitizedText);
    return result;
  }
}

const USER_MESSAGE_SELECTORS = [
  '[data-message-author-role="user"]',
  '.message.user',
  '.user-query',
  '.user-message',
  '[data-testid="user-message"]'
];

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'div.ql-editor',
  'div.ProseMirror',
  'rich-textarea',
  'textarea#prompt-input',
  '#prompt-input'
];

const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-message-author-role="model"]',
  '[data-message-author-role="assistant"]',
  '.message.ai',
  '.model-response',
  '[data-testid="conversation-turn"] [data-message-author-role="model"]'
];

function shouldRestoreNode(node) {
  let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (element) {
    for (const selector of USER_MESSAGE_SELECTORS) {
      if (element.matches?.(selector)) return false;
    }
    for (const selector of COMPOSER_SELECTORS) {
      if (element.matches?.(selector)) return false;
    }
    for (const selector of ASSISTANT_MESSAGE_SELECTORS) {
      if (element.matches?.(selector)) return true;
    }
    element = element.parentElement;
  }
  return false;
}

function walkAndRestore(node) {
  if (!shouldRestoreNode(node)) return;

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
  let textNode;
  const nodesToUpdate = [];
  while ((textNode = walker.nextNode())) {
    if (shouldRestoreNode(textNode)) {
      nodesToUpdate.push(textNode);
    }
  }
  nodesToUpdate.forEach(restoreTextNode);
}

function restoreTextNode(node) {
  if (!shouldRestoreNode(node)) return;

  let text = node.nodeValue;
  if (!text) return;

  let changed = false;
  for (const [dummy, original] of Object.entries(currentSessionMap)) {
    if (text.includes(dummy)) {
      text = text.split(dummy).join(original);
      changed = true;
    }
  }

  if (changed) {
    node.nodeValue = text;
  }
}

function initializeContentScript() {
  showBadge('PrivacyAI loading...');
  startRestoreObserver();

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

  try {
    const response = await sendBackgroundMessage({
      action: 'sanitize',
      text: originalText
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
    showBadge('PrivacyAI ready');
  } catch (error) {
    console.error("PrivacyAI sanitization error:", error);
    postToPage('sanitize-error');
    showBadge('PrivacyAI error — refresh page');
  }
});