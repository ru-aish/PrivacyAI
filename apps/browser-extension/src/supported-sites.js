export const SUPPORTED_CHAT_HOSTS = [
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

export function isSupportedChatUrl(url) {
  if (!url) return false;

  try {
    const { hostname, protocol } = new URL(url);
    if (protocol === "file:") return true;
    return SUPPORTED_CHAT_HOSTS.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}