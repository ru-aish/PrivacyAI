# PrivacyAI native Claude Code, Codex, and Antigravity wrapper

Status: P0 context-boundary hardening implemented on July 12, 2026.

The wrapper keeps each official CLI, account, subscription, provider route, and
terminal UI. It does not treat all native hook APIs as equally capable. Claude
Code uses the supported result gateway; Codex and AGY default to prompt-only
isolation because their currently exposed result boundaries cannot safely cover
every failure and implicit-context path.

## Security decision

The previous implementation was prompt-rooted:

```text
prompt contains secret
        ↓
create placeholder map
        ↓
restore before tool
        ↓
replace only values already in map
```

That misses secrets first discovered in files, APIs, errors, resources, and
startup instructions. P0 changes the root invariant to:

> No supported byte becomes model-visible until it has crossed a local context
> privacy boundary. A host path without a trustworthy boundary is isolated or
> blocked, not described as protected.

## Enforced modes

| Native host | Startup boundary | Prompt boundary | Tool boundary |
| --- | --- | --- | --- |
| Claude Code | Credential-only config home; strict empty MCP config; project instructions/skills/commands/agents/plugins scanned locally | Block original and reinject placeholders | Supported success results are classified atomically; new values extend the map; unsafe failure/batch results stop the turn |
| Codex | Credential-only `CODEX_HOME`; tool features disabled; `debug prompt-input` captured, classified, and canary-checked | Block original and reinject placeholders | Every `PreToolUse` is denied in production prompt-only mode |
| AGY / Antigravity | Fresh one-shot only; scoped temporary global hook | Prompt sanitized before process launch | Every scoped tool call is denied, even when the prompt map is empty |

## Components

### `@privacy-ai/agent-tui`

The user-facing executable:

```text
privacyai onboard
privacyai doctor
privacyai claude [safe native arguments]
privacyai codex [safe native arguments]
privacyai agy --print "fresh one-shot prompt"
```

### `@privacy-ai/agent-bridge`

The implementation package now contains:

- loopback-local sanitizer configuration and health checks;
- prompt blocking and one-time PTY reinjection;
- a structured context gateway for model-visible results;
- stable placeholder rebasing and shielding;
- transactional per-session vault updates;
- native hook generation and Codex hook trust discovery;
- credential-only runtime-home isolation;
- Codex model-visible startup capture and canary verification;
- Claude static startup-context collection and classification;
- strict native argument/context-ingress guards;
- AGY process scoping and serialized hook installation.

## Prompt flow

```text
┌──────────────────────┐
│ Native CLI composer  │
└──────────┬───────────┘
           │ raw prompt
           ▼
┌──────────────────────┐
│ UserPromptSubmit     │
│ local hook           │
└──────────┬───────────┘
           │
           ├─ reject native @file expansion
           ├─ reject native shell escape
           ├─ reject context-loading slash command
           └─ call loopback-local privacy model
           │
           ▼
┌──────────────────────┐
│ Safe prompt + map    │
└──────────┬───────────┘
           │ original submit blocked
           ▼
┌──────────────────────┐
│ Transparent PTY      │
│ one-time reinjection │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Official CLI/provider│
└──────────────────────┘
```

The PTY bracket-pastes the safe prompt and sends Enter separately. A hashed,
short-lived allowance lets exactly that reinjected prompt pass the hook once.

### Native prompt ingress that fails closed

The prompt hook blocks paths whose contents are expanded only after the hook:

- `/review` and other non-allowlisted slash commands;
- `@README.md`, `@src/file.ts`, and similar file/context mentions;
- native `!command` shell escapes.

Only a small allowlist of non-contextual UI commands, such as `/help`, `/model`,
`/status`, and `/theme`, bypasses classification.

## Structured context gateway

For replaceable result events, PrivacyAI does not sanitize each JSON leaf in
isolation. It serializes the complete value once:

```text
{
  "secret-as-a-key": "secret in a value",
  "nested": ["same secret"]
}
        ↓
known originals replaced
        ↓
existing placeholders shielded
        ↓
whole JSON document classified locally
        ↓
new mappings rebased against session state
        ↓
protected-original assertion
        ↓
JSON parsed back to original structure
```

This protects object keys and keeps one newly discovered value mapped to one
stable placeholder throughout a result. It also avoids rotating existing fake
emails or other placeholder values when the local classifier sees them again.

The gateway fails closed if:

- the sanitizer does not return text;
- the sanitized document is no longer valid JSON;
- a protected original remains;
- the result is too large for one atomic classification pass;
- a new map cannot be persisted;
- a private failure result has no safe replacement field.

### Claude tool lifecycle

Claude Code retains the gateway mode because it exposes structured successful
result replacement. The lifecycle is:

```text
placeholder arguments
        ↓
PreToolUse restores local originals
        ↓
tool executes
        ↓
PostToolUse classifies the complete result
        ↓
newly discovered values merge transactionally
        ↓
updatedToolOutput returns only placeholders
```

For failed or batched paths, PrivacyAI scans only model-visible result fields;
restored local `tool_input`, `input`, and `arguments` fields are excluded. When
private data is detected and the host offers no shape-preserving replacement,
the turn is stopped before another model request.

### Codex tool lifecycle

Codex's native APIs can expose a successful post-tool hook, but current failed,
cancelled, deferred/polling, and some control-channel paths do not provide the
same reliable replacement boundary. Therefore production mode is deliberately
stricter:

```text
any Codex PreToolUse event
        ↓
PrivacyAI deny
```

The launcher also disables apps, plugins, browser/computer use, image generation,
multi-agent/code modes, shell/unified execution, remote plugins, workspace
dependencies, and MCP elicitation features. The hook denial remains the final
defense if a native tool is still surfaced.

