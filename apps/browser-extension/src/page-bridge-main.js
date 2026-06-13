(() => {
  if (window.__privacyAiBridgeInstalled) return;
  window.__privacyAiBridgeInstalled = true;
  window.__privacyAiShieldEnabled = true;
  window.__privacyAiSanitizing = false;
  let pendingTarget = null;

  function isEditable(target) {
    return target && (
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'INPUT' ||
      target.isContentEditable
    );
  }

  function readText(target) {
    return target.value || target.innerText || '';
  }

  function setText(target, text) {
    if (target.isContentEditable) {
      target.textContent = text;
      return;
    }

    const prototype = target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor.set.call(target, text);
  }

  document.addEventListener('keydown', (event) => {
    if (!window.__privacyAiShieldEnabled) return;
    if (!isEditable(event.target) || event.key !== 'Enter' || event.shiftKey) return;

    const originalText = readText(event.target);
    if (!originalText.trim() || originalText.trim().length < 5) return;
    if (originalText.includes('[EMAIL_')) return;
    if (window.__privacyAiSanitizing) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    window.__privacyAiSanitizing = true;
    pendingTarget = event.target;
    window.__privacyAiPendingTarget = event.target;

    window.postMessage({
      source: 'privacyai-page',
      type: 'sanitize-request',
      text: originalText
    }, '*');
  }, true);

  window.addEventListener('message', (event) => {
    if (!event.data || event.data.source !== 'privacyai-content') {
      return;
    }

    if (event.data.type === 'shield-state') {
      window.__privacyAiShieldEnabled = Boolean(event.data.value);
      return;
    }

    if (event.data.type === 'submit-sanitized') {
      const text = String(event.data.text || '');
      const target = pendingTarget || document.activeElement;
      pendingTarget = null;

      if (target && isEditable(target)) {
        setText(target, text);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const submitEvent = new CustomEvent('privacyai-submit', {
        bubbles: true,
        cancelable: true,
        detail: { text }
      });
      document.dispatchEvent(submitEvent);

      if (!submitEvent.defaultPrevented) {
        const sendButton = document.getElementById('send-button');
        if (sendButton) {
          sendButton.click();
        } else if (target) {
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
            shiftKey: false
          }));
        }
      }

      window.__privacyAiSanitizing = false;
      return;
    }

    if (event.data.type === 'sanitize-error') {
      window.__privacyAiSanitizing = false;
      pendingTarget = null;
      window.__privacyAiPendingTarget = null;
    }
  });

  window.__privacyAiSubmit = function submitSanitizedToPage(text) {
    const target = window.__privacyAiPendingTarget || document.activeElement;

    if (target && isEditable(target)) {
      setText(target, text);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const submitEvent = new CustomEvent('privacyai-submit', {
      bubbles: true,
      cancelable: true,
      detail: { text }
    });
    document.dispatchEvent(submitEvent);

    if (!submitEvent.defaultPrevented) {
      const sendButton = document.getElementById('send-button');
      if (sendButton) {
        sendButton.click();
      }
    }

    window.__privacyAiPendingTarget = null;
    window.__privacyAiSanitizing = false;
  };
})();