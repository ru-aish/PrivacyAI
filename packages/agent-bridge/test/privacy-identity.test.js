import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";

import {
  defaultPrivacyIdentityKeyPath,
  deterministicProviderIdentifier,
  openInstallationPrivacyIdentity,
  rotateInstallationPrivacyIdentityKey,
  sessionPrivacyIdentity
} from "../src/privacy-identity.js";
import { SessionVault } from "../src/session-vault.js";
import { allowancePath } from "../src/prompt-flow.js";
import { readProcessStartIdentity } from "../src/process-identity.js";
import { createTestTempDir } from "./test-temp-dir.js";

const identityModuleUrl = new URL("../src/privacy-identity.js", import.meta.url).href;
const IDENTITY_CHILD_TIMEOUT_MS = 75_000;

test("installation identity persists with private permissions", async t => {
  const root = await createTestTempDir("privacyai-identity-key-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { identityBaseDir: root };

  const first = await openInstallationPrivacyIdentity(options);
  const second = await openInstallationPrivacyIdentity(options);
  const path = defaultPrivacyIdentityKeyPath(options);

  assert.equal(first.keyId, second.keyId);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const serialized = await readFile(path, "utf8");
  assert.equal(serialized.includes("owner@example.test"), false);
});

test("concurrent first install publishes one complete key to every process", async t => {
  const root = await createTestTempDir("privacyai-identity-concurrent-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const results = await Promise.all(
    Array.from({ length: 24 }, () => openIdentityInChild(root))
  );

  assert.deepEqual(results.map(result => result.code), Array(24).fill(0));
  assert.equal(results.every(result => result.stderr === ""), true);
  assert.equal(new Set(results.map(result => result.stdout)).size, 1);
  assert.match(results[0].stdout, /^kid1:[a-f0-9]{32}$/);
});

test("interrupted first-install temporary files are removed after recovery", async t => {
  const root = await createTestTempDir("privacyai-identity-interrupted-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const staleTempPath = join(root, "key-v1.json.999999.interrupted.tmp");
  await writeFile(staleTempPath, '{"version":1', { mode: 0o600 });
  if (process.platform === "linux") {
    await writeFile(
      join(root, `key-v1.json.${process.pid}.0.recycled.tmp`),
      '{"version":1',
      { mode: 0o600 }
    );
  }

  const identityRoot = await openInstallationPrivacyIdentity({ identityBaseDir: root });

  assert.match(identityRoot.keyId, /^kid1:[a-f0-9]{32}$/);
  await assert.rejects(access(staleTempPath), error => error?.code === "ENOENT");
  assert.deepEqual(
    (await readdir(root)).filter(name => name.startsWith("key-v1.json.") && name.endsWith(".tmp")),
    []
  );
});

test("safe explicit key paths do not chmod their containing directory", {
  skip: process.platform === "win32"
}, async t => {
  const root = await createTestTempDir("privacyai-identity-explicit-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const identityKeyPath = join(root, "custom-key.json");

  const identityRoot = await openInstallationPrivacyIdentity({ identityKeyPath });

  assert.match(identityRoot.keyId, /^kid1:[a-f0-9]{32}$/);
  assert.equal((await stat(root)).mode & 0o777, 0o755);
  assert.equal((await stat(identityKeyPath)).mode & 0o777, 0o600);
});

test("session scope is restart-stable and isolates lineages", async t => {
  const root = await createTestTempDir("privacyai-identity-scope-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstRoot = await openInstallationPrivacyIdentity({ identityBaseDir: root });
  const first = sessionPrivacyIdentity(firstRoot, "codex-provider:thread-a");
  const repeatedRoot = await openInstallationPrivacyIdentity({ identityBaseDir: root });
  const repeated = sessionPrivacyIdentity(repeatedRoot, "codex-provider:thread-a");
  const isolated = sessionPrivacyIdentity(repeatedRoot, "codex-provider:thread-b");

  assert.equal(first.protectedValue("owner@example.test").id, repeated.protectedValue("owner@example.test").id);
  assert.notEqual(first.protectedValue("owner@example.test").id, isolated.protectedValue("owner@example.test").id);
});

test("key rotation creates a new identity epoch while preserving vault restoration", async t => {
  const root = await createTestTempDir("privacyai-identity-rotation-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityBaseDir = join(root, "identity");
  const vaultBaseDir = join(root, "vault");
  const sessionId = "rotation-session";
  const map = { "[EMAIL_1]": "rotation@example.test" };
  const before = await openInstallationPrivacyIdentity({ identityBaseDir });
  const beforeVault = new SessionVault({ baseDir: vaultBaseDir, identityRoot: before });
  const saved = await beforeVault.save(sessionId, map);
  const oldPath = saved.path;
  const locatorPath = beforeVault.legacyPathForSession(sessionId);
  const locator = await readFile(locatorPath, "utf8");
  assert.equal(locator.includes(map["[EMAIL_1]"]), false);
  assert.equal(locator.includes(sessionId), false);

  const rotated = await rotateInstallationPrivacyIdentityKey({ identityBaseDir });
  const after = await openInstallationPrivacyIdentity({ identityBaseDir });
  const afterVault = new SessionVault({ baseDir: vaultBaseDir, identityRoot: after });
  const loaded = await afterVault.load(sessionId);

  assert.equal(after.keyId, rotated.keyId);
  assert.notEqual(after.keyId, before.keyId);
  assert.equal(rotated.previousKeyId, before.keyId);
  assert.notEqual(afterVault.pathForSession(sessionId), oldPath);
  assert.deepEqual(loaded.sessionMap, map);
  assert.equal(loaded.identityKeyId, after.keyId);

  await afterVault.save(sessionId, loaded.sessionMap);
  await assert.rejects(access(oldPath), error => error?.code === "ENOENT");
  await access(afterVault.pathForSession(sessionId));
});

test("64 concurrent rotations return only the epoch still installed at settlement", {
  timeout: 90_000
}, async t => {
  const root = await createTestTempDir("privacyai-identity-concurrent-rotation-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = await openInstallationPrivacyIdentity({ identityBaseDir: root });

  const results = await Promise.all(
    Array.from({ length: 64 }, () => rotateIdentityInChild(root))
  );

  assert.equal(
    results.every(result => result.code === 0 && result.stderr === ""),
    true,
    JSON.stringify(results.filter(result => result.code !== 0 || result.stderr !== ""))
  );
  const rotations = results.map(result => JSON.parse(result.stdout));
  assert.equal(rotations.every(result => result.keyId === result.identityKeyId), true);
  assert.equal(rotations.every(result => result.keyId === result.installedKeyId), true);
  assert.equal(new Set(rotations.map(result => result.keyId)).size, 64);
  const byPreviousKeyId = new Map();
  for (const rotation of rotations) {
    assert.equal(typeof rotation.previousKeyId, "string");
    assert.equal(byPreviousKeyId.has(rotation.previousKeyId), false);
    byPreviousKeyId.set(rotation.previousKeyId, rotation.keyId);
  }
  let chainKeyId = initial.keyId;
  const chain = [];
  for (let index = 0; index < 64; index += 1) {
    const nextKeyId = byPreviousKeyId.get(chainKeyId);
    assert.match(nextKeyId, /^kid1:[a-f0-9]{32}$/);
    chain.push(nextKeyId);
    chainKeyId = nextKeyId;
  }
  assert.equal(new Set(chain).size, 64);
  const current = await openInstallationPrivacyIdentity({ identityBaseDir: root });
  assert.equal(chainKeyId, current.keyId);
  assert.deepEqual(
    (await readdir(root)).filter(name => name.startsWith("key-v1.json.") && name.endsWith(".tmp")),
    []
  );
  await assertEventuallyNoRotationLocks(root);
});

test("fresh installs and rotations share one mutation order", {
  timeout: 30_000
}, async t => {
  const root = await createTestTempDir("privacyai-identity-install-rotation-order-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const operations = Array.from({ length: 12 }, () => [
    { kind: "open", promise: openIdentityInChild(root) },
    { kind: "rotate", promise: rotateIdentityInChild(root) }
  ]).flat();

  const completed = await Promise.all(
    operations.map(async operation => ({
      kind: operation.kind,
      result: await operation.promise
    }))
  );
  assert.equal(
    completed.every(({ result }) => result.code === 0 && result.stderr === ""),
    true,
    JSON.stringify(completed.filter(({ result }) => result.code !== 0 || result.stderr !== ""))
  );

  const openKeyIds = new Set(
    completed.filter(item => item.kind === "open").map(item => item.result.stdout)
  );
  const rotations = completed
    .filter(item => item.kind === "rotate")
    .map(item => JSON.parse(item.result.stdout));
  const rotationKeyIds = new Set(rotations.map(rotation => rotation.keyId));
  assert.equal(rotationKeyIds.size, 12);

  const byPreviousKeyId = new Map();
  for (const rotation of rotations) {
    assert.equal(byPreviousKeyId.has(rotation.previousKeyId), false);
    byPreviousKeyId.set(rotation.previousKeyId, rotation.keyId);
  }
  const roots = rotations
    .map(rotation => rotation.previousKeyId)
    .filter(previousKeyId => previousKeyId == null || !rotationKeyIds.has(previousKeyId));
  assert.equal(roots.length, 1);
  if (roots[0] != null) assert.equal(openKeyIds.has(roots[0]), true);

  let chainKeyId = roots[0];
  for (let index = 0; index < rotations.length; index += 1) {
    const nextKeyId = byPreviousKeyId.get(chainKeyId);
    assert.match(nextKeyId, /^kid1:[a-f0-9]{32}$/);
    chainKeyId = nextKeyId;
  }
  const current = await openInstallationPrivacyIdentity({ identityBaseDir: root });
  assert.equal(chainKeyId, current.keyId);
  await assertEventuallyNoRotationLocks(root);
});

test("rotation recovers a lock owned by a dead process", async t => {
  const root = await createTestTempDir("privacyai-identity-dead-rotation-lock-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await openInstallationPrivacyIdentity({ identityBaseDir: root });
  const token = "00000000-0000-4000-8000-000000000001";
  const lockPath = rotationParticipantPath(root, 999999, "1", token);
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: 999999,
    processStart: "1",
    createdAt: Date.now(),
    token,
    choosing: false,
    ticket: 1
  })}\n`, { mode: 0o600 });

  const rotated = await rotateInstallationPrivacyIdentityKey({ identityBaseDir: root });

  assert.match(rotated.keyId, /^kid1:[a-f0-9]{32}$/);
  await assertEventuallyMissing(lockPath);
});

test("rotation recovers a recycled-PID lock on Linux", {
  skip: process.platform !== "linux"
}, async t => {
  const root = await createTestTempDir("privacyai-identity-recycled-rotation-lock-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await openInstallationPrivacyIdentity({ identityBaseDir: root });
  const token = "00000000-0000-4000-8000-000000000002";
  const lockPath = rotationParticipantPath(root, process.pid, "0", token);
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    processStart: "0",
    createdAt: Date.now(),
    token,
    choosing: false,
    ticket: 1
  })}\n`, { mode: 0o600 });

  const rotated = await rotateInstallationPrivacyIdentityKey({ identityBaseDir: root });

  assert.match(rotated.keyId, /^kid1:[a-f0-9]{32}$/);
  await assertEventuallyMissing(lockPath);
});

test("rotation lock contention has a bounded deadlock timeout", async t => {
  const root = await createTestTempDir("privacyai-identity-live-rotation-lock-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await openInstallationPrivacyIdentity({ identityBaseDir: root });
  const processStart = await readProcessStartIdentity(process.pid);
  const token = "00000000-0000-4000-8000-000000000003";
  const lockPath = rotationParticipantPath(root, process.pid, processStart, token);
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    processStart,
    createdAt: Date.now(),
    token,
    choosing: false,
    ticket: 1
  })}\n`, { mode: 0o600 });

  const startedAt = Date.now();
  await assert.rejects(
    rotateInstallationPrivacyIdentityKey({
      identityBaseDir: root,
      identityRotationLockTimeoutMs: 100
    }),
    error => error?.code === "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE"
  );
  assert.equal(Date.now() - startedAt < 2_000, true);
  await access(lockPath);
  await rm(lockPath);

  const rotated = await rotateInstallationPrivacyIdentityKey({ identityBaseDir: root });
  assert.match(rotated.keyId, /^kid1:[a-f0-9]{32}$/);
});

test("cancelling a contended rotation cleans only its participant", async t => {
  const root = await createTestTempDir("privacyai-identity-cancelled-rotation-lock-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = await openInstallationPrivacyIdentity({ identityBaseDir: root });
  const processStart = await readProcessStartIdentity(process.pid);
  const token = "00000000-0000-4000-8000-000000000004";
  const lockPath = rotationParticipantPath(root, process.pid, processStart, token);
  await writeFile(lockPath, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    processStart,
    createdAt: Date.now(),
    token,
    choosing: false,
    ticket: 1
  })}\n`, { mode: 0o600 });

  const controller = new AbortController();
  const pending = rotateInstallationPrivacyIdentityKey({
    identityBaseDir: root,
    signal: controller.signal
  });
  await waitForRotationLockCount(root, 2);
  controller.abort();

  await assert.rejects(
    pending,
    error =>
      error?.code === "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE" &&
      error?.cause?.code === "ABORT_ERR" &&
      !error.message.includes(token)
  );
  await waitForRotationLockCount(root, 1);
  assert.deepEqual(await rotationLockNames(root), [basename(lockPath)]);
  const current = await openInstallationPrivacyIdentity({ identityBaseDir: root });
  assert.equal(current.keyId, initial.keyId);

  await rm(lockPath);
  const rotated = await rotateInstallationPrivacyIdentityKey({ identityBaseDir: root });
  assert.match(rotated.keyId, /^kid1:[a-f0-9]{32}$/);
});

