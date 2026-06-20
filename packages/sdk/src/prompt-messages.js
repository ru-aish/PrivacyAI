export function buildSanitizerMessages({ systemPrompt, text, context = [] }) {
  const messages = [{ role: "system", content: systemPrompt }];

  if (Array.isArray(context)) {
    for (const turn of context) {
      messages.push({
        role: turn.role === "user" ? "user" : "assistant",
        content: `[CONTEXT] ${String(turn.text || "")}`
      });
    }
  }

  messages.push({ role: "user", content: text });
  return messages;
}
