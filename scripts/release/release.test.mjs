import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  combineReleaseErrors,
  deriveDistTag,
  hashFile,
  validateMetadataShape,
  validateReleaseState,
  verifyArtifactDirectory
} from "./lib.mjs";
import {
  isRetryableRegistryFailure,
  parseRegistryIntegrityResult
} from "./publish.mjs";

test("release validation accepts one coordinated stable or prerelease version", () => {
  const stable = releaseState("1.4.0");
  assert.deepEqual(validateReleaseState(stable, { tag: "v1.4.0" }), {
    version: "1.4.0",
    tag: "v1.4.0",
    npmDistTag: "latest"
  });

  const prerelease = releaseState("2.0.0-rc.1");
  assert.equal(validateReleaseState(prerelease).npmDistTag, "next");
  assert.equal(deriveDistTag("2.0.0-rc.1"), "next");
});

test("release validation rejects version and internal dependency skew", () => {
  const versionSkew = releaseState("1.4.0");
  versionSkew.bridge.version = "1.4.1";
  assert.throws(
    () => validateReleaseState(versionSkew),
    /Release version mismatch: SDK 1\.4\.0, bridge 1\.4\.1, CLI 1\.4\.0/
  );

  const dependencySkew = releaseState("1.4.0");
  dependencySkew.cli.dependencies["@privacy-ai/sdk"] = "workspace:*";
  assert.throws(
    () => validateReleaseState(dependencySkew),
    /CLI must depend on @privacy-ai\/sdk using workspace:1\.4\.0/
  );

  assert.throws(
    () => validateReleaseState(releaseState("1.4.0"), { tag: "v1.4.1" }),
    /Release tag v1\.4\.1 must equal v1\.4\.0/
  );
  assert.throws(
    () => validateReleaseState(releaseState("1.4.0-01")),
    /Invalid release version: 1\.4\.0-01/
  );
});

test("release errors preserve both operation and restoration failures", () => {
  const operationError = new Error("pack failed");
  const restorationError = new Error("manifest was not restored");
  const combined = combineReleaseErrors(operationError, restorationError);

  assert.ok(combined instanceof AggregateError);
  assert.deepEqual(combined.errors, [operationError, restorationError]);
  assert.match(combined.message, /Release operation failed: pack failed/);
  assert.match(combined.message, /Source restoration verification also failed/);
});

test("registry integrity parsing distinguishes missing, valid, and malformed responses", () => {
  assert.equal(
    parseRegistryIntegrityResult(
      { code: 0, stdout: "", stderr: "" },
      "@privacy-ai/sdk",
      "1.4.0"
    ),
    null
  );
  assert.equal(
    parseRegistryIntegrityResult(
      { code: 0, stdout: "null\n", stderr: "" },
      "@privacy-ai/sdk",
      "1.4.0"
    ),
    null
  );
  assert.equal(
    parseRegistryIntegrityResult(
      { code: 0, stdout: '"sha512-valid"\n', stderr: "" },
      "@privacy-ai/sdk",
      "1.4.0"
    ),
    "sha512-valid"
  );
  assert.equal(
    parseRegistryIntegrityResult(
      { code: 1, stdout: "", stderr: "npm error code E404" },
      "@privacy-ai/sdk",
      "1.4.0"
    ),
    null
  );
  assert.throws(
    () => parseRegistryIntegrityResult(
      { code: 0, stdout: '"sha1-invalid"', stderr: "" },
      "@privacy-ai/sdk",
      "1.4.0"
    ),
    /invalid integrity metadata/
  );
});

test("registry propagation retries only recognized transient failures", () => {
  assert.equal(isRetryableRegistryFailure(new Error("npm error code ETIMEDOUT")), true);
  assert.equal(isRetryableRegistryFailure(new Error("503 Service Unavailable")), true);
  assert.equal(
    isRetryableRegistryFailure(
      new Error("Registry returned invalid integrity metadata for @privacy-ai/sdk@1.500.0")
    ),
    false
  );
});

