import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES_ROOT = dirname(PACKAGE_ROOT);
const SDK_ROOT = join(PACKAGES_ROOT, "sdk");
const BRIDGE_ROOT = join(PACKAGES_ROOT, "agent-bridge");

test("packed CLI is exact, reproducible, and contains its private runtime", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-cli-pack-"));
  const reproductionRoot = await mkdtemp(join(tmpdir(), "privacyai-cli-pack-reproduction-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(reproductionRoot, { recursive: true, force: true });
  });

  const sourceManifestBefore = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
  const sourceManifest = JSON.parse(sourceManifestBefore);
  const sdkManifest = JSON.parse(await readFile(join(SDK_ROOT, "package.json"), "utf8"));
  assert.equal(
    sourceManifest.dependencies["@privacy-ai/agent-bridge"],
    `workspace:${sdkManifest.version}`
  );
  assert.equal(
    sourceManifest.dependencies["@privacy-ai/sdk"],
    `workspace:${sdkManifest.version}`
  );

  const packed = await runProcess("npm", [
    "run",
    "pack:production",
    "--",
    "--pack-destination",
    root
  ], { cwd: PACKAGE_ROOT });
  assert.equal(packed.code, 0, packed.stderr || packed.stdout);

  const tarball = (await readdir(root)).find(name => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack did not produce a tarball");

  const reproduced = await runProcess("npm", [
    "run",
    "pack:production",
    "--",
    "--pack-destination",
    reproductionRoot
  ], { cwd: PACKAGE_ROOT });
  assert.equal(reproduced.code, 0, reproduced.stderr || reproduced.stdout);
  const reproducedTarball = (await readdir(reproductionRoot)).find(name => name.endsWith(".tgz"));
  assert.ok(reproducedTarball, "the reproduction pack did not produce a tarball");
  assert.equal(
    sha256(await readFile(join(root, tarball))),
    sha256(await readFile(join(reproductionRoot, reproducedTarball)))
  );

  const listed = await runProcess("tar", ["-tzf", join(root, tarball)]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(
    listed.stdout.split("\n").filter(Boolean).sort(),
    await expectedPackedFiles()
  );

  const unpacked = join(root, "unpacked");
  await mkdir(unpacked, { recursive: true });
  const extracted = await runProcess(
    "tar",
    ["-xzf", join(root, tarball), "-C", unpacked]
  );
  assert.equal(extracted.code, 0, extracted.stderr);

  const packageRoot = join(unpacked, "package");
  const packedManifestText = await readFile(join(packageRoot, "package.json"), "utf8");
  const packedManifest = JSON.parse(packedManifestText);
  assert.equal(packedManifest.name, "@privacy-ai/cli");
  assert.equal(packedManifest.dependencies["@privacy-ai/sdk"], sdkManifest.version);
  assert.equal(packedManifest.dependencies["@privacy-ai/agent-bridge"], undefined);
  assert.equal(packedManifest.scripts, undefined);
  assert.equal(packedManifest.files.includes("scripts"), false);
  assert.equal(
    packedManifest.repository?.url,
    "git+https://github.com/ru-aish/PrivacyAI.git"
  );
  assert.equal(packedManifest.repository?.directory, "packages/agent-tui");
  assert.doesNotMatch(packedManifestText, /workspace:/);
  await assert.rejects(
    access(join(packageRoot, "scripts", "package-runtime.js")),
    error => error?.code === "ENOENT"
  );
  await access(join(packageRoot, "vendor", "agent-bridge", "src", "cli.js"));
  await access(join(packageRoot, "vendor", "agent-bridge", "bin", "privacyai-agent-hook.js"));
  await assert.rejects(
    access(join(packageRoot, "vendor", "agent-bridge", "package.json")),
    error => error?.code === "ENOENT"
  );

  const scopeRoot = join(packageRoot, "node_modules", "@privacy-ai");
  await mkdir(scopeRoot, { recursive: true });
  await symlink(SDK_ROOT, join(scopeRoot, "sdk"), "dir");

  // A published CLI and its runtime are one release unit. Neither an npm
  // sibling nor a source-tree sibling may replace the bundled bridge.
  const packageSibling = join(scopeRoot, "agent-bridge");
  await mkdir(join(packageSibling, "src"), { recursive: true });
  await writeFile(
    join(packageSibling, "package.json"),
    JSON.stringify({
      name: "@privacy-ai/agent-bridge",
      version: "999.0.0",
      type: "module",
      exports: { ".": "./src/index.js", "./cli": "./src/cli.js" }
    })
  );
  for (const filename of ["index.js", "cli.js"]) {
    await writeFile(
      join(packageSibling, "src", filename),
      'throw new Error("MALICIOUS_SIBLING_BRIDGE_LOADED");\n'
    );
  }
  const developmentSibling = join(unpacked, "agent-bridge", "src");
  await mkdir(developmentSibling, { recursive: true });
  for (const filename of ["index.js", "cli.js"]) {
    await writeFile(
      join(developmentSibling, filename),
      'throw new Error("MALICIOUS_SIBLING_BRIDGE_LOADED");\n'
    );
  }

  const binary = join(packageRoot, "bin", "privacyai.js");
  const version = await runProcess("node", [binary, "--version"]);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), `privacyai ${packedManifest.version}`);

  const database = join(root, "missing.sqlite3");
  const inspection = await runProcess("node", [binary, "cache", "--json"], {
    env: { ...process.env, PRIVACYAI_CONTEXT_DB: database }
  });
  assert.equal(inspection.code, 1);
  assert.equal(inspection.stdout, "");
  assert.match(inspection.stderr, /not initialized; nothing to inspect/);
  assert.doesNotMatch(
    inspection.stderr,
    /MALICIOUS_SIBLING_BRIDGE_LOADED|ERR_MODULE_NOT_FOUND|missing its internal agent runtime/
  );
  await assert.rejects(access(database), error => error?.code === "ENOENT");

  assert.equal(
    await readFile(join(PACKAGE_ROOT, "package.json"), "utf8"),
    sourceManifestBefore
  );
  await assert.rejects(
    access(join(PACKAGE_ROOT, "vendor")),
    error => error?.code === "ENOENT"
  );
  await assert.rejects(
    access(join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup")),
    error => error?.code === "ENOENT"
  );
});

