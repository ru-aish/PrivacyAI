let shieldEnabled = true;
let currentSessionMap = {};

chrome.storage.local.get(['shieldEnabled'], (data) => {
  if (data.shieldEnabled !== undefined) {
    shieldEnabled = data.shieldEnabled;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.shieldEnabled) {
    shieldEnabled = changes.shieldEnabled.newValue;
  }
});

let isSanitizing = false;

function sendBackgroundMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

sendBackgroundMessage({ action: 'ping' })
  .then((response) => console.log("PrivacyAI connected:", response?.message))
  .catch((error) => {
    console.error(
      "PrivacyAI cannot reach background worker:",
      error.message,
      "If testing a local HTML file, enable 'Allow access to file URLs' on chrome://extensions, or use http://localhost:3333/mock-chat.html"
    );
  });

document.addEventListener('keydown', async (e) => {
  if (!shieldEnabled) return;
  const target = e.target;
  const isInputOrTextarea = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable;

  if (!isInputOrTextarea) return;

  if (e.key === 'Enter' && !e.shiftKey) {
    if (isSanitizing) return;

    const originalText = target.value || target.innerText;
    if (!originalText || originalText.trim().length < 5) return;
    if (originalText.includes('[EMAIL_')) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    isSanitizing = true;
    console.log("PrivacyAI intercepting prompt:", originalText);

    try {
      const response = await sendBackgroundMessage({ action: 'sanitize', text: originalText });

      if (response && response.success && response.result) {
        console.log("PrivacyAI sanitized prompt successfully.", response.result.sanitizedText);
        const { sanitizedText, sessionMap } = response.result;
        Object.assign(currentSessionMap, sessionMap);

        if (target.isContentEditable) {
          target.innerText = sanitizedText;
          target.textContent = sanitizedText;
        } else {
          target.value = sanitizedText;
        }

        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        target.blur();
        target.focus();

        setTimeout(() => {
          const btn = document.getElementById('send-button');
          if (btn) {
            btn.click();
          } else {
            isSanitizing = true;
            target.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, shiftKey: false
            }));
          }
          setTimeout(() => { isSanitizing = false; }, 200);
        }, 150);
      } else {
        console.error("PrivacyAI sanitization failed:", response?.error || "no response from background");
        isSanitizing = false;
      }
    } catch (error) {
      console.error("PrivacyAI sendMessage error:", error.message);
      isSanitizing = false;
    }
  }
}, true);


const observer = new MutationObserver((mutations) => {
  if (!shieldEnabled) return;
  if (Object.keys(currentSessionMap).length === 0) return;

  for (const mutation of mutations) {
    if (mutation.type === 'characterData') {
      restoreTextNode(mutation.target);
    } else if (mutation.type === 'childList') {
      mutation.addedNodes.forEach(node => {
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

function walkAndRestore(node) {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
  let textNode;
  const nodesToUpdate = [];
  while ((textNode = walker.nextNode())) { nodesToUpdate.push(textNode); }
  nodesToUpdate.forEach(restoreTextNode);
}

function restoreTextNode(node) {
  let text = node.nodeValue;
  if (!text) return;
  let changed = false;
  for (const [dummy, original] of Object.entries(currentSessionMap)) {
    if (text.includes(dummy)) {
      text = text.split(dummy).join(original);
      changed = true;
    }
  }
  if (changed) node.nodeValue = text;
}