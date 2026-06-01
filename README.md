# PrivacyAI

PrivacyAI is now organized around one main product: a JavaScript privacy SDK that sanitizes prompts locally, sends only redacted text to an OpenAI-compatible model, then restores the response on the client.

## What lives where

```text
privacyai/
├── packages/sdk/          # Main product: installable JS SDK
├── apps/service-gateway/  # Python wrapper service and legacy AI gateway
├── apps/web-demo/         # Browser demo UI
├── docs/                  # Architecture and legacy docs
└── examples/              # Small usage examples
```

## Use the SDK

```js
import { ask } from "@privacy-ai/sdk";

const result = await ask("My email is jane@example.com. Rewrite this safely.");
console.log(result.finalText);
```

The SDK supports:
- local sanitization and restore
- OpenAI-compatible APIs
- Ollama
- LM Studio
- env-based configuration

## Run the service gateway

The Python app under `apps/service-gateway` is the thin service/demo layer for people who want a hosted or local HTTP API.

```bash
cd apps/service-gateway
pip install -r requirements.txt
python app.py
```

## Run the web demo

The browser demo lives in `apps/web-demo`. It is the UI surface, not the core product.

## SDK package

```bash
cd packages/sdk
npm test
npm run test:e2e:ollama
```

## Design rule

The repo is intentionally split by role:
- `packages/sdk`: what developers import
- `apps/service-gateway`: what runs as a service
- `apps/web-demo`: what people click through in the browser

Legacy writeups and migration notes live in `docs/legacy`.

