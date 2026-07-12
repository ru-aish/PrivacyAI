# @privacy-ai/agent-bridge

PrivacyAI's local privacy boundary for native agent CLIs.

The bridge keeps the installed provider login and native terminal UI. It uses a
loopback-local privacy model, native lifecycle hooks, temporary credential-only
runtime homes, and a transparent PTY. It does not silently claim coverage for a
host boundary that cannot be intercepted.

The public `privacyai` command is published by `@privacy-ai/agent-tui`; this
package contains the implementation and hook executables.

## Security invariant

No model-visible prompt, implicit startup context, or supported tool result may
cross the boundary before local classification. A real value is restored only
at the local execution boundary, then removed again before the result can be
submitted to a task model.

Native clients do not expose every boundary equally, so the enforced mode is
host-specific:

| Host | Enforced mode | Tool behavior |
| --- | --- | --- |
| Claude Code | Prompt gateway + audited startup context + supported tool-result gateway | Successful results are classified, newly discovered values extend the session map, and unsafe failed/batched results stop the turn. |
| Codex | Fresh-session prompt-only isolation | Tool-capable features are disabled and every `PreToolUse` event is denied because failed, deferred, and control-channel results are not reliably replaceable. |
| AGY / Antigravity | Fresh one-shot prompt-only isolation | Every scoped tool call is denied, including clean-prompt sessions, because AGY cannot rewrite arguments or outputs. |

## Prompt path

```text
raw prompt in native composer
        ↓
UserPromptSubmit hook
        ↓
loopback-local classifier creates safe text + reversible map
        ↓
original submit is blocked
        ↓
PTY reinjects the safe prompt once
        ↓
native provider path receives placeholders
```

Only a small allowlist of non-contextual slash commands remains native (`/help`,
`/model`, `/status`, and similar UI commands). Context-loading slash commands,
`@file` expansion, and native shell escapes are blocked before the local
sanitizer because the client expands them after the prompt hook.

## Tool-result context gateway

For a host that exposes a replaceable result boundary, PrivacyAI serializes the
entire structured result once, including JSON object keys, and classifies it as
one atomic document:

```text
model-visible placeholder arguments
        ↓
PreToolUse restores mapped originals locally
        ↓
local tool executes
        ↓
whole success/error result is classified
        ↓
new values are assigned stable placeholders
        ↓
transactional session-map merge
        ↓
only safe result continues to model context
```

The gateway fails closed when:

- structured sanitization no longer parses as the original JSON shape;
- the result exceeds the configured atomic classification limit;
- a protected original remains in the serialized payload;
- newly discovered mappings cannot be persisted;
- a failure/batch event contains private data but the host has no safe
  shape-preserving replacement field.

Existing placeholders are shielded while discovering new values, preventing a
fake email or other placeholder from being classified again and rotated.

## Startup-context isolation

### Codex

Each launch receives a temporary `CODEX_HOME` containing only supported
credential files. Global instructions, memories, skills, plugins, MCP config,
and caches are not copied. Tool-capable feature flags are disabled. Before the
TUI starts, PrivacyAI runs Codex's own `debug prompt-input` serializer against
the isolated environment, verifies a local canary is not restored, and locally
classifies the captured model-visible startup input. A high-risk detection
blocks launch without printing the detected value.

This captures Codex's model-visible startup serialization, not the encrypted
network transport or every future HTTP request. A true final-request gate still
requires a maintained provider proxy, upstream hook, or Codex patch.

### Claude Code

Each launch receives a temporary `CLAUDE_CONFIG_DIR` containing only supported
credential files. User settings are isolated, project MCP config is replaced by
an explicit empty strict config, and native switches disable attachments,
CLAUDE.md loading, auto-memory, bundled skills, background agents, prompt-history
persistence, connected Claude.ai MCP servers, and sensitive telemetry fields.
Known project instruction/skill/command/agent/plugin files are still classified
before startup as defense in depth. A high-risk detection or an unclassifiably
large startup context blocks launch.

## Session state

Session maps are stored under
`~/.local/share/privacyai/agent-sessions/` in hashed `0600` files. Updates use a
per-session lock with timeout, dead-process/stale-lock recovery, atomic rename,
and a single read-modify-write transaction, preventing parallel tool calls from
silently losing newly discovered mappings.

The vault is permission-protected but not encrypted at rest yet.

## Argument and lifecycle guards

Protected launches reject paths that can reintroduce uninspected context:

- Codex resume/fork/exec/review/app-server modes, images, extra directories,
  profiles, arbitrary config overrides, search, and re-enabled tool features;
- Claude resume/fork/print modes, custom settings, MCP/plugin/agent/tool/system
  prompt sources, browser/IDE context, and hook-disabling modes;
- AGY interactive, resume/reuse, and permission-bypass modes.

Windows is rejected until a ConPTY implementation exists.

## Commands

```bash
npm install --global @privacy-ai/agent-tui
privacyai onboard
privacyai doctor
privacyai claude
privacyai codex
privacyai agy --print "fresh one-shot prompt"
```

Onboarding supports loopback Ollama and LM Studio providers and refuses remote
sanitizer endpoints by default.

## Tests

```bash
pnpm --filter @privacy-ai/agent-bridge test
pnpm -r test
```

The regular suite covers prompt reinjection, placeholder collisions, newly
discovered values in strings and object keys, failure paths, invalid structured
output, oversized results, parallel vault writers, strict Codex/AGY isolation,
credential-only homes, startup-file scanning, native context expansion,
prior-turn prompt leaks, and provider-input canary failures. Optional E2Es exercise local Ollama/LM Studio and
an installed Claude Code mock-provider/MCP lifecycle when their prerequisites
are present.

## Remaining boundary

The native wrapper still cannot prove or rewrite every byte of every final
provider request. Attachments, screenshots, audio/video extraction, arbitrary
host-added future context types, encrypted/encoded derivations, and local
transcript/log retention require additional boundaries. The implementation
fails closed for the high-risk native paths it can identify rather than calling
them protected.
