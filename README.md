# PrivacyAI

PrivacyAI is a privacy SDK first.

## One-command setup

```bash
npm run setup
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