test("direct npm pack is rejected before mutating package state", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-cli-direct-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(PACKAGE_ROOT, "package.json");
  const sourceManifest = await readFile(manifestPath, "utf8");

  const packed = await runProcess("npm", ["pack", "--pack-destination", root], {
    cwd: PACKAGE_ROOT
  });

  assert.notEqual(packed.code, 0);
  assert.match(packed.stderr + packed.stdout, /pack:production/);
  assert.equal(await readFile(manifestPath, "utf8"), sourceManifest);
  await assert.rejects(access(join(PACKAGE_ROOT, "vendor")), error => error?.code === "ENOENT");
  await assert.rejects(
    access(join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup")),
    error => error?.code === "ENOENT"
  );
});

test("interrupted npm publish restores staged package state", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-cli-publish-interrupt-"));
  const manifestPath = join(PACKAGE_ROOT, "package.json");
  const backupPath = join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup");
  const watchPath = join(PACKAGE_ROOT, ".privacyai-package-watch");
  const vendorRoot = join(PACKAGE_ROOT, "vendor");
  const sourceManifest = await readFile(manifestPath, "utf8");
  const interruptedManifest = JSON.parse(sourceManifest);
  interruptedManifest.scripts.prepare = 'node -e "setTimeout(() => {}, 30000)"';
  const interruptedManifestText = JSON.stringify(interruptedManifest, null, 2) + "\n";
  t.after(async () => {
    await writeFile(manifestPath, sourceManifest, { mode: 0o644 });
    await rm(backupPath, { force: true });
    await rm(watchPath, { force: true });
    await rm(vendorRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(manifestPath, interruptedManifestText, { mode: 0o644 });

  const published = spawn("npm", ["publish", "--dry-run", "--access", "public"], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
    detached: true,
    stdio: "ignore"
  });
  await waitForSpawn(published);
  await waitForStagedPackage(backupPath, watchPath, vendorRoot);

  const publishExit = waitForExit(published);
  process.kill(-published.pid, "SIGTERM");
  await publishExit;
  await waitForPackageCleanup(
    manifestPath,
    interruptedManifestText,
    vendorRoot,
    backupPath,
    watchPath
  );
});

test("normal npm publish dry-run is supported and restores package state", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-cli-publish-dry-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(PACKAGE_ROOT, "package.json");
  const backupPath = join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup");
  const watchPath = join(PACKAGE_ROOT, ".privacyai-package-watch");
  const vendorRoot = join(PACKAGE_ROOT, "vendor");
  const sourceManifest = await readFile(manifestPath, "utf8");

  const published = await runProcess("npm", [
    "publish",
    "--dry-run",
    "--force",
    "--access",
    "public"
  ], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, npm_config_cache: join(root, "npm-cache") }
  });

  assert.equal(published.code, 0, published.stderr || published.stdout);
  assert.match(published.stderr + published.stdout, /dry-run|dry run/i);
  await waitForPackageCleanup(
    manifestPath,
    sourceManifest,
    vendorRoot,
    backupPath,
    watchPath
  );
});

