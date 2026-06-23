import { CONTEXT_COMPACTOR_PROMPT } from "./prompts.js";
import { PrivacyGuardianError } from "./errors.js";

export class ContextCompactor {
  constructor(options = {}) {
    if (!options.provider || typeof options.provider.chat !== "function") {
      throw new PrivacyGuardianError("ContextCompactor requires a provider with chat().");
    }
    this.provider = options.provider;
    this.model = options.privacyModel || options.model;
    this.systemPrompt = options.compactorSystemPrompt || CONTEXT_COMPACTOR_PROMPT;
  }

  async compact(previousState, latestSanitizedPrompt, assistantResponse, sessionMapMetadata = {}) {
    const state = previousState || {
      safe_context_summary: "",
      private_memory: {},
      open_tasks: [],
      stable_user_intent: [],
      privacy_sensitive_refs: [],
      warnings: []
    };

    const messages = [
      { role: "system", content: this.systemPrompt },
      {
        role: "user",
        content: JSON.stringify({
          previous_state: state,
          latest_sanitized_prompt: latestSanitizedPrompt,
          assistant_response: assistantResponse,
          session_map: sessionMapMetadata
        })
      }
    ];

    try {
      const response = await this.provider.chat({
        model: this.model,
        messages,
        temperature: 0
      });

      const parsed = parseCompactorJson(response.text);
      if (parsed) {
        return parsed;
      }
      return state; // Fallback to previous state on invalid JSON
    } catch (err) {
      console.error("ContextCompactor error:", err);
      return state;
    }
  }
}

export function parseCompactorJson(text) {
  const json = extractJson(text);
  if (!json || typeof json.safe_context_summary !== "string") {
    return null;
  }
  return {
    safe_context_summary: json.safe_context_summary || "",
    private_memory: json.private_memory || {},
    open_tasks: Array.isArray(json.open_tasks) ? json.open_tasks : [],
    stable_user_intent: Array.isArray(json.stable_user_intent) ? json.stable_user_intent : [],
    privacy_sensitive_refs: Array.isArray(json.privacy_sensitive_refs) ? json.privacy_sensitive_refs : [],
    warnings: Array.isArray(json.warnings) ? json.warnings : []
  };
}

function extractJson(text) {
  if (typeof text !== "string") return undefined;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
