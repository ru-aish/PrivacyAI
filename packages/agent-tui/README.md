# PrivacyAI native agent wrapper

This is the user-facing package for PrivacyAI's protected Claude Code, Codex,
and Antigravity commands. It launches the user's installed official CLI and
keeps the existing provider account and subscription.

```bash
npm install --global @privacy-ai/agent-tui
privacyai onboard
privacyai claude
privacyai codex
privacyai agy --print "Summarize this safely"
```

Onboarding selects a loopback-local Ollama or LM Studio model for privacy
classification. Embedding-only models are excluded.

## Codex

`privacyai codex` keeps stock Codex and the user's normal `CODEX_HOME`, including
history, skills, plugins, user MCP servers, configuration, and login. PrivacyAI
routes supported Responses traffic through a nonce-protected localhost gateway:

```text
stock Codex → local sanitize → OpenAI → local restore → stock Codex
```

Normal filesystem, shell, patch, Git, resume, fork, exec, and review workflows
remain available. The model still sees its normal Codex tool definitions, and no
extra OpenAI model request is added.

Provider-hosted search, apps/connectors, browser/computer use, images, realtime,
WebSockets, remote clients, and alternate provider overrides are blocked until
they have a protected transport boundary.

The previous prompt-only Codex mode remains available as an explicit fallback:

```bash
privacyai codex --privacy-strict
```

That mode uses a credential-only temporary home and denies tool-capable paths.

## Claude Code

Claude Code uses native prompt and tool lifecycle hooks plus startup-context
isolation. Supported tool inputs are restored locally and successful structured
results are classified before becoming model-visible. A failure path that cannot
be replaced safely stops before another model request.

## Antigravity

The installed AGY hook API cannot rewrite tool arguments or outputs. PrivacyAI
therefore supports fresh one-shot prompts only:

```bash
privacyai agy --print "your prompt"
```

The prompt is sanitized before launch and every scoped tool call is denied.
Interactive, resumed, reused, and permission-bypass modes fail closed.

The implementation lives in `@privacy-ai/agent-bridge`; this package owns only
the public `privacyai` command.

Current platform support: Linux and macOS. Windows remains intentionally blocked
until an equivalent tested boundary is available.