test("persistent identity storage fails closed on Windows before filesystem writes", async t => {
  const root = await createTestTempDir("privacyai-identity-win32-fail-closed-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await windowsIdentityStorageInChild(root);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    codes: [
      "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE",
      "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE",
      "PRIVACYAI_IDENTITY_KEY_UNAVAILABLE"
    ],
    entries: []
  });
});

test("provider identifiers fail closed without infrastructure identity", () => {
  assert.throws(
    () => deterministicProviderIdentifier(null, "codex", "private_tool"),
    error => error?.code === "PRIVACYAI_IDENTITY_REQUIRED"
  );
});

test("identity key loading rejects permissive files and symlinks", async t => {
  const root = await createTestTempDir("privacyai-identity-file-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { identityBaseDir: root };
  await openInstallationPrivacyIdentity(options);
  const path = defaultPrivacyIdentityKeyPath(options);

  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await assert.rejects(
      openInstallationPrivacyIdentity(options),
      error => error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT"
    );
    await chmod(path, 0o600);
  }

  const target = join(root, "key-target.json");
  await rename(path, target);
  await symlink(target, path);
  await assert.rejects(
    openInstallationPrivacyIdentity(options),
    error => error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT"
  );
});

test("identity open rejects symlinked parent components without chmod or writes", {
  skip: process.platform === "win32"
}, async t => {
  const root = await createTestTempDir("privacyai-identity-parent-link-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const realParent = join(root, "real-parent");
  const linkedParent = join(root, "linked-parent");
  await mkdir(realParent, { mode: 0o755 });
  await chmod(realParent, 0o755);
  await symlink(realParent, linkedParent, "dir");

  await assert.rejects(
    openInstallationPrivacyIdentity({ identityBaseDir: join(linkedParent, "identity") }),
    error => error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT"
  );
  assert.equal((await stat(realParent)).mode & 0o777, 0o755);
  await assert.rejects(
    access(join(realParent, "identity", "key-v1.json")),
    error => error?.code === "ENOENT"
  );
});

test("identity rotation rejects a parent replaced with a symlink", {
  skip: process.platform === "win32"
}, async t => {
  const root = await createTestTempDir("privacyai-identity-rotation-link-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityBaseDir = join(root, "identity");
  const preservedIdentityDir = join(root, "preserved-identity");
  const redirectTarget = join(root, "redirect-target");
  await openInstallationPrivacyIdentity({ identityBaseDir });
  await rename(identityBaseDir, preservedIdentityDir);
  await mkdir(redirectTarget, { mode: 0o755 });
  await chmod(redirectTarget, 0o755);
  await symlink(redirectTarget, identityBaseDir, "dir");

  await assert.rejects(
    rotateInstallationPrivacyIdentityKey({ identityBaseDir }),
    error => error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT"
  );
  assert.equal((await stat(redirectTarget)).mode & 0o777, 0o755);
  await assert.rejects(
    access(join(redirectTarget, "key-v1.json")),
    error => error?.code === "ENOENT"
  );
  await access(join(preservedIdentityDir, "key-v1.json"));
});

test("corrupt key material fails closed without exposing bytes", async t => {
  const root = await createTestTempDir("privacyai-identity-corrupt-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const path = defaultPrivacyIdentityKeyPath({ identityBaseDir: root });
  await writeFile(path, '{"version":1,"algorithm":"HMAC-SHA-256","key":"bad","keyId":"kid1:bad"}\n', {
    mode: 0o600
  });
  await chmod(path, 0o600);

  const rejectsPrivately = error =>
    error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT" &&
    !String(error.message).includes("bad");
  await assert.rejects(
    openInstallationPrivacyIdentity({ identityBaseDir: root }),
    rejectsPrivately
  );
  await assert.rejects(
    rotateInstallationPrivacyIdentityKey({ identityBaseDir: root }),
    rejectsPrivately
  );
  await assertEventuallyNoRotationLocks(root);
});

test("session vault persists identity sidecars while legacy maps remain restorable", async t => {
  const root = await createTestTempDir("privacyai-identity-vault-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityRoot = await openInstallationPrivacyIdentity({ identityBaseDir: join(root, "identity") });
  const vault = new SessionVault({ baseDir: join(root, "vault"), identityRoot });
  const map = {
    "[EMAIL_1]": "owner@example.test",
    "privacyai_tool_123456789abc": "private_agy_tool",
    "privacyai_abcdef123456": "private_codex_tool"
  };

  const saved = await vault.save("session-a", map);
  const loaded = await vault.load("session-a");

  assert.deepEqual(loaded.sessionMap, map);
  assert.equal(saved.identityKeyId, identityRoot.keyId);
  assert.match(saved.identityMap["[EMAIL_1]"].id, /^phi1:[a-f0-9]{64}$/);
  assert.match(saved.identityMap["[EMAIL_1]"].protectedValueId, /^pvi1:[a-f0-9]{64}$/);
  assert.equal(saved.identityMap["privacyai_tool_123456789abc"].domain, "provider-identifier");
  assert.equal(saved.identityMap["privacyai_abcdef123456"].domain, "provider-identifier");
  assert.equal(JSON.stringify(saved.identityMap).includes("owner@example.test"), false);
});

test("provider identifiers and prompt allowances use separated keyed domains", async t => {
  const root = await createTestTempDir("privacyai-identity-domains-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityRoot = await openInstallationPrivacyIdentity({ identityBaseDir: root });
  const identity = sessionPrivacyIdentity(identityRoot, "agy:session-a");
  const original = "send_private_email";
  const occupied = new Set();

  const agy = deterministicProviderIdentifier(identity, "agy", original, occupied);
  const codex = deterministicProviderIdentifier(identity, "codex", original, occupied);
  assert.match(agy, /^privacyai_tool_[a-f0-9]{12,64}$/);
  assert.match(codex, /^privacyai_[a-f0-9]{12,64}$/);
  assert.notEqual(agy, codex);

  const path = allowancePath(root, "session-a", "private prompt", { identityRoot });
  assert.equal(path.includes("private prompt"), false);
  assert.equal(path.includes("session-a"), false);
});

function rotateIdentityInChild(identityBaseDir) {
  const script = `
    const { readFileSync } = await import("node:fs");
    const {
      defaultPrivacyIdentityKeyPath,
      rotateInstallationPrivacyIdentityKey
    } = await import(${JSON.stringify(identityModuleUrl)});
    try {
      const options = { identityBaseDir: process.env.PRIVACYAI_TEST_IDENTITY_DIR };
      const result = await rotateInstallationPrivacyIdentityKey(options);
      const installed = JSON.parse(readFileSync(defaultPrivacyIdentityKeyPath(options), "utf8"));
      process.stdout.write(JSON.stringify({
        previousKeyId: result.previousKeyId,
        keyId: result.keyId,
        identityKeyId: result.identityRoot.keyId,
        installedKeyId: installed.keyId
      }));
    } catch (error) {
      process.stderr.write(String(error?.code || "UNKNOWN") + " " + String(error?.message || error));
      process.exitCode = 1;
    }
  `;
  return runIdentityChild(identityBaseDir, script);
}

function windowsIdentityStorageInChild(identityBaseDir) {
  const script = `
    const { readdirSync } = await import("node:fs");
    Object.defineProperty(process, "platform", { value: "win32" });
    const {
      loadInstallationPrivacyIdentity,
      openInstallationPrivacyIdentity,
      rotateInstallationPrivacyIdentityKey
    } = await import(${JSON.stringify(identityModuleUrl)} + "?win32-fail-closed");
    const options = { identityBaseDir: process.env.PRIVACYAI_TEST_IDENTITY_DIR + "/identity" };
    const codes = [];
    for (const operation of [
      loadInstallationPrivacyIdentity,
      openInstallationPrivacyIdentity,
      rotateInstallationPrivacyIdentityKey
    ]) {
      try {
        await operation(options);
        codes.push("SUCCESS");
      } catch (error) {
        codes.push(String(error?.code || "UNKNOWN"));
      }
    }
    process.stdout.write(JSON.stringify({
      codes,
      entries: readdirSync(process.env.PRIVACYAI_TEST_IDENTITY_DIR)
    }));
  `;
  return runIdentityChild(identityBaseDir, script);
}

function openIdentityInChild(identityBaseDir) {
  const script = `
    const { openInstallationPrivacyIdentity } = await import(${JSON.stringify(identityModuleUrl)});
    try {
      const identity = await openInstallationPrivacyIdentity({
        identityBaseDir: process.env.PRIVACYAI_TEST_IDENTITY_DIR
      });
      process.stdout.write(identity.keyId);
    } catch (error) {
      process.stderr.write(String(error?.code || "UNKNOWN") + " " + String(error?.message || error));
      process.exitCode = 1;
    }
  `;
  return runIdentityChild(identityBaseDir, script);
}

function rotationParticipantPath(root, pid, processStart, token) {
  return join(
    root,
    `key-v1.json.rotation.${pid}.${processStart || "unknown"}.${token}.lock`
  );
}

async function rotationLockNames(root) {
  return (await readdir(root))
    .filter(name => name.startsWith("key-v1.json.rotation.") && name.endsWith(".lock"))
    .sort();
}

async function waitForRotationLockCount(root, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const locks = await rotationLockNames(root);
    if (locks.length === expected) return locks;
    if (Date.now() >= deadline) {
      assert.fail(`Expected ${expected} identity rotation locks, found: ${locks.join(", ")}`);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
  }
}

async function assertEventuallyNoRotationLocks(root, timeoutMs = 2_000) {
  await waitForRotationLockCount(root, 0, timeoutMs);
}

async function assertEventuallyMissing(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      assert.fail(`Expected ${path} to be removed before timeout.`);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
  }
}

function runIdentityChild(identityBaseDir, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        PRIVACYAI_TEST_IDENTITY_DIR: identityBaseDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, IDENTITY_CHILD_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) stderr += "PRIVACYAI_TEST_CHILD_TIMEOUT";
      resolve({ code, stdout, stderr });
    });
  });
}
