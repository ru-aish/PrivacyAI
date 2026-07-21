# Releasing PrivacyAI packages

PrivacyAI publishes two public npm packages as one coordinated release:

1. `@privacy-ai/sdk`
2. `@privacy-ai/cli`

The private `@privacy-ai/agent-bridge` package is never published. Its `src` and
`bin` files are vendored into the CLI tarball during packaging. The SDK, bridge,
and CLI manifests must use the same version, and internal workspace dependency
specifiers must use that exact version.

## Release invariants

A release is rejected unless all of the following are true:

- SDK, bridge, and CLI versions are identical valid semantic versions.
- Bridge and CLI workspace dependencies use `workspace:<release-version>`.
- The packed CLI depends only on the matching public SDK version.
- The packed CLI contains the exact allowed CLI and vendored bridge files.
- Development lifecycle scripts are absent from published tarballs.
- Two independent builds produce byte-identical tarballs and metadata.
- Both tarballs install together in an isolated global npm prefix.
- `privacyai --version` and `privacyai --help` run from that isolated install.
- `npm publish --dry-run` succeeds for both exact tarballs.
- Packaging restores the checkout, including failure and interruption paths.

Stable versions publish under npm's `latest` dist-tag. Semantic prereleases such
as `1.0.0-rc.1` publish under `next`.

## Prepare a release

1. Update all three package versions together:

   - `packages/sdk/package.json`
   - `packages/agent-bridge/package.json`
   - `packages/agent-tui/package.json`

2. Update these exact internal dependencies to the same version:

   - bridge → SDK
   - CLI → SDK
   - CLI → bridge

3. Update `CHANGELOG.md` and prepare release notes using
   `docs/release-notes-template.md`.

4. Refresh `pnpm-lock.yaml` after the exact workspace dependency versions
   change:

```bash
npx --yes pnpm@10.17.1 install --lockfile-only
```

5. Install with the repository-pinned pnpm version and run validation:

```bash
npx --yes pnpm@10.17.1 install --frozen-lockfile
node --test scripts/release/release.test.mjs
npx --yes pnpm@10.17.1 --recursive test
node scripts/release/build.mjs --check
```

For an inspectable local artifact directory:

```bash
rm -rf /tmp/privacyai-release
mkdir -p /tmp/privacyai-release
node scripts/release/build.mjs \
  --output /tmp/privacyai-release \
  --tag v0.0.2
```

Replace `v0.0.2` with the intended release tag. The output contains:

- SDK and CLI `.tgz` files.
- `SHA256SUMS`.
- `release-metadata.json` with the source commit, package inventory, size,
  SHA-256, and npm-compatible SHA-512 integrity for each artifact.

Never edit or rebuild an artifact after validation. Publication consumes the
uploaded artifacts from the validation job rather than packing the repository a
second time.

## Open and merge the release preparation PR

Release preparation follows the normal pull-request process. The release
workflow validates pull requests without npm credentials and uploads validated
artifacts for inspection. Do not publish from an unmerged feature branch.

After the release preparation PR is merged, create an annotated tag on the
exact merge commit and push it:

```bash
git switch main
git pull --ff-only origin main
git tag -a v0.0.2 -m "PrivacyAI v0.0.2"
git push origin v0.0.2
```

A matching `v*.*.*` tag starts the release workflow. The validation job runs all
workspace tests, reconstructs the exact package inventories twice, compares the
artifacts byte-for-byte, installs them in isolation, and executes publish
dry-runs. Only then does the publish job receive `id-token: write` and publish
the uploaded SDK and CLI tarballs in that order. After npm publication succeeds,
the same tarballs, `SHA256SUMS`, and `release-metadata.json` are attached to a
GitHub release for the tag.

## Trusted publishing setup

The npm package owner must configure GitHub Actions trusted publishing for both
public packages. Configure the exact repository and workflow filename
`.github/workflows/release.yml` in npm package settings. No long-lived npm token
is stored in GitHub.

The publish job uses a GitHub-hosted runner, Node.js 24, npm 11.5.1, and OIDC
provenance. Pull-request validation and non-publishing manual runs receive only
read permissions and never request an npm credential.

## Manual release recovery

A manual workflow dispatch can rerun validation without publishing. To publish,
select **Run workflow**, provide an existing release tag such as `v0.0.2`, and
explicitly enable **publish**. The tag must point to the checked-out commit and
must match all package versions.

Publication is retry-safe:

- Before publishing each package, the workflow checks the registry's
  `dist.integrity` value.
- A missing version is published from the validated tarball.
- An existing version with exactly matching integrity is skipped.
- An existing version with different bytes stops the release immediately.

This permits recovery when the SDK publish succeeded but the CLI publish was
interrupted. It does not overwrite immutable npm versions or silently continue
through a conflicting partial release.

## Failure handling

### Validation failed before publication

No package was published. Fix the release preparation branch, update the PR,
and rerun validation. Inspect the uploaded logs and the source-tree restoration
check.

### SDK published but CLI failed

Do not bump or repack the same version. Rerun the tagged workflow or dispatch it
manually with the same tag and **publish** enabled. The matching SDK artifact is
verified and skipped, then the exact CLI artifact is retried.

### Registry contains different bytes at the requested version

Stop. Published npm versions are immutable. Investigate the registry version,
release tag, and artifact metadata. Prepare a new patch version after resolving
the cause; never force or replace the existing version.

### Trusted publishing is not configured

The publish job fails without releasing a package. Configure both npm packages
to trust this repository and the exact release workflow, then rerun the same tag.
Do not add a broad, long-lived `NPM_TOKEN` as a workaround.

### Tag points to the wrong commit

Delete the remote tag only when it has not produced a public release and the
team has agreed that correcting it is safe. Otherwise create a new version.
The release script refuses to publish artifacts whose recorded commit differs
from the tag or checked-out commit.

## Post-release checks

After both packages are visible in the registry:

```bash
npm view @privacy-ai/sdk@0.0.2 version dist.integrity
npm view @privacy-ai/cli@0.0.2 version dependencies dist.integrity
npm install --global @privacy-ai/cli@0.0.2
privacyai --version
privacyai doctor
```

Confirm that the CLI registry manifest depends on the matching SDK and does not
reference `@privacy-ai/agent-bridge`. Publish the completed release notes from
the changelog and attach `SHA256SUMS` plus `release-metadata.json` to the GitHub
release when desired.
