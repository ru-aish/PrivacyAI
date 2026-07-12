# PrivacyAI native agent wrapper

This is the user-facing package for PrivacyAI's protected Claude Code, Codex,
and Antigravity CLI commands. It launches the user's installed official CLI and
keeps the existing provider login, subscription, and inference route.

```bash
npm install --global @privacy-ai/agent-tui
privacyai onboard
privacyai claude
privacyai codex
privacyai agy --print "Summarize this safely"
```

During onboarding, PrivacyAI scans Ollama and a running LM Studio local server,
then lists every usable downloaded LLM/VLM in one numbered menu. Embedding-only
models are excluded. Ministral 3 3B remains recommended; select any Ollama or LM
Studio entry by number, or type another Ollama model name to download it.

## Claude Code and Codex

The wrapper opens the unchanged native TUI inside a transparent local PTY. It
registers wildcard pre/post hooks for every tool event exposed by the native
CLI. Placeholder values are restored recursively before built-in, app, plugin,
and MCP tools execute, then known real values are sanitized in tool results
before they return to the task model. Claude hook-disabling launch modes such as
`--bare` and `--safe-mode` are rejected; a failed Claude tool result that cannot
be rewritten safely is stopped before the next model request.

## Antigravity CLI compatibility

The installed AGY hook API does not currently expose a `UserPromptSubmit` hook,
tool-input rewriting, or tool-output rewriting. PrivacyAI therefore supports
fresh one-shot AGY prompts only:

```bash
privacyai agy --print "your prompt"
```

PrivacyAI sanitizes the prompt before AGY starts and temporarily installs a
wildcard global `PreToolUse` guard. When sanitization creates any private
mapping, every tool call in that turn is denied because AGY cannot sanitize the
result. When no private mapping exists, clean tool calls may proceed. Resume,
interactive-prompt, conversation-reuse, and permission-bypass modes fail closed.
The global hook file is locked, merged, and restored after the process exits, so
protected AGY sessions are intentionally serialized.

The implementation lives in `@privacy-ai/agent-bridge`; this package owns only
the public `privacyai` command so there is one install surface and one tested
privacy engine.

Current platform support: Linux and macOS. Windows requires a ConPTY backend
and is intentionally rejected rather than falling back to an unsafe wrapper.
