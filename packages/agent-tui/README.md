# PrivacyAI native agent wrapper

This is the user-facing package for PrivacyAI's protected Claude Code and Codex
commands. It launches the user's existing CLI inside a transparent local PTY;
it does not replace the TUI, provider login, subscription, or inference route.

```bash
npm install --global @privacy-ai/agent-tui
privacyai onboard
privacyai claude
privacyai codex
```

During onboarding, PrivacyAI lists the downloaded Ollama language models that
support text completion. `ministral-3:3b` is shown first as the recommended
choice; select another downloaded model by number or type any Ollama model name
to download it.

The implementation lives in `@privacy-ai/agent-bridge`; this package owns only
the public `privacyai` command so there is one install surface and one tested
privacy engine.

Current platform support: Linux and macOS. Windows requires a ConPTY backend
and is intentionally rejected rather than falling back to an unsafe wrapper.
