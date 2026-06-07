# Architecture

PrivacyAI has two user-facing layers:

1. `packages/sdk`
2. `apps/web-demo`

## Flow

```text
user prompt
  -> local AI privacy pass (system prompt + JSON output)
  -> safe_prompt + session_map
  -> task AI call (fresh context, no system prompt)
  -> local restore using session_map
```

## Package roles

- `packages/sdk`: local AI sanitization is the core product
- `apps/web-demo`: browser demo powered directly by the SDK

## Why this split

- SDK users want privacy handled by a local AI intermediary.
- Demo users want a visible UI to try the product quickly.

The repo keeps those paths separate so the demo does not become the product.