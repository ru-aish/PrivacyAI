# PrivacyAI native Claude Code and Codex wrapper

Status: working prototype, tested on Claude Code 2.1.206 and Codex 0.143.0 on
Linux.

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
- Bash pre/post tool transformations;
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

## Bash path

For a model-generated command such as:

```bash
printf '%s' '[API_KEY_1]' > .env
```

`PreToolUse` loads the current CLI session's map and changes the command input
immediately before execution. Bash receives the real local value. The model's
stored tool call continues to contain the placeholder.

After execution, `PostToolUse` replaces all known originals before the result is
added to remote model context. A recognizable placeholder with no mapping is
denied rather than executed.

## Native experience preserved

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

## Onboarding

The recommended default is Ollama with `ministral-3:3b`:

1. Detect `ollama` on PATH.
2. Query Ollama for downloaded models and keep the models that support text completion.
3. Show `ministral-3:3b` first as the recommended choice, followed by every downloaded usable language model.
4. Let the user select a downloaded model by number, press Enter for the recommended model, or type another Ollama model name.
5. Skip the download when the selected model is already installed; otherwise run `ollama pull <model>` visibly.
6. Save `~/.config/privacyai/config.json` with mode `0600`.
7. Verify the selected model through the local Ollama API.
8. Print the launch commands and the GitHub project link.

The launcher refuses to start protected mode when onboarding or the local model
is missing.

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

- bridge tests: 15 passed, 0 failed;
- public CLI tests: 1 passed, 0 failed;
- Python PTY helper compiled successfully;
- Codex installed-binary hook discovery returned all three expected hooks and
  their current hashes.

## Deliberate limitations

Phase one does not sanitize files, project instructions, skills, MCP resource
contents, Edit/Write tools, or arbitrary local context. It protects prompts and
model-generated Bash lifecycle data only.

Assistant prose remains placeholder-based. Restoring every placeholder by
blindly rewriting terminal output would risk exposing real values inside local
command logs and tool panels, so that feature needs a message-aware display
boundary rather than generic PTY text replacement.

The vault uses restrictive filesystem permissions but is not encrypted yet.
Concurrent hook processes can still require a stronger locking strategy for
production use.

Windows needs a ConPTY implementation. The launcher fails explicitly on Windows
instead of silently using a non-interactive or unsafe fallback.
