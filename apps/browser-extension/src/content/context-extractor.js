export const USER_MESSAGE_SELECTORS = [
  '[data-message-author-role="user"]',
  '.message.user',
  '.user-query',
  '.user-message',
  '[data-testid="user-message"]'
];

export const ASSISTANT_MESSAGE_SELECTORS = [
  '[data-message-author-role="model"]',
  '[data-message-author-role="assistant"]',
  '.message.ai',
  '.model-response',
  '[data-testid="conversation-turn"] [data-message-author-role="model"]'
];

export function extractConversationContext(maxTurns = 6) {
  const turns = [];

  const allUserMsgs = Array.from(document.querySelectorAll(
    USER_MESSAGE_SELECTORS.join(', ')
  ));
  const allAssistantMsgs = Array.from(document.querySelectorAll(
    ASSISTANT_MESSAGE_SELECTORS.join(', ')
  ));

  const allMsgs = [
    ...allUserMsgs.map(el => ({ el, role: 'user' })),
    ...allAssistantMsgs.map(el => ({ el, role: 'assistant' }))
  ].sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  for (const { el, role } of allMsgs) {
    const text = (el.innerText || el.textContent || '').trim();
    if (text.length > 0 && text.length < 4000) {
      turns.push({ role, text });
    }
  }

  return turns.slice(-maxTurns);
}
