# PrivacyAI

PrivacyAI is a privacy SDK first.

## One-command setup

```bash
npm run setup
```

The setup script installs Node dependencies, walks you through an AI provider menu (Ollama, LM Studio, OpenAI, Gemini, or custom), tests the connection, and writes `.env`.

Script: [scripts/setup.sh](scripts/setup.sh)

## Use the SDK

```js
import { ask } from "@privacy-ai/sdk";

const result = await ask("My email is jane@example.com. Rewrite this safely.");
console.log(result.finalText);
```

## Try the web demo

```bash
npm run demo
```

Open `http://localhost:3000`.

## References

- SDK: [packages/sdk/README.md](packages/sdk/README.md)
- Web demo: [apps/web-demo/README.md](apps/web-demo/README.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- Examples: [examples/README.md](examples/README.md)