The reusable gateway code still supports Codex-shaped result tests so a future
upstream replacement boundary can adopt it without redesigning session state.

### AGY tool lifecycle

AGY can deny a tool but cannot rewrite tool arguments or outputs. The earlier
behavior allowed tools when a clean prompt created no session map; that was
unsafe because the tool itself could discover the first secret. P0 removes that
exception. Every scoped tool call is denied for every protected AGY launch.

## Startup-context boundary

### Codex exact model-input preflight

Every protected Codex launch gets a new temporary `CODEX_HOME`. Only regular,
non-symlink credential files are copied with mode `0600`; global `AGENTS.md`,
config, memories, skills, plugins, MCP definitions, caches, and histories are
not copied.

Before opening the TUI, PrivacyAI asks the installed Codex binary to serialize
its own model-visible startup input with:

```text
codex ...privacy flags... debug prompt-input [LOCAL_CANARY_PLACEHOLDER]
```

The captured JSON is bounded in size, parsed, and classified locally. PrivacyAI
asserts that:

1. the placeholder appears in the capture, proving the capture contains the
   supplied user item;
2. its locally held original canary does not appear, proving no boundary restored
   it before model input;
3. no high-risk private values are already present in the implicit startup
   context.

No captured raw context is printed in diagnostics. A timeout, nonzero exit,
invalid JSON, missing placeholder, excessive output, canary leak, or high-risk
detection blocks launch.

This is the final **model-visible startup serialization** exposed by Codex. It is
not a packet capture of the encrypted transport and cannot assert every later
HTTP request. A complete final-request gateway requires an upstream hook,
maintained Codex patch, or local provider proxy.

### Claude static preflight

Claude Code does not expose an equivalent startup serializer. PrivacyAI instead:

- creates a temporary credential-only `CLAUDE_CONFIG_DIR`;
- limits settings sources to the isolated user source;
- passes an explicit empty MCP config with strict MCP mode;
- disables slash commands, attachments, CLAUDE.md loading, auto-memory, bundled
  skills, background tasks/agent view, Claude.ai MCP connectors, prompt-history
  persistence, and sensitive telemetry payload fields;
- scrubs provider credentials from Claude-spawned subprocess environments;
- scans project `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, settings,
  `.mcp.json`, and files under `.claude/skills`, `commands`, `agents`, and
  `plugins` from the working directory to the Git root.

The scan is bounded by file count and aggregate size. Symlinks are not followed.
Any high-risk private detection or unclassifiably large context blocks startup.

## Session vault and concurrency

Session IDs are hashed before becoming filenames. Records and temporary files
use `0600`; directories use `0700`; writes use atomic rename.

P0 adds a per-session transaction lock:

```text
acquire exclusive .lock
        ↓
load current map
        ↓
rebase/merge additions
        ↓
atomic save
        ↓
release lock
```

A bounded retry loop handles contention. Locks from dead processes or older than
the stale threshold are removed. Parallel prompt/tool writers can no longer
silently overwrite each other's additions.

The vault is still plaintext under local filesystem permissions; encryption or
OS-keyring storage remains separate hardening work.

## Fresh-session and argument guards

### Codex rejects

- resume and fork;
- exec/review/app-server/mcp-server modes;
- images, search, extra directories, and profiles;
- arbitrary config overrides;
- attempts to enable any feature except required hooks;
- hook disabling and dangerous trust/approval bypasses.

### Claude rejects

- resume/continue/fork and print/replay/session reuse;
- custom settings, setting sources, MCP config, plugins, agents, tools, or system
  prompts;
- browser/IDE context and permission bypass;
- hook-disabling modes and environments.

### AGY rejects

- interactive prompt mode;
- continuation, resume, or conversation reuse;
- permission bypass;
- missing one-shot prompt.

## Tests and verification

The bridge suite covers:

- raw-prompt blocking and one-time reinjection;
- no-op sanitizer results that still contain current- or prior-turn originals;
- cross-turn placeholder collision rebasing;
- known and newly discovered secrets in nested values and object keys;
- stable placeholder shielding;
- success, failure, cancellation-style, and batch events;
- malformed sanitized JSON and oversized result rejection;
- parallel session-map writers;
- executable-level Codex denial and Claude restoration/sanitization;
- AGY empty-map tool denial;
- credential-only homes and private file modes;
- Codex startup capture, missing/leaking canary, and implicit-context detection;
- Claude instruction/skill scanning;
- blocked slash, `@file`, and shell ingress;
- installed Codex strict-feature startup capture and hook discovery.

The installed Codex 0.144.1 binary was exercised in this branch with the strict
feature set. Its startup serializer returned five model-input items, the local
canary remained absent in original form, and hook discovery returned
`userPromptSubmit`, `preToolUse`, and `postToolUse` from session flags.

Optional integration tests remain available for Ollama, LM Studio, and an
installed Claude Code mock-provider/MCP lifecycle.

## Remaining boundary

This P0 hardening does not claim universal provider-request interception.
Remaining work includes:

- exact final serialized request capture for every turn;
- images, PDFs, screenshots, audio/video, OCR, and attachment metadata;
- encoded, fragmented, normalized, compressed, encrypted, or derived secrets;
- subagent state propagation and safe compaction/resume semantics;
- future host-added implicit context types not represented by current preflights;
- encrypted vault storage and local transcript/debug/crash-log scrubbing;
- message-aware restoration of placeholders in assistant prose.

Local native transcripts and execution panels can still contain restored tool
arguments on hosts where tools are allowed. The privacy guarantee targets what
crosses a supported provider-facing boundary, not erasure of all local state.

Windows remains unsupported until a ConPTY backend can preserve the same
fail-closed lifecycle.
