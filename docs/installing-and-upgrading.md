# Installing and upgrading the PrivacyAI CLI

`@privacy-ai/cli` is the only global PrivacyAI package. It includes the private
agent runtime and installs the matching public `@privacy-ai/sdk` dependency.
Do not install `@privacy-ai/agent-bridge` separately.

## Requirements

- Linux or macOS.
- Node.js 18.18 or newer.
- npm configured to use the public npm registry.

Windows is not currently supported by the native agent boundary.

## Install

```bash
npm install --global @privacy-ai/cli@latest
privacyai --version
privacyai onboard
privacyai doctor
```

`privacyai onboard` requires an interactive terminal. Run it from a normal
terminal session rather than a non-interactive CI shell.

## Upgrade

```bash
npm install --global @privacy-ai/cli@latest
privacyai --version
privacyai doctor
```

The CLI and SDK are released at the same version. npm resolves the matching SDK
automatically from the CLI dependency; a separate SDK upgrade is not required
for global CLI users.

For a controlled rollout or rollback, install an exact published version:

```bash
npm install --global @privacy-ai/cli@0.0.2
```

Replace `0.0.2` with the version selected for the rollout.

## Migrate from the former package name

```bash
npm uninstall --global @privacy-ai/agent-tui
npm install --global @privacy-ai/cli@latest
```

The global command remains `privacyai`.

## Diagnose an installation

```bash
node --version
npm --version
npm prefix --global
npm list --global --depth=0 @privacy-ai/cli @privacy-ai/sdk
command -v privacyai
privacyai --version
privacyai doctor
```

On shells that support it, `type -a privacyai` shows every matching binary. If
an older binary appears before the npm global prefix, remove the stale install
or correct `PATH` before reinstalling.

## Recovery

### Global install permission errors

Prefer a Node version manager or a user-owned npm prefix instead of running npm
with `sudo`:

```bash
mkdir -p "$HOME/.local/npm"
npm config set prefix "$HOME/.local/npm"
export PATH="$HOME/.local/npm/bin:$PATH"
npm install --global @privacy-ai/cli@latest
```

Persist the `PATH` export in the shell profile used for future sessions.

### Interrupted or incomplete upgrade

Reinstall the selected version from a clean global package state:

```bash
npm uninstall --global @privacy-ai/cli @privacy-ai/agent-tui
npm cache verify
npm install --global @privacy-ai/cli@latest
privacyai --version
privacyai doctor
```

`npm cache verify` checks and repairs npm's content cache without deleting the
entire cache. Avoid `npm cache clean --force` unless npm itself reports that the
cache cannot be repaired.

### Native dependency installation failure

Confirm that the active Node version satisfies the requirement and that the
machine is using a supported operating system. Then remove the partial global
install and retry without `--ignore-scripts`:

```bash
npm uninstall --global @privacy-ai/cli
npm cache verify
npm install --global @privacy-ai/cli@latest
```

Keep the complete npm error log when reporting a failure; remove credentials,
access tokens, home-directory secrets, and prompt contents before sharing it.

### Upgrade introduced a regression

Install the last known-good version explicitly and include both versions in the
issue report:

```bash
npm install --global @privacy-ai/cli@<last-known-good-version>
privacyai --version
```

Published npm versions are immutable. A release version that already exists is
never overwritten by the release workflow.
