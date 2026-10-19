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

- Codex gateway compatibility is validated against stock Codex 0.163.0, including
  direct MCP namespaces, the reserved `collaboration` namespace, and current
  model-driven custom tool definitions.
- Native Codex `/fork [name]` stays inside the protected 0.163.0 TUI and inherits
  the active PrivacyAI provider instead of being misread as a resume-style relaunch.
- Release packaging now requires one exact version across the SDK, private
  bridge runtime, and CLI, including exact internal workspace dependency
  specifiers.
- Published CLI tarballs omit development packaging scripts and expose only the
  matching public SDK dependency while retaining the private runtime as vendored
  files.
- Publication uses the exact artifacts validated and smoke-installed in CI
  rather than rebuilding immediately before publish.

### Fixed

- Protected Codex `/resume` relaunches preserve current TUI launch state including
  `--search`, `--approve-for-me`, and `--no-daemon`, and accept named sessions.
- Stock Codex integration coverage accepts 0.163.0's direct MCP namespaces while
  retaining compatibility with deferred `tool_search` exposure.
- Codex 0.163.0 collaboration tool names remain fixed protocol bindings even when
  identical strings in user text or custom namespaces require privacy masking.
- Startup verification and live-request verification now share the same
  identity-aware cache key, while legacy verified entries are migrated on use.
- AGY 1.4 transport accepts the audited trajectory-ACL metadata route and ignores
  canonical classifier false positives that collide only with immutable provider
  schema literals, while retaining fail-closed handling for real protected values.
- Release retries safely continue after a partial SDK-only publish by verifying
  registry integrity and skipping only an exact existing artifact.

## [0.0.2]

### Added

- Public `@privacy-ai/cli` package with the canonical `privacyai` command.
- Protected Claude Code, Codex, and AGY launchers, onboarding, diagnostics, and
  read-only cache and lineage inspection.
- Public `@privacy-ai/sdk` package and a private bridge runtime vendored into the
  CLI package during release packaging.

[Unreleased]: https://github.com/ru-aish/PrivacyAI/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/ru-aish/PrivacyAI/releases/tag/v0.0.2
