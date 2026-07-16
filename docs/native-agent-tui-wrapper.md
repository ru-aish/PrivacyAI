# PrivacyAI native Claude Code, Codex, and Antigravity wrapper

Status: Codex provider gateway and AGY selective transport implementation stacked
on the P0 context-boundary branch, July 2026.

## Product invariant

> No supported model-visible text or JSON crosses a remote provider boundary
> before local privacy classification. Values are restored only on the local
> side of that boundary. Unknown transports and unsupported content fail closed.

The official agent binaries remain installed and controlled by the user. The
integration boundary differs by host because each host exposes different native
capabilities.

## Enforced modes

| Host | Default mode | What remains available |
| --- | --- | --- |
| Claude Code | Prompt/startup isolation and supported lifecycle hooks | Supported native file, terminal, and tool paths. |
| Codex | Stock Codex through a bidirectional localhost Responses gateway | Normal account, model, `CODEX_HOME`, history, skills, plugins, user MCPs, filesystem, shell, patch, Git, resume, fork, exec, and review. |
| Codex strict fallback | Credential-only temporary home and hook denial | Prompt-only reasoning; tool-capable paths denied. |
| AGY | Stock AGY through a process-scoped selective HTTPS boundary | Normal account, model, files, terminal, browser, MCPs, and native tools for supported text/JSON turns. |

## Codex architecture

```text
┌────────────────────────────────────────────────────────────┐
│ User's installed stock Codex                              │
│ normal CODEX_HOME · account · model · tools · MCPs         │
└──────────────────────┬─────────────────────────────────────┘
                       │ OpenAI Responses HTTP
                       ▼
┌────────────────────────────────────────────────────────────┐
│ PrivacyAI provider gateway                                 │
│ 127.0.0.1 · random port · random path nonce                │
│                                                            │
│ OUTBOUND                                                   │
│  • parse and validate request schema                       │
│  • extract model-visible fields                            │
│  • classify uncached values with local model               │
│  • assign stable thread mappings                           │
│  • assert no protected original remains                    │
│                                                            │
│ INBOUND                                                    │
│  • parse SSE/JSON as protocol                              │
│  • restore text deltas safely across chunks                │
│  • restore completed tool arguments structurally           │
└──────────────────────┬─────────────────────────────────────┘
                       │ one authenticated upstream request
                       ▼
┌────────────────────────────────────────────────────────────┐
│ OpenAI Codex backend                                       │
└────────────────────────────────────────────────────────────┘
```

The gateway does not call a second OpenAI model. It changes the existing request
locally and streams the existing response back. OpenAI account activity and
usage remain normal Codex activity; only placeholder tokenization may change the
exact input-token count slightly.

### Provider configuration

PrivacyAI injects temporary command-line configuration equivalent to:

```toml
model_provider = "privacyai"

[model_providers.privacyai]
name = "OpenAI through PrivacyAI"
base_url = "http://127.0.0.1:<port>/<nonce>"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

It does not rewrite the user's configuration file or copy the normal Codex home.
Security-critical provider/base-URL/WebSocket/compression overrides are reserved
by the wrapper. Ordinary model, sandbox, approval, directory, resume, fork,
exec, review, and local-feature arguments remain usable.

### Supported paths

The gateway currently accepts only:

```text
GET  /<nonce>/health
GET  /<nonce>/models
POST /<nonce>/responses
POST /<nonce>/responses/compact
```

The production upstream destination is selected internally between the ChatGPT
Codex backend and the OpenAI API according to the authentication headers emitted
by stock Codex. A client-supplied upstream is never honored.

### Outbound transformation

The request transformer validates top-level fields and known Responses item
shapes. It protects:

- instructions and user/developer text;
- assistant and reasoning text already in history;
- native shell, patch, and function-call arguments;
- command, MCP, and dynamic-tool results represented in Responses input;
- tool descriptions and schemas;
- user-defined JSON Schema property, definition, pattern, and dependency keys;
- corresponding `required`, `$ref`, enum, default, and example strings;
- output schemas;
- compaction input and error text.

The transformer preserves model names, response IDs, call IDs, and reserved
protocol/JSON Schema keys. It strips unknown client metadata and hashes the
prompt-cache key into a stable PrivacyAI identifier.

Function-call arguments are parsed as JSON before classification. This ensures a
private value containing quotes, line breaks, backslashes, or Unicode is restored
as valid JSON rather than replaced in an encoded string.

### Inbound restoration

Network chunks do not align with Unicode, SSE events, placeholders, or JSON
values. The response path therefore uses:

1. `StringDecoder` for UTF-8 boundaries.
2. An SSE frame parser supporting LF and CRLF framing.
3. A bounded placeholder-prefix buffer for text deltas.
4. Atomic JSON restoration for completed function calls.

Raw `response.function_call_arguments.delta` events are withheld. Arbitrary
replacement in a partial JSON string can invalidate escapes. Codex receives the
restored authoritative `response.output_item.done` event instead.

### Sessions, forks, and subagents

Each request must carry a stable Codex thread or session identifier in allowlisted
body metadata or the native `x-codex-turn-metadata` header. Missing identity fails
closed instead of sharing a gateway-wide fallback map. Mappings are persisted
through the existing hashed, permission-restricted session vault. Parent/fork
mappings may be inherited only when:

- the same placeholder maps to the same original; and
- the same original maps to the same placeholder.

Any ambiguity blocks the request before upstream transmission.

A bounded in-memory cache fronts a persistent SQLite verification ledger. Each
entry is addressed by the content hash, artifact type, and a policy fingerprint
covering the sanitizer model and prompt. The ledger survives gateway restarts,
so resumed threads do not reclassify unchanged history, instructions, tool
definitions, schemas, or tool outputs. Session-map growth alone does not invalidate
clean entries; content or policy changes do. Parent/fork threads can reuse the
same content-addressed records while retaining collision checks on private maps.

Strict classification is detection-oriented: the local model returns exact
bounded private spans, and the SDK reconstructs the complete structured value.
Large model-visible strings are divided into overlapping, deterministic chunks,
then merged through exact-substring mappings. This bounds local-model context
without truncating the text sent to Codex's real model.

### Disabled provider-hosted paths

The following are intentionally disabled in gateway mode until their complete
provider traffic and local restoration boundary are supported:

- Responses WebSockets and realtime conversation;
- provider-hosted web search;
- OpenAI apps/connectors;
- in-app browser and computer use;
- image generation and direct media inputs;
- remote plugins;
- remote Codex/app-server clients and alternate model providers.

User-configured local MCP servers are not disabled. Their model-visible text
returns through the protected Responses request. Local MCPs, plugins, skills,
and hooks remain trusted local code and can make independent network requests;
the provider gateway is not an outbound firewall for extension processes.

## Codex strict fallback

```bash
privacyai codex --privacy-strict
```

Strict mode retains the earlier P0 behavior:

- temporary credential-only `CODEX_HOME`;
- skills, plugins, MCP configuration, history, and implicit context omitted;
- prompt startup input audited through Codex's serializer;
- tool-capable features disabled;
- every Codex `PreToolUse` denied.

It is intended for unsupported Codex versions or deployments that require the
smallest possible provider-facing surface.

## Claude Code

Claude Code continues to use a transparent PTY, prompt hook, credential-only
configuration home, startup-context audit, and supported lifecycle hooks.
Placeholder arguments are restored before local execution. Successful structured
results are atomically classified and replaced before another model turn. A
private failure/batch path without a shape-preserving replacement stops.

## Antigravity

`privacyai agy` now keeps the installed stock AGY runtime and its normal account,
model, files, terminal, browser, MCPs, and native tool execution. PrivacyAI adds
an ephemeral process-only CA plus an authenticated loopback CONNECT proxy.
Connections to unrelated hosts are tunneled unchanged. On the current AGY model
host, non-generation routes remain opaque while the supported
`streamGenerateContent` route is validated and transformed.

```text
stock AGY
  -> native local tool work
  -> complete supported model request
  -> local bounded classification + persistent verification cache
  -> complete sanitized model request
  -> streamed response restoration
  -> stock AGY executes the native tool call
