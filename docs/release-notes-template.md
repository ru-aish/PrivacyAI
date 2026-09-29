# PrivacyAI vX.Y.Z

Release date: YYYY-MM-DD

## Summary

Describe the user-visible purpose of the release in two or three sentences.
State whether the release is stable or a prerelease.

## Highlights

- User-visible capability or behavior change.
- Reliability, privacy, or compatibility improvement.
- Important packaging, installation, or operational improvement.

## Install or upgrade

```bash
npm install --global @privacy-ai/cli@X.Y.Z
privacyai --version
privacyai doctor
```

Link to `docs/installing-and-upgrading.md` for migration and recovery guidance.

## Package versions

| Package | Version | Distribution |
| --- | --- | --- |
| `@privacy-ai/sdk` | `X.Y.Z` | Public npm package |
| `@privacy-ai/cli` | `X.Y.Z` | Public npm package with vendored private bridge runtime |
| `@privacy-ai/agent-bridge` | `X.Y.Z` | Private workspace package; not published separately |

## Changes

### Added

- None, or list additions.

### Changed

- None, or list behavior changes.

### Fixed

- None, or list defects fixed.

### Security and privacy

- Explain any changed privacy boundary, failure behavior, or security-relevant
  operational change. Write “No privacy-boundary changes” when applicable.

## Compatibility and limitations

- Supported operating systems.
- Minimum Node.js version.
- Provider, agent, or migration limitations.
- Known issues that remain unresolved.

## Verification

Record the exact evidence from the release workflow:

- Source commit: `<40-character SHA>`
- Release tag: `vX.Y.Z`
- Workspace tests: `<result>`
- SDK artifact SHA-256: `<digest>`
- CLI artifact SHA-256: `<digest>`
- Reproducible artifact comparison: `<result>`
- Isolated global install smoke: `<result>`
- npm publish dry-runs: `<result>`
- npm trusted-publishing provenance: `<result or pending>`

The authoritative digests and full package inventories are stored in
`SHA256SUMS` and `release-metadata.json` from the release workflow.

## Recovery notes

Describe any version-specific rollback or repair steps. For ordinary rollback:

```bash
npm install --global @privacy-ai/cli@<last-known-good-version>
```

Do not suggest overwriting an existing npm version.

## Contributors

List contributors and relevant pull requests.
