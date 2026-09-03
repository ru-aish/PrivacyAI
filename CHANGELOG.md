# Changelog

All notable user-visible changes to PrivacyAI are documented in this file.
PrivacyAI coordinates the public `@privacy-ai/sdk` and `@privacy-ai/cli`
versions as one release. The private `@privacy-ai/agent-bridge` workspace
package uses the same version and is vendored into the CLI artifact.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Reproducible SDK and CLI release artifacts with exact file inventories,
  SHA-256 checksums, npm-compatible SHA-512 integrity values, and source commit
  metadata.
- Pull-request, tag, and intentional manual release validation through GitHub
  Actions, with trusted npm publishing and provenance restricted to the publish
  job.
- Installation, upgrade, rollback, interrupted-release recovery, and release
  operator documentation.

### Changed

- Release packaging now requires one exact version across the SDK, private
  bridge runtime, and CLI, including exact internal workspace dependency
  specifiers.
- Published CLI tarballs omit development packaging scripts and expose only the
  matching public SDK dependency while retaining the private runtime as vendored
  files.
- Publication uses the exact artifacts validated and smoke-installed in CI
  rather than rebuilding immediately before publish.
- Live release review now exercises Codex CLI 0.153.0.
- Codex 0.153 host-only `tool_result_sources` telemetry is accepted within bounded executed-tool metadata and stripped before provider forwarding, preventing false 422 privacy-boundary failures.

### Fixed

- Release retries safely continue after a partial SDK-only publish by verifying
  registry integrity and skipping only an exact existing artifact.
- Codex 0.152 startup requests now accept bounded creation-time and content-kind
  metadata while removing local attempted-tool telemetry before provider
  forwarding.
- Codex history accepts encrypted function arguments and named function outputs,
  and package-style MCP server names remain protected end to end.
- Codex 0.152 image requests preserve the `original` detail mode after local
  sanitization, while unsupported audio remains explicitly fail-closed.
- Linux executable discovery now resolves both nested and npm-hoisted Codex
  platform packages instead of falling back to an older installation on `PATH`.

## [0.0.2]

### Added

- Public `@privacy-ai/cli` package with the canonical `privacyai` command.
- Protected Claude Code, Codex, and AGY launchers, onboarding, diagnostics, and
  read-only cache and lineage inspection.
- Public `@privacy-ai/sdk` package and a private bridge runtime vendored into the
  CLI package during release packaging.

[Unreleased]: https://github.com/ru-aish/PrivacyAI/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/ru-aish/PrivacyAI/releases/tag/v0.0.2