```

Private function names receive deterministic aliases that remain valid under the
provider's function-name grammar and are restored locally before execution. The
local classifier window does not reduce the remote model context: oversized
artifacts are inspected in bounded chunks and rebuilt before forwarding.

Current fail-closed limitations are unsupported image/media parts, model route or
schema drift, compressed model-generation payloads, Windows, and environments
that already require an HTTP/SOCKS proxy. The previous prompt-only boundary is
retained explicitly as:

```bash
privacyai agy --privacy-strict --print "fresh one-shot prompt"
```

## Reusable SDK v0.0.2 layer

Generic privacy mechanics live in `@privacy-ai/sdk`:

```text
session-map normalization
collision-safe placeholder rebasing
known-value replacement
recursive object-key/value restoration
atomic structured sanitization
provider-bound leak assertion
unresolved-placeholder detection
chunk-safe streaming restoration
```

The agent bridge owns only host-specific launch, HTTP, Responses, SSE, session
routing, and policy logic.

## Transport hardening

The Codex gateway:

- binds literal IPv4 loopback only;
- uses a random 24-byte route nonce;
- rejects WebSocket upgrades;
- requires JSON and uncompressed requests;
- requires identity-encoded upstream responses;
- strips hop-by-hop and forwarding headers;
- forwards authorization only in memory and never logs it;
- bounds request, response, cache, and session counts;
- does not independently retry;
- preserves upstream status codes and retry headers;
- rejects malformed JSON/SSE, unknown request fields/items, unsupported media,
  non-text output, and schema-key collisions;
- returns generic local errors that do not contain protected values.

## Test evidence

The automated suite covers:

- every placeholder split point and one-character streaming chunks;
- shared-prefix placeholders and partial-prefix flushes;
- Unicode network fragmentation;
- object-key and JSON Schema-key restoration/collisions;
- quote/newline/backslash-safe function arguments;
- malformed and incomplete JSON/SSE;
- compressed, oversized, binary, and unknown requests/responses;
- wrong nonces and unsupported routes;
- exact `401`/`429`/`500` passthrough with no proxy retry;
- repeated-history classification caching;
- parent/fork inheritance and conflict rejection;
- launcher cleanup on success and failure;
- explicit strict-mode selection;
- a real installed stock-Codex native command loop against a mock Responses
  backend.

The stock-Codex integration uses a dummy API key and fake private value. Codex
executes its native command tool, writes the restored value locally, sends the
native result into its next model request, and every captured upstream request
contains placeholders only.

## Remaining boundary

The current guarantee covers supported textual/JSON Responses traffic. It does
not cover images, uploaded files, audio, provider-hosted search/apps/browser
results, realtime media, encrypted/derived secrets, or unknown future transports.
Those paths are disabled or rejected.

Restored values may exist in local files, terminal output, Codex history, crash
reports, and application logs. PrivacyAI protects the remote provider boundary;
it is not a local data-erasure system. Session records are protected with local
filesystem permissions and atomic locking but are not yet encrypted at rest.

Current platform support is Linux and macOS. Windows remains blocked until an
equivalent fully tested implementation is available.
