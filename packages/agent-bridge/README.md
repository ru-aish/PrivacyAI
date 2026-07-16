# @privacy-ai/agent-bridge

Local privacy boundaries for the official Claude Code, Codex, and Antigravity CLIs.
The public `privacyai` executable is published by `@privacy-ai/agent-tui`; this
package contains the launchers, provider gateway, hook adapters, session vault,
and tests.

## Enforced modes

| Host | Default boundary | Local capabilities |
| --- | --- | --- |
| Claude Code | Prompt/startup isolation plus replaceable tool-result hooks | Supported native file, terminal, and tool paths remain available; unsupported context sources are isolated. |
| Codex | Bidirectional loopback Responses gateway around stock Codex | Normal `CODEX_HOME`, history, skills, plugins, user MCPs, filesystem, shell, patching, Git, resume, fork, exec, and review remain available. |
| Codex `--privacy-strict` | Credential-only home plus prompt-only hook isolation | Tool-capable features are denied; retained as a fail-closed fallback. |
| AGY / Antigravity | Fresh one-shot prompt isolation | Every tool call is denied because the installed AGY hook API cannot safely replace arguments and results. |

## Codex provider gateway

`privacyai codex` starts the installed stock Codex binary with a temporary custom
provider configuration. The user keeps the same OpenAI login, model, workspace,
configuration, history, skills, plugins, and MCP servers. Resume and fork with
`privacyai codex resume ...` and `privacyai codex fork ...`. Invoking raw
`codex resume` or `codex fork` does not start this gateway and can send
unsanitized local history directly to the configured Codex provider.

```text
stock Codex
    │ normal Responses request
    ▼
127.0.0.1:<random-port>/<random-nonce>
    │
    ├─ sanitize model-visible request fields locally
    ├─ preserve protocol IDs, model selection, and usage accounting
    ├─ persist stable placeholder mappings per Codex thread
    ├─ forward once to the fixed OpenAI upstream
    └─ restore streamed assistant text and completed tool arguments locally
    ▼
OpenAI Codex backend
```

The gateway adds no second OpenAI request. Classification uses the configured
loopback-local PrivacyAI model, so OpenAI usage remains the normal Codex turn
apart from small token differences caused by placeholders.

The exact startup-prompt capture waits for Codex MCP initialization. Its timeout
is derived from the largest configured `startup_timeout_sec` plus a safety
margin, with a bounded fallback and hard maximum. Set
`PRIVACYAI_STARTUP_AUDIT_TIMEOUT_MS` to a positive millisecond value to override
that derived limit for unusually slow local MCP environments.

### Protected request content

The transformer handles:

- system/developer instructions and user messages;
- native command, patch, and function-call inputs and outputs;
- MCP and dynamic tool text results represented in Responses items;
- reasoning summaries and compaction requests;
- tool descriptions and JSON Schema values;
- user-defined JSON Schema property, definition, and dependency keys;
- output schemas;
- resumed, forked, and child-thread mappings;
- model-visible error text.

Protocol identity fields such as response IDs, call IDs, model names, and
reserved JSON Schema keywords are not classified. `prompt_cache_key` is replaced
with a stable SHA-256-derived local identifier. Workspace metadata and unknown
client metadata are removed before forwarding.

The local classifier window is independent of the target Codex model window.
PrivacyAI groups model-visible data by owning artifact—such as one message, tool
result, instruction block, tool definition, or output schema—then processes each
artifact sequentially. Oversized artifacts are split into bounded overlapping
chunks and rebuilt locally before the complete sanitized request is forwarded.
Unrelated artifacts are never mixed into one classifier call, and an unchanged
artifact can reuse its persisted verification without rescanning the thread.

If Codex disconnects while classification or streaming is active, the abort
propagates through the artifact loop and into the LM Studio/Ollama HTTP request.
PrivacyAI cancels the upstream request and treats the disconnect as normal
cancellation rather than an unhandled gateway failure.

### Response restoration

SSE is parsed as a protocol, not rewritten as arbitrary bytes. UTF-8 and SSE
frames may be split at any network boundary. Text deltas use a bounded streaming
placeholder restorer. Completed function-call arguments are parsed as JSON,
restored recursively—including object keys—and serialized again so quotes,
newlines, and backslashes remain valid.

`response.function_call_arguments.delta` is intentionally withheld because an
arbitrary placeholder may span JSON escape boundaries. The authoritative
`response.output_item.done` event is restored atomically and delivered to Codex.

### Fail-closed transport policy

The server:

- binds only to literal `127.0.0.1` on a random port;
- requires a random 24-byte URL nonce;
- accepts only `/responses`, `/responses/compact`, `/models`, and local health;
- hardcodes the ChatGPT Codex and OpenAI API upstreams;
- forwards authentication only in process memory and never logs it;
- strips hop-by-hop, forwarding, host, length, and encoding headers;
- disables request compression and requires identity-encoded upstream responses;
- applies bounded request, response, session-cache, and per-session item limits;
- never retries independently of Codex;
- preserves upstream status codes such as `401`, `429`, and `500`;
- rejects malformed JSON/SSE, unknown response-item types, unsupported media,
  unsupported binary output, unknown top-level fields, and ambiguous mappings.

Provider-hosted search, apps/connectors, browser/computer use, image generation,
realtime transport, WebSockets, remote Codex clients, alternate model providers,
and server modes are disabled until they receive their own protected boundary.
Local user MCP servers remain available because their model-visible results flow
through the final Responses request. MCP servers, plugins, skills, and hooks are
trusted local code: they can perform their own network I/O outside this provider
proxy. PrivacyAI protects Codex's configured model-provider traffic; it is not an
outbound firewall for arbitrary local extensions.

## Reusable SDK boundary

The bridge reuses `@privacy-ai/sdk` v0.0.2 for:

- stable session-map normalization and collision-safe rebasing;
- known-value sanitization and recursive restoration;
- structured atomic sanitization, including object keys;
- provider-bound leak assertions;
- unresolved-placeholder detection;
- chunk-safe streaming restoration.

Codex-specific HTTP, Responses, SSE, authentication forwarding, launch policy,
and session routing remain in this package.

## Session state and performance

Session maps remain stored under `~/.local/share/privacyai/agent-sessions/` in
hashed `0600` files. Updates use ownership-token locks, PID-start identity on
Linux, bounded contention retries, and atomic rename.

The gateway also keeps a content-addressed verification ledger at
`~/.local/share/privacyai/context-gateway.sqlite3` by default. The database is
local-only, created with `0600` permissions, and contains thread metadata, the
private session mappings required to rebuild verified results, and hashes for
model-visible items. Override its location with `PRIVACYAI_CONTEXT_DB` or the
`verificationDbPath` launcher option.

Each verification key includes the exact content, artifact type, privacy-policy
version, local model identity, and sanitizer-prompt fingerprint. Unchanged
instructions, history items, tool definitions, schemas, and tool outputs are
therefore reused after gateway restarts and Codex resume/fork operations. Adding
a new session mapping does not invalidate unrelated verified content; changing
the content, model, prompt, or policy does. Child and forked threads may inherit
parent mappings only when placeholder and original identities agree exactly.

The strict local-model contract returns bounded exact private spans instead of
reproducing the full prompt. PrivacyAI reconstructs the original structure
locally and applies stable placeholders. Oversized model-visible strings are
split at deterministic text boundaries with overlap large enough to detect a
private span crossing a chunk boundary. Only text already present in the
outbound Codex request is classified; PrivacyAI does not read hidden command
artifacts or full terminal logs that Codex omitted.

The ledger uses bounded age/item pruning. On Node releases without `node:sqlite`,
the same verification interface falls back to an in-memory cache, preserving
correctness but not restart reuse. Database corruption, unsupported schemas,
ambiguous mappings, and unsafe classifier output fail closed before upstream
transmission.

## Commands

```bash
npm install --global @privacy-ai/agent-tui
privacyai onboard
privacyai doctor
privacyai claude
privacyai codex
privacyai codex --privacy-strict
privacyai agy --print "fresh one-shot prompt"
```

## Tests

```bash
pnpm --filter @privacy-ai/sdk test
pnpm --filter @privacy-ai/agent-bridge test
pnpm --filter @privacy-ai/agent-tui test
pnpm -r test
```

The regular bridge suite includes a real installed stock-Codex integration. It
uses a dummy local API key and mock Responses backend, forces Codex to use its
native command tool, verifies that the restored fake private value is written
locally, and confirms that every captured upstream turn contains placeholders
only. Optional live tests use fake values and the user's existing OpenAI login.

## Remaining boundary

The Codex gateway protects supported text/JSON Responses traffic. It does not yet
claim protection for images, files uploaded directly to OpenAI, audio, realtime
media, provider-hosted search/apps/browser tools, encrypted or derived secrets,
or unknown future transports. These paths are disabled or rejected rather than
silently treated as protected.

Local files, command lines, terminal panels, Codex history, and application logs
may contain restored values because restoration is intentionally local. The
provider-facing privacy boundary is not a local data-erasure feature. The vault
is permission-protected but not yet encrypted at rest.

Current platform support is Linux and macOS. Windows remains fail-closed until a
fully tested equivalent launcher and transport boundary is available.