test("production packaging rejects version skew before staging files", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-cli-version-skew-"));
  const manifestPath = join(PACKAGE_ROOT, "package.json");
  const sourceManifest = await readFile(manifestPath, "utf8");
  const skewedManifest = JSON.parse(sourceManifest);
  skewedManifest.dependencies["@privacy-ai/sdk"] = "workspace:9.9.9";
  const skewedManifestText = JSON.stringify(skewedManifest, null, 2) + "\n";
  t.after(async () => {
    await writeFile(manifestPath, sourceManifest, { mode: 0o644 });
    await rm(join(PACKAGE_ROOT, "vendor"), { recursive: true, force: true });
    await rm(join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup"), { force: true });
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(manifestPath, skewedManifestText, { mode: 0o644 });

  const packed = await runProcess("npm", [
    "run",
    "pack:production",
    "--",
    "--pack-destination",
    root
  ], { cwd: PACKAGE_ROOT });

  assert.notEqual(packed.code, 0);
  assert.ok(
    (packed.stderr + packed.stdout).includes(
      `internal dependencies must use workspace:${skewedManifest.version}`
    )
  );
  assert.equal(await readFile(manifestPath, "utf8"), skewedManifestText);
  await assert.rejects(access(join(PACKAGE_ROOT, "vendor")), error => error?.code === "ENOENT");
  await assert.rejects(
    access(join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup")),
    error => error?.code === "ENOENT"
  );
});

test("production pack wrapper restores the source tree when npm cannot create a tarball", async t => {
  const manifestPath = join(PACKAGE_ROOT, "package.json");
  const sourceManifest = await readFile(manifestPath, "utf8");
  const sourceHash = sha256(sourceManifest);
  t.after(async () => {
    await rm(join(PACKAGE_ROOT, "vendor"), { recursive: true, force: true });
    await rm(join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup"), { force: true });
  });

  const packed = await runProcess("npm", [
    "run",
    "pack:production",
    "--",
    "--pack-destination",
    "/proc/privacyai-pack-failure"
  ], { cwd: PACKAGE_ROOT });
  assert.notEqual(packed.code, 0, "the inaccessible pack destination must fail");
  assert.equal(sha256(await readFile(manifestPath, "utf8")), sourceHash);
  await assert.rejects(access(join(PACKAGE_ROOT, "vendor")), error => error?.code === "ENOENT");
  await assert.rejects(
    access(join(PACKAGE_ROOT, ".privacyai-package.json.pack-backup")),
    error => error?.code === "ENOENT"
  );
});

async function expectedPackedFiles() {
  const files = ["package/package.json"];
  for (const entry of ["README.md", "bin", "src"]) {
    files.push(...await collectSourceFiles(PACKAGE_ROOT, entry, "package/"));
  }
  for (const entry of ["bin", "src"]) {
    files.push(...await collectSourceFiles(
      BRIDGE_ROOT,
      entry,
      "package/vendor/agent-bridge/"
    ));
  }
  return files.sort();
}

async function collectSourceFiles(root, entry, targetPrefix) {
  const path = join(root, entry);
  const info = await lstat(path);
  if (!info.isDirectory()) {
    return [`${targetPrefix}${entry.replaceAll("\\", "/")}`];
  }

  const files = [];
  for (const child of await readdir(path)) {
    files.push(...await collectSourceFiles(root, join(entry, child), targetPrefix));
  }
  return files;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

function waitForExit(child) {
  return new Promise(resolve => child.once("exit", resolve));
}

async function waitForStagedPackage(backupPath, watchPath, vendorRoot) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await pathExists(backupPath) &&
      await pathExists(watchPath) &&
      await pathExists(vendorRoot)
    ) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("npm publish did not reach the staged package state");
}

async function waitForPackageCleanup(
  manifestPath,
  sourceManifest,
  vendorRoot,
  backupPath,
  watchPath
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await readFile(manifestPath, "utf8") === sourceManifest &&
      !await pathExists(vendorRoot) &&
      !await pathExists(backupPath) &&
      !await pathExists(watchPath)
    ) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail("cleanup watcher did not restore package state");
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

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => resolve({ code, stdout, stderr }));
  });
}
