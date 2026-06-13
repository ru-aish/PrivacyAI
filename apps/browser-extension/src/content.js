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

document.addEventListener('keydown', (e) => {
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

    chrome.runtime.sendMessage({ action: 'sanitize', text: originalText }, (response) => {
      if (chrome.runtime.lastError) console.error("SendMessage error:", chrome.runtime.lastError);

      if (response && response.success && response.result) {
        console.log("PrivacyAI sanitized prompt successfully.", response.result.sanitizedText);
        const { sanitizedText, sessionMap } = response.result;
        Object.assign(currentSessionMap, sessionMap);

        // Let's modify the VALUE and dispatch events FIRST
        if (target.isContentEditable) {
            target.innerText = sanitizedText;
            target.textContent = sanitizedText;
        } else {
            target.value = sanitizedText;
        }

        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));

        // Wait, what if the `keydown` event on the target ALREADY fired before our `document` capture caught it?
        // Wait, `capture: true` catches it first. BUT did we use `capture: true` on document.addEventListener?!
        // OH! We missed `true` at the end of `addEventListener` when rewriting!
        // No, we have it at the very bottom: `}, true);`
        // Let's double check. Yes.

        // To absolutely force Playwright and the framework to see it:
        // We will remove focus and refocus to trigger blur/focus states if needed
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
        setTimeout(() => {
          isSanitizing = true;
          target.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
          setTimeout(() => { isSanitizing = false; }, 100);
        }, 100);
      }
    });
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
