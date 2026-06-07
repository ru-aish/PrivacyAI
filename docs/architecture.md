# Architecture

PrivacyAI has two user-facing layers:

1. `packages/sdk`
2. `apps/web-demo`

## Flow

```text
prompt -> local privacy detection -> redaction -> provider call -> response restore
```

## Package roles

- `packages/sdk`: the main library people install and import
- `apps/web-demo`: browser demo powered directly by the SDK

## Why this split

- SDK users want one or two import lines.
- Demo users want a visible UI to try the product quickly.

The repo keeps those paths separate so the demo does not become the product.