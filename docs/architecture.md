# Architecture

PrivacyAI is split into three visible layers:

1. `packages/sdk`
2. `apps/service-gateway`
3. `apps/web-demo`

## Flow

```text
prompt -> local privacy detection -> redaction -> provider call -> response restore
```

## Package roles

- `packages/sdk`: the main library people install and import
- `apps/service-gateway`: Python Flask wrapper for direct HTTP use
- `apps/web-demo`: browser-facing demo UI

## Why this split

- SDK users want one or two import lines.
- Service users want a simple endpoint.
- Demo users want a visible UI.

The repo keeps those paths separate so they do not blur into one another.

