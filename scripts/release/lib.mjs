import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const REPOSITORY_URL = "https://github.com/ru-aish/PrivacyAI";
export const REPOSITORY_GIT_URL = "git+https://github.com/ru-aish/PrivacyAI.git";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const SDK_ROOT = join(REPOSITORY_ROOT, "packages", "sdk");
export const BRIDGE_ROOT = join(REPOSITORY_ROOT, "packages", "agent-bridge");
export const CLI_ROOT = join(REPOSITORY_ROOT, "packages", "agent-tui");

const TRANSIENT_CLI_PATHS = [
  join(CLI_ROOT, ".privacyai-package.json.pack-backup"),
  join(CLI_ROOT, ".privacyai-package-watch"),
  join(CLI_ROOT, "vendor")
];
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function loadReleaseState() {
  const [sdk, bridge, cli] = await Promise.all([
    readJson(join(SDK_ROOT, "package.json")),
    readJson(join(BRIDGE_ROOT, "package.json")),
    readJson(join(CLI_ROOT, "package.json"))
  ]);
  return { sdk, bridge, cli };
}

export function deriveDistTag(version) {
  assertSemver(version);
  return version.includes("-") ? "next" : "latest";
}

export function validateReleaseState(state, { tag = "" } = {}) {
  const { sdk, bridge, cli } = state;
  const expectedNames = {
    sdk: "@privacy-ai/sdk",
    bridge: "@privacy-ai/agent-bridge",
    cli: "@privacy-ai/cli"
  };
  for (const [key, expectedName] of Object.entries(expectedNames)) {
    if (state[key]?.name !== expectedName) {
      throw new Error(`Expected ${key} package name ${expectedName}.`);
    }
    assertSemver(state[key].version);
  }

  if (sdk.version !== bridge.version || sdk.version !== cli.version) {
    throw new Error(
      `Release version mismatch: SDK ${sdk.version}, bridge ${bridge.version}, CLI ${cli.version}.`
    );
  }

  const workspaceSpecifier = `workspace:${sdk.version}`;
  if (bridge.dependencies?.["@privacy-ai/sdk"] !== workspaceSpecifier) {
    throw new Error(`Bridge must depend on @privacy-ai/sdk using ${workspaceSpecifier}.`);
  }
  if (cli.dependencies?.["@privacy-ai/sdk"] !== workspaceSpecifier) {
    throw new Error(`CLI must depend on @privacy-ai/sdk using ${workspaceSpecifier}.`);
  }
  if (cli.dependencies?.["@privacy-ai/agent-bridge"] !== workspaceSpecifier) {
    throw new Error(`CLI must depend on @privacy-ai/agent-bridge using ${workspaceSpecifier}.`);
  }
  if (bridge.private !== true) {
    throw new Error("The vendored @privacy-ai/agent-bridge package must remain private.");
  }
  if (tag && tag !== `v${sdk.version}`) {
    throw new Error(`Release tag ${tag} must equal v${sdk.version}.`);
  }

  return {
    version: sdk.version,
    tag: tag || `v${sdk.version}`,
    npmDistTag: deriveDistTag(sdk.version)
  };
}

export async function buildArtifactSet(outputDirectory, options = {}) {
  const {
    tag = "",
    requireClean = false,
    installSmoke = true,
    publishDryRun = true
  } = options;
  const output = resolve(outputDirectory);
  await ensureEmptyDirectory(output);

  const sourceStatus = await gitStatus();
  if (requireClean && sourceStatus) {
    throw new Error(`Release builds require a clean checkout:\n${sourceStatus}`);
  }
  const cliManifestBefore = await readFile(join(CLI_ROOT, "package.json"), "utf8");
  const release = validateReleaseState(await loadReleaseState(), { tag });

  try {
    const sdkTarball = await packSdk(output, release.version);
    const cliTarball = await packCli(output, release.version);
    const packages = await inspectReleasePackages({ sdkTarball, cliTarball, release });
    const metadata = await createReleaseMetadata(release, packages);
    await writeReleaseMetadata(output, metadata);

    if (installSmoke) await runGlobalInstallSmoke(output, metadata);
    if (publishDryRun) await runPublishDryRuns(output, metadata);

    return metadata;
  } finally {
    await assertSourceRestored({ sourceStatus, cliManifestBefore });
  }
}

