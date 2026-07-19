import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_ROOT = join(dirname(PACKAGE_ROOT), "sdk");

test("packed CLI contains the internal runtime and no public bridge dependency", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-cli-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceManifestBefore = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
  const sdkManifest = JSON.parse(await readFile(join(SDK_ROOT, "package.json"), "utf8"));
  const packed = await runProcess("npm", ["pack", "--pack-destination", root], {
    cwd: PACKAGE_ROOT
  });
  assert.equal(packed.code, 0, packed.stderr || packed.stdout);

  const tarball = (await readdir(root)).find(name => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack did not produce a tarball");

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
  assert.doesNotMatch(packedManifestText, /workspace:/);
  await access(join(packageRoot, "vendor", "agent-bridge", "src", "cli.js"));
  await access(join(packageRoot, "vendor", "agent-bridge", "bin", "privacyai-agent-hook.js"));
  await assert.rejects(
    access(join(packageRoot, "vendor", "agent-bridge", "package.json")),
    error => error?.code === "ENOENT"
  );

  const scopeRoot = join(packageRoot, "node_modules", "@privacy-ai");
  await mkdir(scopeRoot, { recursive: true });
  await symlink(SDK_ROOT, join(scopeRoot, "sdk"), "dir");

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
  assert.doesNotMatch(inspection.stderr, /ERR_MODULE_NOT_FOUND|missing its internal agent runtime/);
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
