# PrivacyAI Boundary Playground

Local browser playground for inspecting the exact text and image PrivacyAI would send across the provider boundary.

It supports:

- text-only sanitization;
- prompt-plus-image sanitization using the reusable `@privacy-ai/sdk/image` OCR/masking pipeline;
- before/after image comparison;
- safe prompt preview, replacement labels, OCR line counts, and masked-region counts;
- saving the sanitized PNG locally.

## Requirements

Configure PrivacyAI with an Ollama model first:

```bash
privacyai onboard
privacyai doctor
```

The playground intentionally uses the same `~/.config/privacyai/config.json` as `privacyai codex` and rejects non-Ollama privacy providers.

## Run

From the repository root:

```bash
pnpm demo
```

Or directly:

```bash
pnpm --filter @privacy-ai/web-demo dev
```

Open `http://127.0.0.1:3000`. If the port is occupied, the server prints the fallback port it selected.

## Tests

```bash
pnpm --filter @privacy-ai/web-demo test
```

The image route accepts only base64 PNG, JPEG, and WebP data URLs. It imports `@privacy-ai/sdk/image` directly, so the playground and Codex gateway share the same decoded-byte, dimension, pixel, OCR, exact-span mapping, exact-to-line-to-block masking retries, and post-mask verification behavior.