export async function compareArtifactDirectories(firstDirectory, secondDirectory) {
  const first = await readdir(firstDirectory);
  const second = await readdir(secondDirectory);
  const expectedFiles = ["SHA256SUMS", "release-metadata.json"];
  const tarballs = first.filter(name => name.endsWith(".tgz")).sort();
  const allFiles = [...tarballs, ...expectedFiles].sort();
  if (JSON.stringify(first.sort()) !== JSON.stringify(allFiles)) {
    throw new Error(`Unexpected files in first artifact directory: ${first.join(", ")}.`);
  }
  if (JSON.stringify(second.sort()) !== JSON.stringify(allFiles)) {
    throw new Error(`Unexpected files in second artifact directory: ${second.join(", ")}.`);
  }

  for (const filename of allFiles) {
    const [left, right] = await Promise.all([
      readFile(join(firstDirectory, filename)),
      readFile(join(secondDirectory, filename))
    ]);
    if (!left.equals(right)) {
      throw new Error(`Release artifact ${filename} is not reproducible.`);
    }
  }
}

export async function verifyArtifactDirectory(directory, { expectedTag = "" } = {}) {
  const root = resolve(directory);
  const metadata = await readJson(join(root, "release-metadata.json"));
  validateMetadataShape(metadata, { expectedTag });

  const checksumLines = [];
  for (const packageEntry of metadata.packages) {
    const artifactPath = join(root, packageEntry.filename);
    const digest = await hashFile(artifactPath);
    const artifactStat = await stat(artifactPath);
    if (digest.sha256 !== packageEntry.sha256) {
      throw new Error(`SHA-256 mismatch for ${packageEntry.filename}.`);
    }
    if (digest.integrity !== packageEntry.integrity) {
      throw new Error(`SHA-512 integrity mismatch for ${packageEntry.filename}.`);
    }
    if (artifactStat.size !== packageEntry.size) {
      throw new Error(`Size mismatch for ${packageEntry.filename}.`);
    }
    checksumLines.push(`${packageEntry.sha256}  ${packageEntry.filename}`);
  }

  const expectedChecksums = checksumLines.sort().join("\n") + "\n";
  const actualChecksums = await readFile(join(root, "SHA256SUMS"), "utf8");
  if (actualChecksums !== expectedChecksums) {
    throw new Error("SHA256SUMS does not match release metadata.");
  }

  return metadata;
}

export function validateMetadataShape(metadata, { expectedTag = "" } = {}) {
  if (metadata?.schemaVersion !== 1) throw new Error("Unsupported release metadata schema.");
  assertSemver(metadata.version);
  if (metadata.tag !== `v${metadata.version}`) {
    throw new Error("Release metadata tag does not match its version.");
  }
  if (expectedTag && metadata.tag !== expectedTag) {
    throw new Error(`Artifact tag ${metadata.tag} does not match ${expectedTag}.`);
  }
  if (metadata.npmDistTag !== deriveDistTag(metadata.version)) {
    throw new Error("Release metadata contains the wrong npm dist-tag.");
  }
  if (!/^[a-f0-9]{40}$/i.test(metadata.gitCommit || "")) {
    throw new Error("Release metadata does not contain a full Git commit SHA.");
  }
  if (!Array.isArray(metadata.packages) || metadata.packages.length !== 2) {
    throw new Error("Release metadata must describe exactly the SDK and CLI artifacts.");
  }
  if (
    JSON.stringify(metadata.publishOrder) !==
    JSON.stringify(["@privacy-ai/sdk", "@privacy-ai/cli"])
  ) {
    throw new Error("Release metadata contains an unexpected publish order.");
  }
  const names = metadata.packages.map(entry => entry.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["@privacy-ai/cli", "@privacy-ai/sdk"])) {
    throw new Error("Release metadata contains an unexpected package set.");
  }
  for (const entry of metadata.packages) {
    if (entry.version !== metadata.version) {
      throw new Error(`Artifact ${entry.name} has a mismatched version.`);
    }
    if (entry.filename !== npmTarballName(entry.name, entry.version)) {
      throw new Error(`Artifact ${entry.name} has an unexpected filename.`);
    }
    if (!/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
      throw new Error(`Artifact ${entry.name} has an invalid SHA-256 digest.`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || "")) {
      throw new Error(`Artifact ${entry.name} has an invalid SHA-512 integrity value.`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`Artifact ${entry.name} has an invalid size.`);
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(`Artifact ${entry.name} has no file inventory.`);
    }
  }
  return metadata;
}

