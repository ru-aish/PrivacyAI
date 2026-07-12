# PrivacyAI native Claude Code, Codex, and Antigravity wrapper

Status: working prototype. The full reversible tool lifecycle is tested on
Claude Code 2.1.206 and Codex 0.143.0 on Linux. Antigravity CLI is supported
through a narrower, fail-closed one-shot compatibility path verified against
the locally installed AGY build on July 12, 2026.

## Decision

The implementation does not use an inference proxy, a custom provider router,
or another account. It wraps the installed official CLI locally and relies on
native lifecycle hooks plus a transparent pseudo-terminal.

This keeps the user's normal provider login and subscription path unchanged.

## Components

### `@privacy-ai/agent-tui`

The small user-facing package. It publishes one executable:

```text
privacyai
```

Supported commands:

```text
privacyai onboard
privacyai doctor
privacyai claude [native Claude arguments]
privacyai codex [native Codex arguments]
privacyai agy --print "fresh one-shot prompt"
```

### `@privacy-ai/agent-bridge`

The implementation package:

- configuration and model health checks;
- SDK-backed prompt sanitization;
- per-session reversible vault;
- prompt blocking and one-time reinjection allowance;
- transparent Unix PTY host;
- temporary Claude hook settings;
- per-process Codex hook declaration and trust resolution;
- all-tool pre/post transformations for built-in, app, and MCP tools;
- pre-launch AGY prompt sanitization and a temporary global `PreToolUse` guard;
- serialized AGY hook-file locking, stale-lock recovery, and exact cleanup;
- onboarding.

## Prompt path

1. The user types normally in the original Claude Code or Codex TUI.
2. The native `UserPromptSubmit` hook receives the exact prompt.
3. PrivacyAI sends it only to the configured loopback-local privacy model.
4. The existing SDK returns safe text plus a reversible session map.
5. PrivacyAI persists the map locally and blocks the original submit.
6. The PTY waits for the native composer to become ready again.
7. It bracket-pastes the sanitized prompt and sends Enter as a separate key
   event.
8. A one-time allowance lets that exact sanitized prompt pass its second hook
   invocation.
9. The official CLI sends the sanitized prompt through its normal provider
   connection.

The separate Enter event is important: Claude Code can leave pasted text in the
composer when the bracketed-paste terminator and Enter arrive in one PTY write.
The integration test caught and fixed this behavior.

## Tool path

For any model-generated tool call, PrivacyAI registers wildcard `PreToolUse` and
`PostToolUse` hooks. This includes built-in tools, app tools such as Gmail,
plugin-provided tools, and MCP tools.

`PreToolUse` loads the current CLI session's map and recursively restores values
inside objects and arrays immediately before execution. The selected tool
receives the real local value while the model-visible tool call continues to
contain the placeholder.

After successful execution, `PostToolUse` recursively replaces all known
originals before the result is added to remote model context. Claude does not
provide equivalent output replacement for every failed-tool error, so a
`PostToolBatch` guard scans the model-visible result fields and stops the turn
before the next provider request when a known original remains. Restored
`tool_input` fields are intentionally excluded from that batch scan because they
are local execution records. A recognizable placeholder with no mapping is
denied rather than executed.

## Antigravity compatibility path

The installed AGY lifecycle API has materially different capabilities:

- there is no `UserPromptSubmit` hook;
- `PreToolUse` can allow or deny a call but cannot replace `toolCall.args`;
- `PostToolUse` accepts only an empty result and cannot replace tool output;
- the local hook documentation explicitly says pre-tool overwrite is not yet
  implemented.

PrivacyAI therefore does not claim Claude/Codex-equivalent AGY protection. It
supports only a fresh one-shot prompt supplied through `-p`, `--print`, or
`--prompt`. The prompt is sanitized by the configured local model before the
official AGY process starts. Interactive prompt mode, conversation continuation,
conversation reuse, and permission bypass are rejected.

For the lifetime of the AGY child, PrivacyAI merges a uniquely named wildcard
`PreToolUse` guard into `~/.gemini/config/hooks.json`. The file is protected by a
process lock, existing hooks are preserved, stale PrivacyAI hooks and dead locks
are cleaned up, and the original bytes and mode are restored when no external
changes occurred. A random per-launch environment token scopes the hook to the
wrapped AGY process; unrelated AGY processes explicitly bypass it before the
private map is read. Protected AGY runs are intentionally serialized because
this installed build discovers lifecycle hooks from the global root rather than
from a per-process settings argument.

When the sanitizer creates a reversible private mapping, every AGY tool call is
denied for that turn. This is required because even a tool call with apparently
clean arguments could return a mapped private value, and AGY provides no output
rewrite boundary. When the map is empty, clean tools can proceed through the
same guard. A recognizable placeholder or known original in tool arguments is
always denied.

