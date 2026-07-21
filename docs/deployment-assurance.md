# Deployment assurance gate

The deployment-assurance gate validates the produced `@privacy-ai/cli` and `@privacy-ai/sdk` tarballs as an installed system. It does not import the source checkout as a substitute for the release artifact.

Run it after installing the frozen workspace dependencies:

```bash
pnpm install --frozen-lockfile
pnpm test:deployment-assurance
```

The gate is deterministic and local-only. It creates temporary package, home, state, provider, and native-agent fixtures under a private temporary directory and removes them after the run. Set `PRIVACYAI_KEEP_ASSURANCE_TEMP=1` only while debugging a failed fixture locally.

## Assurance matrix

| Area | Success path | Failure or recovery path |
| --- | --- | --- |
| Production artifacts | Packs the SDK and the production-staged CLI, then verifies source package state is restored | Rejects leftover staging, backup, watcher, workspace dependency, credential-like, or required-runtime omissions |
| Platform and runtime | Accepts the declared Linux/macOS and Node.js `>=18.18` contract | Simulates and rejects Windows and Node.js 18.17 before execution |
| Package integrity | Pins SHA-256 digests and compares the installed CLI byte-for-byte with the validated tarball | Rejects an appended-byte tarball, an SDK downgrade against the CLI's exact dependency, and an installed runtime-source mutation |
| Clean install | Installs both tarballs with `npm` while resolving their full dependency graph from a temporary localhost registry built from the frozen pnpm tree | Uses an empty npm user configuration, excludes ambient credentials and proxies, ignores lifecycle scripts, and bounds install time and output |
| Onboarding | Runs the installed `privacyai onboard` binary behind a pseudo-terminal against a controlled local LM Studio-compatible fixture | Rejects a symlinked configuration parent without writing through it or leaving temporary files |
| Local state | Creates configuration and installation identity files with private permissions and regular-file ownership/link checks | Rejects symlinked, group/world-writable, multiply linked, replaced, or redirected configuration state |
| Doctor and provider | Runs installed `privacyai doctor --json` with model discovery and completion probing | Retries one transient HTTP 503, fails safely during provider unavailability, then succeeds after recovery |
| Native executable discovery | Reports the controlled AGY fixture healthy and treats missing optional agents as non-fatal | Fails dispatch for a missing AGY executable and reports a corrupt Codex executable without exposing its stderr fixture |
| Agent dispatch | Runs installed AGY strict mode and proves the downstream fixture receives a deterministic `PAI1` placeholder instead of the protected email | Preserves a native child failure code and removes hooks, locks, session maps, and runtime directories |
| Interruption and restart | Terminates a signal-resistant native child and descendant, verifies exit code 143, then dispatches successfully again | Fails if either process survives, runtime state remains, or the restarted dispatch cannot proceed |
| Privacy-safe output | Checks onboarding, doctor, executable failures, dispatch, and interruption output for protected fixture values | Fails on any protected prompt or controlled failure secret in public output |
| Final cleanup | Verifies expected persistent configuration/identity state and private file modes | Rejects unexpected symlinks, temporary files, hook locks, session maps, runtime directories, or persisted fixture secrets |

A normal Linux run currently completes the 13-stage installed-system lifecycle in approximately 13 seconds. GitHub Actions also runs a focused packed-artifact install → onboard → doctor → storage-hygiene lifecycle on macOS, plus the focused security/reliability regressions, production publish dry-run, canonical CLI package suite, and full workspace suite on Linux.

## CI behavior

`.github/workflows/deployment-assurance.yml` runs on:

- pull requests to `main` that touch deployment, CLI, bridge, SDK, package-manager, or workflow inputs;
- pushes to `main` or `feature/wave3-deployment-assurance` that touch the same deployment inputs;
- manual `workflow_dispatch` runs.

The Linux job uses Node.js 22 and pnpm 10.17.1, has a 35-minute timeout, and uploads the deployment-assurance log only when it fails. A focused macOS installed-storage job uses the same runtime and package manager with a 20-minute timeout. The workflow cancels superseded runs and has read-only repository permissions.

## Proven product blocker and fix

Before this gate, the packed CLI allowed onboarding/configuration writes through a symlinked parent directory. A release-artifact reproduction pointed the configuration path at `config-link/config.json`, where `config-link` targeted another directory; `savePrivacyConfig` succeeded and created the redirected file.

The configuration store now validates path components, ownership, permissions, symlinks, hard links, and directory identity. Linux writes are descriptor-relative; macOS holds and repeatedly validates the parent directory and opens the exclusive temporary file before writing private bytes. The focused regression file is `packages/agent-bridge/test/config-store-security.test.js`, and the installed onboarding gate repeats the attack against the packed CLI.

## Deliberate limitations

- Default CI uses no real credentials, private user prompts, or external providers. Live-provider checks remain explicit, separate opt-in work.
- The end-to-end native dispatch fixture exercises AGY strict mode. Claude, Codex gateway, and AGY transport semantics remain covered by their focused source-level suites; this gate checks their installed discovery/error boundary rather than contacting those services.
- Linux runs the complete installed release gate, including AGY dispatch failure/interruption/restart. macOS runs the focused packed-artifact storage lifecycle and configuration boundary tests; native AGY dispatch is not asserted there. Windows is intentionally rejected by the current CLI package contract.
- The localhost registry reproduces installation from the frozen workspace dependency tree. It validates package-manager extraction and dependency resolution without asserting public-registry availability or publishing authorization.