export async function run(command, args, options = {}) {
  const { cwd = REPOSITORY_ROOT, env = process.env, allowFailure = false } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      const result = { code: Number.isInteger(code) ? code : 1, signal, stdout, stderr };
      if (result.code === 0 || allowFailure) {
        resolvePromise(result);
        return;
      }
      const details = (stderr || stdout).trim().slice(-6000);
      rejectPromise(new Error(`${command} ${args.join(" ")} failed (${result.code}).${details ? `\n${details}` : ""}`));
    });
  });
}

export async function hashFile(path) {
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  };
}

export async function gitHead() {
  return (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
}

export async function gitTagCommit(tag) {
  const result = await run(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    { allowFailure: true }
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`Release tag ${tag} does not exist in this checkout.`);
  }
  return result.stdout.trim();
}

async function packSdk(output, version) {
  const temporary = await mkdtemp(join(tmpdir(), "privacyai-sdk-stage-"));
  const stageRoot = join(temporary, "sdk");
  try {
    await mkdir(stageRoot, { recursive: true });
    const manifest = await readJson(join(SDK_ROOT, "package.json"));
    for (const entry of manifest.files || []) {
      await cp(join(SDK_ROOT, entry), join(stageRoot, entry), { recursive: true });
    }
    const packedManifest = addRepositoryMetadata(manifest, "packages/sdk");
    delete packedManifest.scripts;
    packedManifest.publishConfig = { ...packedManifest.publishConfig, access: "public" };
    await writeFile(join(stageRoot, "package.json"), JSON.stringify(packedManifest, null, 2) + "\n");
    await run("npm", ["pack", "--ignore-scripts", "--pack-destination", output], { cwd: stageRoot });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return join(output, npmTarballName("@privacy-ai/sdk", version));
}

async function packCli(output, version) {
  await run(
    "npm",
    ["run", "pack:production", "--", "--pack-destination", output],
    { cwd: CLI_ROOT }
  );
  return join(output, npmTarballName("@privacy-ai/cli", version));
}

async function inspectReleasePackages({ sdkTarball, cliTarball, release }) {
  await Promise.all([access(sdkTarball), access(cliTarball)]);
  const sdkSourceManifest = await readJson(join(SDK_ROOT, "package.json"));
  const expectedSdkFiles = await expectedManifestFiles(SDK_ROOT, sdkSourceManifest.files);
  const expectedCliFiles = await expectedCliFilesFromSources();
  const sdk = await inspectTarball(sdkTarball, {
    expectedName: "@privacy-ai/sdk",
    expectedVersion: release.version,
    expectedFiles: expectedSdkFiles,
    repositoryDirectory: "packages/sdk"
  });
  const cli = await inspectTarball(cliTarball, {
    expectedName: "@privacy-ai/cli",
    expectedVersion: release.version,
    expectedFiles: expectedCliFiles,
    repositoryDirectory: "packages/agent-tui",
    cli: true
  });
  return [sdk, cli];
}

async function inspectTarball(tarball, options) {
  const listed = await run("tar", ["-tzf", tarball]);
  const entries = listed.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.endsWith("/"))
    .sort();
  const expectedEntries = ["package/package.json", ...options.expectedFiles.map(file => `package/${file}`)].sort();
  assertSameList(entries, expectedEntries, `${options.expectedName} tarball contents`);

  const extracted = await mkdtemp(join(tmpdir(), "privacyai-release-inspect-"));
  try {
    await run("tar", ["-xzf", tarball, "-C", extracted]);
    const packageRoot = join(extracted, "package");
    const manifest = await readJson(join(packageRoot, "package.json"));
    validatePackedManifest(manifest, options);
    if (options.cli) {
      const binary = join(packageRoot, "bin", "privacyai.js");
      const binaryStat = await stat(binary);
      if ((binaryStat.mode & 0o111) === 0) {
        throw new Error("Packed privacyai binary is not executable.");
      }
    }
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }

  const digest = await hashFile(tarball);
  const artifactStat = await stat(tarball);
  return {
    name: options.expectedName,
    version: options.expectedVersion,
    filename: basename(tarball),
    size: artifactStat.size,
    sha256: digest.sha256,
    integrity: digest.integrity,
    files: entries
  };
}

