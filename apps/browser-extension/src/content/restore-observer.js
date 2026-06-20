import { USER_MESSAGE_SELECTORS, ASSISTANT_MESSAGE_SELECTORS } from "./context-extractor.js";

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'div.ql-editor',
  'div.ProseMirror',
  'rich-textarea',
  'textarea#prompt-input',
  '#prompt-input'
];

export function shouldRestoreNode(node) {
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
    element = element.parentElement || element.parentNode?.host;
  }
  return false;
}

export function walkAndRestore(node, restoreRegex, currentSessionMap, restoreTextNode) {
  if (!shouldRestoreNode(node)) return;

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
  let textNode;
  const nodesToUpdate = [];
  while ((textNode = walker.nextNode())) {
    if (shouldRestoreNode(textNode)) {
      nodesToUpdate.push(textNode);
    }
  }
  nodesToUpdate.forEach((tn) => restoreTextNode(tn, restoreRegex, currentSessionMap));
}

export function startRestoreObserver({ getShieldEnabled, getCurrentSessionMap, getRestoreRegex, restoreTextNode }) {
  if (!document.body) return null;

  const observer = new MutationObserver((mutations) => {
    if (!getShieldEnabled() || Object.keys(getCurrentSessionMap()).length === 0) return;

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        restoreTextNode(mutation.target, getRestoreRegex(), getCurrentSessionMap());
      } else if (mutation.type === 'childList') {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            restoreTextNode(node, getRestoreRegex(), getCurrentSessionMap());
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            walkAndRestore(node, getRestoreRegex(), getCurrentSessionMap(), restoreTextNode);
          }
        });
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return observer;
}
