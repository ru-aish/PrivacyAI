(() => {
  const SUPPORTED_HOSTS = [
    "chatgpt.com",
    "chat.openai.com",
    "claude.ai",
    "gemini.google.com",
    "perplexity.ai",
    "copilot.microsoft.com",
    "poe.com",
    "127.0.0.1",
    "localhost"
  ];

  function isSupportedChatSite() {
    const host = location.hostname;
    if (location.protocol === "file:") return true;
    return SUPPORTED_HOSTS.some((supported) => host === supported || host.endsWith(`.${supported}`));
  }

  if (!isSupportedChatSite()) return;
  if (window.__privacyAiBridgeInstalled) return;
  window.__privacyAiBridgeInstalled = true;
  window.__privacyAiShieldEnabled = true;
  window.__privacyAiSanitizing = false;
  window.__privacyAiBypassIntercept = false;

  let pendingTarget = null;

  const EDITOR_SELECTORS = [
    '#prompt-textarea',
    'div.ql-editor.textarea[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea#prompt-input',
    'textarea',
    'input[type="text"]'
  ];

  const SEND_BUTTON_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button.send-button',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send"]',
    'form[data-type="unified-composer"] button[type="submit"]',
    '#send-button'
  ];

  function isVisible(element) {
    if (!element || element.offsetParent === null) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isEditable(target) {
    if (!target) return false;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return true;
    if (target.isContentEditable) return true;
    return Boolean(resolveEditor(target));
  }

  function isExcludedEditor(element) {
    if (!element) return true;
    if (element.classList?.contains('ql-clipboard')) return true;
    if (!isVisible(element)) return false;
    return false;
  }

  function resolveEditor(target) {
    if (!target?.closest) return null;

    for (const selector of EDITOR_SELECTORS) {
      try {
        const match = target.closest(selector);
        if (match && !isExcludedEditor(match)) return match;
      } catch {
        // Invalid selector in older engines
      }
    }

    if (target.matches) {
      for (const selector of EDITOR_SELECTORS) {
        try {
          if (target.matches(selector) && !isExcludedEditor(target)) return target;
        } catch {
          // ignore
        }
      }
    }

    return null;
  }

  function resolveEditorFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
      const editor = resolveEditor(node);
      if (editor) return editor;
    }
    return resolveEditor(event.target);
  }

  function readText(target) {
    const editor = resolveEditor(target) || target;
    if (!editor) return '';

    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      return editor.value || '';
    }

    const quill = editor.closest('.ql-container')?.__quill;
    if (quill) {
      return quill.getText().replace(/\n$/, '');
    }

    return (editor.innerText || editor.textContent || '').replace(/\n$/, '');
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor.set.call(element, value);
  }

  function setQuillText(element, text) {
    const quill = element.closest('.ql-container')?.__quill;
    if (!quill) return false;

    quill.setText(text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function setContentEditableText(element, text) {
    element.focus();

    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      element.textContent = text;
    }

    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setText(target, text) {
    const editor = resolveEditor(target) || target;
    if (!editor) return;

    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      setNativeValue(editor, text);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }

    if (setQuillText(editor, text)) return;
    setContentEditableText(editor, text);
  }

  function matchesSendButton(button) {
    if (!button || button.tagName !== 'BUTTON') return false;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    if (!isVisible(button)) return false;

    for (const selector of SEND_BUTTON_SELECTORS) {
      try {
        if (button.matches(selector)) return true;
      } catch {
        // ignore
      }
    }

    const label = (button.getAttribute('aria-label') || button.textContent || '').toLowerCase();
    return label.includes('send') && !label.includes('send feedback');
  }

  function findSendButton(editor) {
    if (editor) {
      let container = editor.parentElement;
      for (let depth = 0; depth < 12 && container; depth += 1) {
        const localButtons = Array.from(container.querySelectorAll('button')).filter(matchesSendButton);
        if (localButtons.length > 0) {
          return localButtons[localButtons.length - 1];
        }
        container = container.parentElement;
      }
    }

    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = document.querySelector(selector);
      if (matchesSendButton(button)) return button;
    }

    return null;
  }

  function beginSanitize(editor, text) {
    window.__privacyAiSanitizing = true;
    pendingTarget = editor;
    window.__privacyAiPendingTarget = editor;

    window.postMessage({
      source: 'privacyai-page',
      type: 'sanitize-request',
      text
    }, '*');
  }

  function submitSanitizedText(target, text) {
    window.__privacyAiBypassIntercept = true;

    const editor = resolveEditor(target) || target;

    const submitEvent = new CustomEvent('privacyai-submit', {
      bubbles: true,
      cancelable: true,
      detail: { text }
    });
    document.dispatchEvent(submitEvent);

    if (submitEvent.defaultPrevented) {
      window.setTimeout(() => {
        window.__privacyAiBypassIntercept = false;
      }, 0);
      return;
    }

    if (editor) {
      setText(editor, text);
      editor.focus();
    }

    const clickSend = () => {
      const sendButton = findSendButton(editor);
      if (sendButton) {
        sendButton.click();
      }
      window.setTimeout(() => {
        window.__privacyAiBypassIntercept = false;
      }, 100);
    };

    window.setTimeout(clickSend, 120);
  }

  function blockEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function interceptIfNeeded(event, editor) {
    if (window.__privacyAiBypassIntercept) return false;
    if (!window.__privacyAiShieldEnabled) return false;
    if (!editor) return false;

    if (window.__privacyAiSanitizing) {
      blockEvent(event);
      return true;
    }

    const originalText = readText(editor);
    if (!originalText.trim() || originalText.trim().length < 5) return false;

    blockEvent(event);
    beginSanitize(editor, originalText);
    return true;
  }

  function installCaptureListener(type, handler) {
    window.addEventListener(type, handler, true);
    document.addEventListener(type, handler, true);
  }

  installCaptureListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;

    const editor = resolveEditorFromEvent(event);
    if (!editor) return;

    interceptIfNeeded(event, editor);
  });

  installCaptureListener('beforeinput', (event) => {
    if (event.isComposing) return;
    if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return;

    const editor = resolveEditorFromEvent(event);
    if (!editor) return;

    interceptIfNeeded(event, editor);
  });

  document.addEventListener('click', (event) => {
    if (window.__privacyAiBypassIntercept) return;

    const button = event.target?.closest?.('button');
    if (!button || !matchesSendButton(button)) return;

    const editor = resolveEditor(document.activeElement) || resolveEditorFromEvent(event);
    if (!editor) return;

    interceptIfNeeded(event, editor);
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
      const target = pendingTarget || window.__privacyAiPendingTarget || document.activeElement;
      pendingTarget = null;
      submitSanitizedText(target, text);
      window.__privacyAiPendingTarget = null;
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
    const target = pendingTarget || window.__privacyAiPendingTarget || document.activeElement;
    submitSanitizedText(target, text);
    pendingTarget = null;
    window.__privacyAiPendingTarget = null;
    window.__privacyAiSanitizing = false;
  };
})();