function validatePackedManifest(manifest, options) {
  if (manifest.name !== options.expectedName || manifest.version !== options.expectedVersion) {
    throw new Error(`Packed ${options.expectedName} manifest has the wrong identity.`);
  }
  if (manifest.repository?.url !== REPOSITORY_GIT_URL) {
    throw new Error(`Packed ${options.expectedName} manifest has the wrong repository URL.`);
  }
  if (manifest.repository?.directory !== options.repositoryDirectory) {
    throw new Error(`Packed ${options.expectedName} manifest has the wrong repository directory.`);
  }
  if (manifest.scripts !== undefined) {
    throw new Error(`Packed ${options.expectedName} manifest must not expose development scripts.`);
  }
  if (JSON.stringify(manifest).includes("workspace:")) {
    throw new Error(`Packed ${options.expectedName} manifest contains a workspace dependency.`);
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`Packed ${options.expectedName} manifest must publish with public access.`);
  }
  if (options.cli) {
    if (manifest.dependencies?.["@privacy-ai/sdk"] !== options.expectedVersion) {
      throw new Error("Packed CLI does not depend on the matching SDK version.");
    }
    if (manifest.dependencies?.["@privacy-ai/agent-bridge"] !== undefined) {
      throw new Error("Packed CLI exposes the private bridge as a registry dependency.");
    }
    if (manifest.files?.includes("scripts")) {
      throw new Error("Packed CLI includes release-only packaging scripts.");
    }
  }
}

async function createReleaseMetadata(release, packages) {
  const [commit, commitTimestamp, npmVersion] = await Promise.all([
    gitHead(),
    run("git", ["show", "-s", "--format=%ct", "HEAD"]).then(result => result.stdout.trim()),
    run("npm", ["--version"]).then(result => result.stdout.trim())
  ]);
  return {
    schemaVersion: 1,
    version: release.version,
    tag: release.tag,
    npmDistTag: release.npmDistTag,
    gitCommit: commit,
    sourceDate: new Date(Number(commitTimestamp) * 1000).toISOString(),
    repository: REPOSITORY_URL,
    build: {
      node: process.version,
      npm: npmVersion
    },
    publishOrder: ["@privacy-ai/sdk", "@privacy-ai/cli"],
    packages
  };
}

async function writeReleaseMetadata(output, metadata) {
  const checksums = metadata.packages
    .map(entry => `${entry.sha256}  ${entry.filename}`)
    .sort()
    .join("\n") + "\n";
  await Promise.all([
    writeFile(join(output, "SHA256SUMS"), checksums),
    writeFile(join(output, "release-metadata.json"), JSON.stringify(metadata, null, 2) + "\n")
  ]);
}

