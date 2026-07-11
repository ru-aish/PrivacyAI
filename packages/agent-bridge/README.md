# @privacy-ai/agent-bridge

PrivacyAI's tested local privacy engine for native agent CLIs.

The bridge does **not** proxy Claude or OpenAI inference. It generates temporary
native hooks and launches the user's existing Claude Code or Codex executable
inside a transparent local PTY. Provider authentication, subscription usage,
slash commands, permission dialogs, colors, keyboard handling, and the rest of
the TUI remain owned by the original CLI.

The public `privacyai` command is published by `@privacy-ai/agent-tui`; this
package contains the implementation and hook executables.

## Flow

```text
raw prompt typed in native TUI
        │
        ▼
UserPromptSubmit hook (local)
        │
        ├─ PrivacyAI SDK + local model sanitize prompt
        ├─ save reversible map in private per-session vault
        └─ block the original prompt before inference
        │
        ▼
transparent PTY reinjects sanitized prompt into the same composer
        │
        ▼
official Claude Code / Codex provider request
```

For every model-generated tool call exposed by the native hook system,
including built-in tools, app tools such as Gmail, and MCP tools:

```text
model emits tool arguments with placeholders
        │
        ▼
PreToolUse recursively restores mapped values immediately before execution
        │
        ▼
the selected tool runs with the real values
        │
        ▼
PostToolUse recursively replaces known real values before the result returns to the model
```

## User commands

```bash
npm install --global @privacy-ai/agent-tui
privacyai onboard
privacyai doctor
privacyai claude
privacyai codex
```

`privacyai onboard` scans both Ollama and a running LM Studio local server,
filters out embedding-only models, and presents every usable downloaded LLM/VLM
in one numbered menu. The recommended model remains Ministral 3 3B. If a usable
Ministral copy is already available in either provider, pressing Enter chooses
that copy; otherwise the Ollama `ministral-3:3b` model is offered for download.
Selecting an LM Studio entry saves the explicit `lm-studio` provider and its
local OpenAI-compatible base URL.

If the configuration or local model is missing, protected launch fails closed
and instructs the user to run `privacyai onboard`.

To run the real local-model privacy lifecycle tests:

```bash
# Ollama
ollama serve
pnpm --filter @privacy-ai/agent-bridge test:e2e:ministral

# LM Studio (start the Local Server first)
pnpm --filter @privacy-ai/agent-bridge test:e2e:lmstudio
```

Both local-model tests send a synthetic email through the actual sanitizer,
verify that the prompt is replaced before the model-facing boundary, restore
the original only immediately before tool execution, and sanitize the tool
result again. The regular suite also drives the real hook executable with Gmail-
and MCP-shaped events to verify all-tool argument restoration.

## Security properties

- The original user prompt is blocked before the task provider request.
- The sanitizer endpoint must be loopback-local by default.
- Session maps are stored under
  `~/.local/share/privacyai/agent-sessions/` in hashed `0600` files.
- Temporary wrapper files and directories use private permissions.
- Sanitized reinjection has a one-time allowance, preventing an infinite hook
  loop.
- Placeholder collisions are rebased across turns in the same session.
- Unresolved recognizable placeholders fail closed before any hooked tool executes.
- Claude `--settings` overrides and Codex hook-disabling/config overrides are
  rejected while protection is active.
- Codex hook hashes are discovered through the installed app-server and trusted
  only for the current process. User configuration is not modified.

## Current boundary

Protected now:

- ordinary user prompts;
- slash commands that include arguments;
- recursively nested arguments for every tool event exposed by Claude Code or
  Codex hooks, including built-in tools, app tools such as Gmail, and MCP tools;
- known sensitive values in every hooked tool result;
- per-session reversible mappings.

Not protected yet:

- new sensitive values introduced only by file contents or repository context
  before they exist in the session map;
- `AGENTS.md`, `CLAUDE.md`, skills, or system/project instructions;
- direct shell commands entered by the user outside the model tool lifecycle;
- brand-new sensitive values appearing only in tool output;
- automatic restoration of placeholders in assistant prose.

Exact slash commands without arguments, such as `/help` and `/model`, bypass
sanitization so native CLI commands remain immediate. A slash command with an
argument is sanitized like any other prompt.

## Platform and CLI limitations

- The transparent PTY backend currently supports Linux and macOS.
- Windows is rejected until a ConPTY backend is implemented.
- Claude can preserve structured sanitized tool output through
  `updatedToolOutput`.
- Codex 0.143.0 can replace model-visible post-tool feedback only as text; when
  sensitive output requires replacement, the current safe fallback can stop
  that turn.
- The original prompt and restored tool arguments may remain in the user's local
  CLI history/transcript and terminal display. This is deliberate: local state is
  usable in real form, while provider-facing turns stay sanitized.
- Session vault files are permission-protected but not yet encrypted at rest.

## Tests

```bash
node --test packages/agent-bridge/test/*.test.js
node --test packages/agent-tui/test/*.test.js
```

The integration suite also exercises both installed native TUIs against local
mock task providers and verifies that provider request bodies contain the
placeholder but not the original private value.