test("release metadata rejects unsafe filenames and publish order changes", () => {
  const metadata = metadataFixture();
  assert.doesNotThrow(() => validateMetadataShape(metadata));

  const reordered = structuredClone(metadata);
  reordered.publishOrder.reverse();
  assert.throws(
    () => validateMetadataShape(reordered),
    /unexpected publish order/
  );

  const unsafeFilename = structuredClone(metadata);
  unsafeFilename.packages[0].filename = "../privacy-ai-sdk-1.4.0.tgz";
  assert.throws(
    () => validateMetadataShape(unsafeFilename),
    /unexpected filename/
  );
});

test("artifact verification accepts exact bytes and rejects tampering", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-release-metadata-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sdkFile = "privacy-ai-sdk-1.4.0.tgz";
  const cliFile = "privacy-ai-cli-1.4.0.tgz";
  await writeFile(join(root, sdkFile), "sdk artifact\n");
  await writeFile(join(root, cliFile), "cli artifact\n");
  const [sdkDigest, cliDigest] = await Promise.all([
    hashFile(join(root, sdkFile)),
    hashFile(join(root, cliFile))
  ]);
  const metadata = {
    schemaVersion: 1,
    version: "1.4.0",
    tag: "v1.4.0",
    npmDistTag: "latest",
    gitCommit: "a".repeat(40),
    sourceDate: "2026-07-21T00:00:00.000Z",
    repository: "https://github.com/ru-aish/PrivacyAI",
    build: { node: "v24.0.0", npm: "11.5.1" },
    publishOrder: ["@privacy-ai/sdk", "@privacy-ai/cli"],
    packages: [
      packageEntry("@privacy-ai/sdk", sdkFile, 13, sdkDigest),
      packageEntry("@privacy-ai/cli", cliFile, 13, cliDigest)
    ]
  };
  await writeFile(
    join(root, "release-metadata.json"),
    JSON.stringify(metadata, null, 2) + "\n"
  );
  await writeFile(
    join(root, "SHA256SUMS"),
    [
      `${cliDigest.sha256}  ${cliFile}`,
      `${sdkDigest.sha256}  ${sdkFile}`
    ].sort().join("\n") + "\n"
  );

  assert.equal(
    (await verifyArtifactDirectory(root, { expectedTag: "v1.4.0" })).version,
    "1.4.0"
  );

  await writeFile(join(root, cliFile), "tampered artifact\n");
  await assert.rejects(
    verifyArtifactDirectory(root, { expectedTag: "v1.4.0" }),
    /SHA-256 mismatch/
  );
});

function releaseState(version) {
  const workspace = `workspace:${version}`;
  return {
    sdk: {
      name: "@privacy-ai/sdk",
      version
    },
    bridge: {
      name: "@privacy-ai/agent-bridge",
      version,
      private: true,
      dependencies: { "@privacy-ai/sdk": workspace }
    },
    cli: {
      name: "@privacy-ai/cli",
      version,
      dependencies: {
        "@privacy-ai/sdk": workspace,
        "@privacy-ai/agent-bridge": workspace
      }
    }
  };
}

function metadataFixture() {
  const digest = {
    sha256: "a".repeat(64),
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`
  };
  return {
    schemaVersion: 1,
    version: "1.4.0",
    tag: "v1.4.0",
    npmDistTag: "latest",
    gitCommit: "a".repeat(40),
    sourceDate: "2026-07-21T00:00:00.000Z",
    repository: "https://github.com/ru-aish/PrivacyAI",
    build: { node: "v24.0.0", npm: "11.5.1" },
    publishOrder: ["@privacy-ai/sdk", "@privacy-ai/cli"],
    packages: [
      packageEntry("@privacy-ai/sdk", "privacy-ai-sdk-1.4.0.tgz", 1, digest),
      packageEntry("@privacy-ai/cli", "privacy-ai-cli-1.4.0.tgz", 1, digest)
    ]
  };
}

function packageEntry(name, filename, size, digest) {
  return {
    name,
    version: "1.4.0",
    filename,
    size,
    sha256: digest.sha256,
    integrity: digest.integrity,
    files: ["package/package.json"]
  };
}