async function runGlobalInstallSmoke(output, metadata) {
  const root = await mkdtemp(join(tmpdir(), "privacyai-release-install-"));
  try {
    const prefix = join(root, "prefix");
    const cache = join(root, "npm-cache");
    const tarballs = metadata.publishOrder.map(name => {
      const entry = metadata.packages.find(pkg => pkg.name === name);
      return join(output, entry.filename);
    });
    await run(
      "npm",
      ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", ...tarballs],
      {
        env: {
          ...process.env,
          npm_config_cache: cache,
          npm_config_registry: NPM_REGISTRY_URL
        }
      }
    );
    const globalModules = process.platform === "win32"
      ? join(prefix, "node_modules")
      : join(prefix, "lib", "node_modules");
    const installedSdk = await readJson(
      join(globalModules, "@privacy-ai", "sdk", "package.json")
    );
    const installedCli = await readJson(
      join(globalModules, "@privacy-ai", "cli", "package.json")
    );
    if (installedSdk.version !== metadata.version || installedCli.version !== metadata.version) {
      throw new Error("Isolated global install did not use the matching SDK and CLI artifacts.");
    }
    if (await pathExists(join(globalModules, "@privacy-ai", "agent-bridge"))) {
      throw new Error("Isolated global install exposed the private bridge as a package.");
    }
    const binary = process.platform === "win32"
      ? join(prefix, "privacyai.cmd")
      : join(prefix, "bin", "privacyai");
    const version = await run(binary, ["--version"], { cwd: root });
    if (version.stdout.trim() !== `privacyai ${metadata.version}`) {
      throw new Error(`Installed CLI reported unexpected version: ${version.stdout.trim()}.`);
    }
    const help = await run(binary, ["--help"], { cwd: root });
    if (!help.stdout.includes("privacyai agent <name> [...]")) {
      throw new Error("Installed CLI help did not expose the canonical agent command.");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runPublishDryRuns(output, metadata) {
  // npm 11 rejects a dry-run for an already-published version unless --force is
  // present. The real publish path never uses --force and remains immutable.
  for (const name of metadata.publishOrder) {
    const entry = metadata.packages.find(pkg => pkg.name === name);
    await run(
      "npm",
      [
        "publish",
        join(output, entry.filename),
        "--dry-run",
        "--force",
        "--access",
        "public",
        "--tag",
        metadata.npmDistTag,
        "--registry",
        NPM_REGISTRY_URL,
        "--provenance=false"
      ]
    );
  }
}

async function expectedManifestFiles(packageRoot, entries = []) {
  const files = [];
  for (const entry of entries) {
    files.push(...await collectFiles(packageRoot, entry));
  }
  return files.sort();
}

async function expectedCliFilesFromSources() {
  const files = [];
  for (const entry of ["README.md", "bin", "src"]) {
    files.push(...await collectFiles(CLI_ROOT, entry));
  }
  for (const entry of ["bin", "src"]) {
    const bridgeFiles = await collectFiles(BRIDGE_ROOT, entry);
    files.push(...bridgeFiles.map(file => `vendor/agent-bridge/${file}`));
  }
  return files.sort();
}

async function collectFiles(root, entry) {
  const absolute = join(root, entry);
  const info = await lstat(absolute);
  if (!info.isDirectory()) return [toPosix(relative(root, absolute))];

  const files = [];
  for (const child of await readdir(absolute)) {
    files.push(...await collectFiles(root, join(entry, child)));
  }
  return files;
}

function addRepositoryMetadata(manifest, directory) {
  return {
    ...manifest,
    repository: {
      type: "git",
      url: REPOSITORY_GIT_URL,
      directory
    },
    homepage: `${REPOSITORY_URL}#readme`,
    bugs: { url: `${REPOSITORY_URL}/issues` }
  };
}

function npmTarballName(name, version) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function assertSemver(version) {
  const match = typeof version === "string" ? SEMVER_PATTERN.exec(version) : null;
  const prerelease = match?.[4] || "";
  const hasLeadingZeroNumericIdentifier = prerelease
    .split(".")
    .some(identifier => /^0\d+$/.test(identifier));
  if (!match || hasLeadingZeroNumericIdentifier) {
    throw new Error(`Invalid release version: ${String(version)}.`);
  }
}

function assertSameList(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter(value => !actualSet.has(value));
  const extra = actual.filter(value => !expectedSet.has(value));
  throw new Error(
    `${label} differ.${missing.length ? `\nMissing: ${missing.join(", ")}` : ""}` +
    `${extra.length ? `\nUnexpected: ${extra.join(", ")}` : ""}`
  );
}

async function ensureEmptyDirectory(path) {
  await mkdir(path, { recursive: true });
  const entries = await readdir(path);
  if (entries.length !== 0) {
    throw new Error(`Release output directory must be empty: ${path}.`);
  }
}

async function gitStatus() {
  return (await run("git", ["status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
}

async function assertSourceRestored({ sourceStatus, cliManifestBefore }) {
  const problems = [];
  const cliManifestAfter = await readFile(join(CLI_ROOT, "package.json"), "utf8");
  if (cliManifestAfter !== cliManifestBefore) problems.push("CLI package.json was not restored");
  for (const path of TRANSIENT_CLI_PATHS) {
    if (await pathExists(path)) problems.push(`${relative(REPOSITORY_ROOT, path)} remains`);
  }
  const statusAfter = await gitStatus();
  if (statusAfter !== sourceStatus) problems.push("Git working-tree state changed during packaging");
  if (problems.length) throw new Error(`Release packaging did not restore the source tree: ${problems.join("; ")}.`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function toPosix(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}
