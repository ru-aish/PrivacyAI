import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPrivacyConfig, savePrivacyConfig } from "../src/config-store.js";

const FIXED_CONFIG = Object.freeze({
  provider: "ollama",
  model: "assurance-model",
  baseURL: "http://127.0.0.1:11434",
  apiKey: "fixture-not-a-real-credential",
  onboardedAt: "2026-07-21T00:00:00.000Z"
});

test("configuration storage creates private state and preserves safe caller directories", {
  skip: process.platform === "win32"
}, async t => {
  const root = await temporaryRoot(t, "privacyai-config-private-");
  const directory = join(root, "caller-owned");
  const path = join(directory, "config.json");
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);

  const saved = await savePrivacyConfig(FIXED_CONFIG, { path });
  const loaded = await loadPrivacyConfig({ path });

  assert.equal(saved.path, path);
  assert.equal(loaded.configured, true);
  assert.deepEqual(loaded.config, saved.config);
  assert.equal((await stat(directory)).mode & 0o777, 0o755);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("macOS configuration writes do not require descriptor-path traversal", {
  skip: process.platform === "win32"
}, async t => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", platformDescriptor));
  const root = await temporaryRoot(t, "privacyai-config-darwin-path-");
  const path = join(root, "config.json");

  await savePrivacyConfig(FIXED_CONFIG, { path });
  const loaded = await loadPrivacyConfig({ path });

  assert.equal(loaded.configured, true);
  assert.equal(loaded.config.model, FIXED_CONFIG.model);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("configuration storage accepts trusted macOS system symlink ancestors", {
  skip: process.platform !== "darwin"
}, async t => {
  assert.equal((await lstat("/var")).isSymbolicLink(), true);
  const root = await mkdtemp("/var/tmp/privacyai-config-system-alias-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "config.json");

  await savePrivacyConfig(FIXED_CONFIG, { path });
  const loaded = await loadPrivacyConfig({ path });

  assert.equal(loaded.configured, true);
  assert.equal(loaded.config.model, FIXED_CONFIG.model);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("configuration storage rejects symlinked parents and files without redirected writes", {
  skip: process.platform === "win32"
}, async t => {
  const root = await temporaryRoot(t, "privacyai-config-symlink-");
  const redirected = join(root, "redirected");
  const linkedDirectory = join(root, "config-link");
  await mkdir(redirected, { mode: 0o700 });
  await symlink(redirected, linkedDirectory, "dir");

  await assertConfigFailure(
    savePrivacyConfig(FIXED_CONFIG, { path: join(linkedDirectory, "config.json") })
  );
  assert.deepEqual(await readdir(redirected), []);

  const nestedRedirect = join(redirected, "nested");
  await mkdir(nestedRedirect, { mode: 0o700 });
  await assertConfigFailure(
    savePrivacyConfig(FIXED_CONFIG, {
      path: join(linkedDirectory, "nested", "config.json")
    })
  );
  assert.deepEqual(await readdir(nestedRedirect), []);

  const realDirectory = join(root, "real-config");
  const target = join(root, "target.json");
  const linkedFile = join(realDirectory, "config.json");
  await mkdir(realDirectory, { mode: 0o700 });
  await writeFile(target, JSON.stringify(FIXED_CONFIG), { mode: 0o600 });
  await symlink(target, linkedFile, "file");

  await assertConfigFailure(loadPrivacyConfig({ path: linkedFile }));
  await assertConfigFailure(savePrivacyConfig(FIXED_CONFIG, { path: linkedFile }));
  assert.equal(JSON.parse(await readFile(target, "utf8")).model, FIXED_CONFIG.model);
});

test("configuration storage rejects exposed parents, files, and hard links", {
  skip: process.platform === "win32"
}, async t => {
  const root = await temporaryRoot(t, "privacyai-config-permissions-");
  const exposedDirectory = join(root, "exposed");
  const exposedPath = join(exposedDirectory, "config.json");
  await mkdir(exposedDirectory, { mode: 0o700 });
  await chmod(exposedDirectory, 0o777);

  await assertConfigFailure(savePrivacyConfig(FIXED_CONFIG, { path: exposedPath }));
  assert.deepEqual(await readdir(exposedDirectory), []);

  await chmod(exposedDirectory, 0o700);
  await savePrivacyConfig(FIXED_CONFIG, { path: exposedPath });
  await chmod(exposedPath, 0o644);
  await assertConfigFailure(loadPrivacyConfig({ path: exposedPath }));

  await chmod(exposedPath, 0o600);
  const hardLink = join(exposedDirectory, "hard-link.json");
  await link(exposedPath, hardLink);
  await assertConfigFailure(loadPrivacyConfig({ path: exposedPath }));
});

test("failed configuration replacement removes private temporary files", {
  skip: process.platform === "win32"
}, async t => {
  const root = await temporaryRoot(t, "privacyai-config-cleanup-");
  const path = join(root, "config.json");
  await mkdir(path, { mode: 0o700 });

  await assertConfigFailure(savePrivacyConfig(FIXED_CONFIG, { path }));
  assert.deepEqual(await readdir(root), ["config.json"]);
  assert.deepEqual(await readdir(path), []);
});

test("configuration storage tolerates only unsupported fsync errors", {
  skip: process.platform === "win32"
}, async t => {
  const root = await temporaryRoot(t, "privacyai-config-fsync-");
  const path = join(root, "config.json");
  const probePath = join(root, "probe");
  const probe = await open(probePath, "w");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalSync = fileHandlePrototype.sync;
  await probe.close();
  await rm(probePath, { force: true });
  t.after(() => { fileHandlePrototype.sync = originalSync; });

  for (const code of ["EINVAL", "ENOTSUP"]) {
    let syncCalls = 0;
    fileHandlePrototype.sync = async function fixtureUnsupportedSync() {
      syncCalls += 1;
      const error = new Error("fixture unsupported fsync");
      error.code = code;
      throw error;
    };
    const model = "assurance-" + code;
    await savePrivacyConfig({ ...FIXED_CONFIG, model }, { path });
    assert.ok(syncCalls >= 2, code + " must exercise file and directory synchronization");
    assert.equal((await loadPrivacyConfig({ path })).config.model, model);
  }

  fileHandlePrototype.sync = async function fixtureUnexpectedSyncFailure() {
    const error = new Error("fixture unexpected fsync failure");
    error.code = "EIO";
    throw error;
  };
  await assertConfigFailure(
    savePrivacyConfig({ ...FIXED_CONFIG, model: "must-not-replace" }, { path })
  );
  assert.equal((await loadPrivacyConfig({ path })).config.model, "assurance-ENOTSUP");
  assert.deepEqual(await readdir(root), ["config.json"]);
});

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function assertConfigFailure(operation) {
  await assert.rejects(operation, error => {
    assert.equal(error?.code, "PRIVACYAI_CONFIG_INVALID");
    assert.equal(error?.publicMessage, "PrivacyAI configuration is invalid or unreadable.");
    assert.doesNotMatch(error?.message || "", /fixture-not-a-real-credential/);
    return true;
  });
}