## Native experience preserved for Claude and Codex

The child process owns a real PTY. PrivacyAI forwards terminal bytes, resize
events, and keyboard input without rendering its own replacement interface.
Consequently the following remain native:

- slash commands;
- command palette and autocomplete;
- colors and alternate-screen behavior;
- permission prompts;
- model selection;
- resume/session behavior;
- keyboard shortcuts;
- provider authentication and subscription billing.

PrivacyAI adds only the block-and-reinject lifecycle around protected prompts.
AGY one-shot mode still uses the official CLI, authentication, model selection,
and provider route, but it does not open an unrestricted interactive TUI because
that would bypass the pre-launch prompt boundary.

## Onboarding

The recommended model is Ministral 3 3B, with Ollama and LM Studio supported as
local sanitizer providers:

1. Detect `ollama` on PATH and probe its local API for downloaded completion-capable models.
2. Probe the LM Studio local server at `http://127.0.0.1:1234` by default.
3. Use LM Studio's model metadata to include LLM/VLM entries and exclude embedding-only entries.
4. Merge both providers into one numbered menu with provider, load state, quantization, and context metadata.
5. Prefer an already-downloaded Ministral 3 3B copy; if neither provider has one, offer Ollama `ministral-3:3b` as the default download.
6. Let the user select any listed model by number or type another Ollama model name.
7. Save `provider`, `model`, and the provider-specific loopback base URL in `~/.config/privacyai/config.json` with mode `0600`.
8. Verify the selected model through the corresponding local provider API.
9. Print the launch commands and the GitHub project link.

The launcher refuses to start protected mode when onboarding or the local model
is missing. For Claude, it also rejects `--bare`, `--safe-mode`, custom
`--settings`, custom `--setting-sources`, and truthy `CLAUDE_CODE_SIMPLE` or
`CLAUDE_CODE_SAFE_MODE` environments because those paths can suppress the
privacy hooks. Temporary session settings explicitly set `disableAllHooks` to
`false` while preserving normal MCP configuration and native `--mcp-config`
usage. For AGY, the launcher rejects interactive-prompt, continuation,
conversation-reuse, and `--dangerously-skip-permissions` modes because they
would bypass or weaken the one-shot privacy boundary.

## Verified results

### Real Ministral local-model lifecycle

The opt-in test command below was run against the downloaded
`ministral-3:3b` model through the actual prompt-hook and agent-hook executable
processes, not a mocked sanitizer:

```bash
pnpm --filter @privacy-ai/agent-bridge test:e2e:ministral
```

The test verified that the raw synthetic email was absent from the pending
model-facing prompt, the reversible mapping was saved locally, the original was
restored only in the Bash command immediately before execution, the local file
received the original value, and the post-tool hook converted the result back
to the placeholder.

### Real LM Studio local-model lifecycle

The LM Studio server was discovered through its local model API, and onboarding
selected `mistralai/ministral-3-3b` with provider `lm-studio` and base URL
`http://127.0.0.1:1234/v1`. The executable-hook E2E command was then run against
the real loaded model:

```bash
pnpm --filter @privacy-ai/agent-bridge test:e2e:lmstudio
```

It verified prompt sanitization, local reversible-map persistence, pre-tool
restoration, successful local execution, and post-tool re-sanitization.

### Antigravity hook and one-shot verification

The locally installed AGY build was exercised with disposable lifecycle hooks
and harmless prompts on July 12, 2026. A project-local `.agents/hooks.json` was
not discovered by that build, while a temporary global
`~/.gemini/config/hooks.json` was loaded and fired `PreInvocation`,
`PostInvocation`, `PreToolUse`, `PostToolUse`, and `Stop` events.

A clean one-shot probe returned `AGY_GLOBAL_HOOK_OK`. A second probe asked AGY
to execute `pwd`; the wildcard pre-tool hook received the real payload before
execution, including tool name `run_command` and arguments `CommandLine`, `Cwd`,
and `WaitMsBeforeAsync`. The clean call completed and returned the AGY scratch
directory. The post-tool payload contained call metadata but no replaceable tool
result, confirming the documented output-rewrite limitation.

The automated compatibility tests additionally verify prompt replacement before
spawn, sensitive-turn tool isolation, clean-turn tool allowance, invalid-mode
rejection, hook-file merging, exact restoration, stale-hook cleanup, and
preservation of concurrent external hook changes.

### Native all-tool MCP verification

A harmless local MCP server exposing `send_mail` was connected to the installed
Codex TUI. The local privacy model changed a synthetic recipient to
`contact1@example.com` before the task-model request. Codex generated the MCP
call with that safe recipient, the wildcard `PreToolUse` hook restored the
original recipient before the fake server received it, and `PostToolUse`
returned a sanitized result to the model.

The verification checked these boundaries separately:

- the fake MCP server received the original synthetic recipient;
- model-facing `response_item` records contained the safe replacement and never
  the original;
- Codex's local execution event retained the original recipient for the native
  audit trail;
- no real mail provider or external action was involved.

### Native Claude MCP success and failure verification

The installed Claude Code 2.1.206 binary was connected to a local mock Anthropic
Messages endpoint and a harmless local MCP `send_mail` tool. No external model or
mail provider was contacted. The task-provider response generated the MCP call
with `contact1@example.com`; Claude's wildcard `PreToolUse` hook restored a
synthetic original immediately before the MCP call.

The successful path verified that:

- the fake MCP received the original synthetic recipient;
- the first and second provider request bodies contained the safe recipient and
  never the original;
- `PostToolUse.updatedToolOutput` changed the MCP result back to the safe
  recipient before the second request;
- `PostToolBatch` ran after the sanitized result and allowed the turn to continue.

A second fake MCP returned a controlled error containing the restored original.
Claude's failed-tool path does not expose the same result-replacement mechanism,
so the `PostToolBatch` guard detected the known original and stopped the turn.
Only one provider request occurred; the failed result was never submitted in a
second model request.

The opt-in regression command is:

```bash
pnpm --filter @privacy-ai/agent-bridge test:e2e:claude
```

### Exact provider-boundary recorders

Both installed native TUIs were driven through local protocol recorders using
synthetic private email values. The recorder for the privacy model and the
recorder for the task provider were separate, so the boundary was directly
observable.

Claude Code 2.1.206 with the `haiku` model alias:

- the loopback privacy model received the original value;
- three Anthropic Messages requests contained the safe replacement and never
  the original;
- a Bash tool call containing the replacement was restored immediately before
  execution;
- the local output file contained the original value;
- the subsequent provider request contained the safe replacement again.

Codex 0.143.0 with `gpt-5.4-mini`:

- the loopback privacy model received the original value;
- two OpenAI Responses requests contained the safe replacement and never the
  original;
- the model-generated shell command was restored immediately before execution;
- the local output file contained the original value;
- the subsequent provider request contained the safe replacement again;
- Codex hook hashes were discovered through `hooks/list` and trusted only for
  that process, with no bypass warning and no user-config modification.

### Live subscription-backed TUI tests

The same wrapper was then tested against the machine's normal provider paths,
not the local task-provider recorders:

- **Codex:** the existing ChatGPT login, Codex 0.143.0, and
  `gpt-5.4-mini`. The native TUI displayed `contact1@example.com`, the local
  command wrote the original synthetic value, and the rollout transcript
  contained the safe value rather than the original.
- **Claude Code:** the machine's existing Claude configuration, Claude Code
  2.1.206, and the `haiku` alias. The native TUI displayed
  `contact1@example.com`, while Bash received and wrote the original synthetic
  value.

The normal local CLI history/transcript may contain the real prompt. This is
intentional for the current product boundary: the local machine and reversible
vault are trusted; the remote model/provider boundary is not. Provider-facing
conversation turns remain sanitized.

### Automated suite

At the time of implementation:

- SDK tests: 82 passed, 0 failed;
- bridge tests after adding AGY: 40 passed, 3 optional E2Es skipped, 0 failed;
- installed Claude MCP E2E: 1 passed, covering both successful and failed tool
  results;
- public CLI tests: 1 passed, 0 failed;
- Python PTY helper compiled successfully;
- Codex installed-binary hook discovery returned all three expected hooks and
  their current hashes;
- live AGY probes confirmed global lifecycle-hook discovery and real pre-tool
  payloads before `run_command` execution.

## Deliberate limitations

Phase one does not sanitize file contents, project instructions, skills, MCP
resource contents, or arbitrary local context before those values enter the
model conversation. Claude Code and Codex protect user prompts and every tool
lifecycle event their native CLIs expose through `PreToolUse` and `PostToolUse`.
AGY has no equivalent rewrite boundary, so private one-shot turns are deliberately
tool-isolated rather than given weaker protection.

Assistant prose remains placeholder-based. Restoring every placeholder by
blindly rewriting terminal output would risk exposing real values inside local
command logs and tool panels, so that feature needs a message-aware display
boundary rather than generic PTY text replacement.

The vault uses restrictive filesystem permissions but is not encrypted yet.
AGY sessions are serialized with a global hook-file lock; Claude/Codex hook and
vault concurrency still merit further production hardening.

Claude hook-event/debug streams and Codex local event records can retain
restored tool arguments so the native UI and local audit trail show what
actually executed. Provider-facing Anthropic Messages bodies and Codex
`response_item` records remain sanitized; the native fake-MCP verifications
explicitly check both sides of this boundary.

Windows needs a ConPTY implementation. The launcher fails explicitly on Windows
instead of silently using a non-interactive or unsafe fallback.
