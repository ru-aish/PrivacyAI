# Authenticated live release review

PrivacyAI uses a manually approved GitHub-hosted workflow to exercise the packed release through real Codex and Antigravity sessions before publication.

The workflow is intentionally separate from deterministic pull-request CI. It consumes external provider quota, depends on authenticated accounts, and may expose provider outages or rate limits. A passing live review is evidence for human release approval; it is not a replacement for Linux, macOS, Windows, packaging, migration, or deployment-assurance tests.

## Product boundary

The normal PrivacyAI product remains local-first and exposes only its existing local provider choices. The live workflow does not add a Mistral provider, adapter, onboarding choice, or Mistral-specific schema.

Inside the approved job only, the harness writes an isolated configuration using the existing `openai-compatible` provider and sets:

```text
PRIVACYAI_ALLOW_REMOTE_SANITIZER=1
```

The override and API key exist only under `RUNNER_TEMP` and are deleted in the final cleanup step.

## Manual workflow

The workflow is `.github/workflows/live-release-review.yml`. It accepts:

- an exact 40-character release SHA reachable from `origin/main`;
- exactly three merged pull-request numbers whose merge commits are ancestors of that SHA;
- the provider selection (`both`, `codex`, or `agy`);
- pinned Codex and Antigravity CLI versions.

The job references the protected GitHub Environment `privacyai-live-release`. Configure required reviewers before the first run.

## Required Environment secrets

### `MISTRAL_API_KEY`

A dedicated CI-only API key for the temporary OpenAI-compatible sanitizer endpoint.

### `CODEX_AUTH_JSON`

The complete JSON object normally stored in the dedicated CI account's Codex `auth.json`. Use a CI-only account or credential, not a general personal profile.

### `AGY_AUTH_JSON`

A JSON object whose keys are approved Antigravity credential/config file names and whose values are base64-encoded file contents. Supported keys are:

```json
{
  "antigravity-oauth-token": "<base64>",
  "installation_id": "<base64>",
  "jetski_state.pbtxt": "<base64>",
  "settings.json": "<base64>",
  "config.json": "<base64>"
}
```

`antigravity-oauth-token` is required. The harness rejects unknown file names, path components, and non-canonical base64.

## Required Environment variable

### `PRIVACYAI_CI_SANITIZER_MODEL`

The exact model identifier exposed by the configured OpenAI-compatible API `/models` endpoint.

## Optional Environment variables

- `PRIVACYAI_LIVE_CODEX_MODEL`: explicit Codex model override.
- `PRIVACYAI_LIVE_AGY_MODEL`: explicit Antigravity model display/name override.

When omitted, each authenticated CLI uses its configured default.

## Review instruction asset

Both agents receive `scripts/live-acceptance/assets/review-instructions.png`.

- Codex receives it through its native `--image` argument.
- Antigravity receives the same bytes from a fixed local MCP tool named `read_privacyai_review_instructions`.

The dynamic PR numbers and commit identities are not embedded in the image. The harness generates `LIVE_REVIEW_SCOPE.md` from GitHub and Git evidence for each run.

## Release candidate isolation

The workflow:

1. checks out the exact candidate SHA;
2. validates that it is reachable from protected `main`;
3. generates scope outside the repository;
4. builds and globally installs the packed SDK and CLI tarballs into a temporary prefix;
5. copies only `LIVE_REVIEW_SCOPE.md` into the review checkout;
6. launches the installed `privacyai` binary while the agents inspect the source checkout;
7. removes the scope file and requires a completely clean checkout;
8. checks for newly surviving Codex, Antigravity, PrivacyAI, gateway, and runtime-directory resources;
9. uploads only sanitized bounded evidence;
10. destroys the temporary home and credentials even after failure.

## Expected current behavior

The harness intentionally does not weaken or bypass PrivacyAI failures. If the current Codex request produces a privacy-verification `422`, the live workflow must fail and retain only sanitized evidence. Fixing that product issue is a separate change after the CI gate is established.

## Local contract tests

The non-authenticated harness behavior is deterministic and can run without provider credentials:

```bash
pnpm test:live-review-contracts
```

These tests cover exact scope validation, CI-home permissions, auth-file allowlisting, AGY image MCP delivery, provider orchestration with fixture binaries, result aggregation, cleanup, and public-safe summaries.
