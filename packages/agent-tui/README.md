# PrivacyAI CLI

`@privacy-ai/cli` publishes the single user-facing `privacyai` command. It owns
onboarding, diagnostics, protected agent launchers, cache inspection, and
lineage inspection. Users do not install separate PrivacyAI agent packages.

```bash
npm install --global @privacy-ai/cli
privacyai onboard
privacyai doctor
privacyai agent claude
privacyai agent codex
privacyai agent agy --print "Summarize this safely"
```

The direct launcher forms remain supported migration aliases:

```bash
privacyai claude
privacyai codex
privacyai agy
privacyai antigravity
```

Users migrating from `@privacy-ai/agent-tui` should uninstall that package and
install `@privacy-ai/cli`. The global binary remains `privacyai`.

## Command hierarchy

```text
privacyai onboard
privacyai doctor [--json]
privacyai agent <claude|codex|agy> [...]
privacyai cache [summary|list|show] [--limit N] [--json]
privacyai lineage [summary|list|show|mutations] [--limit N] [--json]
```

`setup` remains an alias for `onboard`, and `diagnostics` remains an alias for
`doctor`.

Exit codes are stable for scripts:

- `0`: success
- `1`: operational or health failure
- `2`: invalid command or arguments
- `3`: onboarding/configuration required
- `4`: requested cache or lineage record not found

Onboarding requires an interactive terminal and fails immediately instead of
waiting for input when stdin or stdout is not a TTY.

## Configuration discovery

PrivacyAI uses one configuration file. Discovery order is explicit:

1. An explicit path supplied by an embedding API.
2. `PRIVACYAI_CONFIG_FILE`.
3. `PRIVACYAI_CONFIG_DIR/config.json`.
4. `~/.config/privacyai/config.json`.

The first selected path is authoritative. An invalid or unreadable file fails
with a safe validation error; PrivacyAI does not silently fall through to a
lower-precedence configuration.

## Diagnostics

`privacyai doctor` checks the saved local-model configuration, model readiness,
platform details, and installed Claude Code, Codex, and AGY executables. Missing
agent executables are reported but do not prevent use of another supported
agent. A broken installed executable or unavailable configured model fails the
check.

## Cache and lineage inspection

Inspection commands open the existing context database in SQLite read-only,
query-only mode. They never create, migrate, prune, clear, or update local
state. Output contains only metadata such as opaque identifiers, hashes,
counts, statuses, and timestamps; session-map originals are never returned.

```bash
privacyai cache summary
privacyai cache list --limit 20 --json
privacyai cache show <cache-key>
privacyai lineage summary
privacyai lineage show <session-key> --json
privacyai lineage mutations --limit 20
```

## Protected agents

### Codex

`privacyai agent codex` keeps stock Codex and the user's normal `CODEX_HOME`,
including history, skills, plugins, user MCP servers, configuration, and login.
Supported Responses traffic passes through the nonce-protected localhost
PrivacyAI gateway. Resume and fork through the wrapper so they retain that
boundary. `--privacy-strict` remains the prompt-only fallback.

### Claude Code

Claude Code uses native prompt and tool lifecycle hooks plus startup-context
isolation. Supported tool inputs are restored locally and successful structured
results are classified before becoming model-visible. A failure path that
cannot be replaced safely stops before another model request.

### AGY / Antigravity

`privacyai agent agy` launches the installed AGY client through PrivacyAI's
protected transport. `privacyai antigravity` is retained as a compatibility
alias, and `--privacy-strict --print "..."` remains the prompt-only fallback.

## Package boundary

The internal `@privacy-ai/agent-bridge` workspace package is marked private.
During npm `prepack`, its runtime source and hook binaries are copied into the
CLI tarball and the published manifest is rewritten to depend only on the
public SDK. `postpack` restores the workspace manifest and removes staging
files. Publish the matching SDK release before the CLI release.

Current platform support is Linux and macOS. Windows remains blocked until an
equivalent tested boundary is available.
