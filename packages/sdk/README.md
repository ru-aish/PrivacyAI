# Privacy Guardian AI JS SDK

Local-first privacy layer for OpenAI-compatible AI calls.

```js
import { ask } from "@privacy-ai/sdk";

const result = await ask("My email is john@example.com. Write a short reply.");
console.log(result.finalText);
```

Or configure it explicitly:

```js
import { PrivateAI } from "@privacy-ai/sdk";

const client = new PrivateAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "http://127.0.0.1:11434/v1",
  model: "qwen3.5:2b"
});

const result = await client.ask("Call me at +1 555 123 4567.");
```

Per-call options can override the model behavior:

```js
const result = await client.ask("Summarize this safely: john@example.com", {
  temperature: 0,
  maxTokens: 80
});
```

## Compact exact text edits

For code, prose, configuration, or any other text, `TextEditGenerator` asks the
local model for small exact patches instead of a complete rewritten document.
PrivacyAI verifies every source fragment and applies the patches locally.

```js
import {
  OpenAICompatibleProvider,
  TextEditGenerator
} from "@privacy-ai/sdk";

const provider = new OpenAICompatibleProvider({
  baseURL: "http://127.0.0.1:1234/v1",
  model: "mistralai/ministral-3-3b"
});
const editor = new TextEditGenerator({ provider });

const result = await editor.edit(
  "function total() {\n  return value;\n}",
  "Add ten percent tax without rounding."
);

console.log(result.text);
// function total() {
//   return value * 1.1;
// }
```

The model returns a compact contract such as:

```json
{
  "edits": [
    {
      "search": "return value;",
      "replace": "return value * 1.1;",
      "occurrence": 1,
      "all": false
    }
  ]
}
```

`occurrence` selects a one-based exact match; `all: true` applies the same
replacement to every exact match. Ambiguous, missing, overlapping, malformed,
and whole-document patches are rejected rather than guessed. Browser privacy
mode uses the same verified patch engine for its optional small local rewrites,
while strict privacy mode continues to return only exact sensitive spans.

## Environment Variables

```env
PRIVATE_AI_BASE_URL=http://127.0.0.1:11434/v1
PRIVATE_AI_API_KEY=ollama
PRIVATE_AI_MODEL=qwen3.5:2b
PRIVATE_AI_PROVIDER=ollama

# Optional
PRIVATE_AI_ENV_FILE=.env
PRIVATE_AI_TIMEOUT_MS=60000
PRIVATE_AI_NUM_CTX=4096
PRIVATE_AI_LOCAL_DETECTOR_ENABLED=false
PRIVATE_AI_LOCAL_DETECTOR_MODEL=qwen3.5:2b
```

OpenAI-compatible aliases are also supported:

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

## Public API

```js
import { PrivateAI, ask, sanitize, inspect, createClient } from "@privacy-ai/sdk";
```

- `ask(prompt, options?)`: local AI builds a safe prompt + session map, task AI answers in a fresh context, then values are restored locally.
- `sanitize(prompt, options?)`: only run the local privacy sanitizer.
- `inspect(prompt, options?)`: return sanitizer output without calling a model.
- `PrivateAI.fromEnv()`: create a client from `.env` and process env.
