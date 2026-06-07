export { PrivateAI, createClient } from "./client.js";
export { PrivacySanitizer } from "./sanitizer.js";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.js";
export { OllamaProvider } from "./providers/ollama.js";
export { restore, redact } from "./redactor.js";
export { configFromEnv, loadEnvFile } from "./config.js";
export { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
export { generateDummy } from "./dummy-data.js";
export { PrivacyGuardianError, ProviderError } from "./errors.js";

import { PrivateAI } from "./client.js";

export async function ask(prompt, options = {}) {
  return new PrivateAI(options).ask(prompt, options);
}

export async function sanitize(prompt, options = {}) {
  return new PrivateAI(options).sanitize(prompt);
}

export async function inspect(prompt, options = {}) {
  return new PrivateAI(options).inspect(prompt);
}
