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

- `ask(prompt, options?)`: sanitize, call model, restore dummy stand-ins in the response.
- `sanitize(prompt, options?)`: only run the local privacy sanitizer.
- `inspect(prompt, options?)`: return sanitizer output without calling a model.
- `PrivateAI.fromEnv()`: create a client from `.env` and process env.
