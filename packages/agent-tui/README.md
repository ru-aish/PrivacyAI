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

During onboarding, PrivacyAI scans Ollama and a running LM Studio local server,
then lists every usable downloaded LLM/VLM in one numbered menu. Embedding-only
models are excluded. Ministral 3 3B remains recommended; select any Ollama or LM
Studio entry by number, or type another Ollama model name to download it.

The implementation lives in `@privacy-ai/agent-bridge`; this package owns only
the public `privacyai` command so there is one install surface and one tested
privacy engine.

Current platform support: Linux and macOS. Windows requires a ConPTY backend
and is intentionally rejected rather than falling back to an unsafe wrapper.
