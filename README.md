# PrivacyAI

PrivacyAI is a privacy SDK first.

## One-command setup

```bash
npm run setup
```

The setup script installs Node dependencies, walks you through an AI provider menu (Ollama, LM Studio, OpenAI, Gemini, or custom), tests the connection, and writes `.env`.

Optional Python service gateway:

```bash
npm run setup -- --with-service
```

Script: [scripts/setup.sh](scripts/setup.sh)

## Use the SDK

```js
import { ask } from "@privacy-ai/sdk";

const result = await ask("My email is jane@example.com. Rewrite this safely.");
console.log(result.finalText);
```

## Use the web UI

Start the Python gateway:

```bash
cd apps/service-gateway
python app.py
```

## Use the service directly

The service lives in `apps/service-gateway`.

## References

- SDK: [packages/sdk/README.md](packages/sdk/README.md)
- Service docs: [docs/service/README.md](docs/service/README.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Examples: [examples/README.md](examples/README.md)

Legacy writeups are kept in `docs/legacy`.
