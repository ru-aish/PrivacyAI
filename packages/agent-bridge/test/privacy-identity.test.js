import assert from "node:assert/strict";
import { access, chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { createTestTempDir } from "./test-temp-dir.js";

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

test("corrupt key material fails closed without exposing bytes", async t => {
  const root = await createTestTempDir("privacyai-identity-corrupt-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const path = defaultPrivacyIdentityKeyPath({ identityBaseDir: root });
  await writeFile(path, '{"version":1,"algorithm":"HMAC-SHA-256","key":"bad","keyId":"kid1:bad"}\n', {
    mode: 0o600
  });
  await chmod(path, 0o600);

  await assert.rejects(
    openInstallationPrivacyIdentity({ identityBaseDir: root }),
    error =>
      error?.code === "PRIVACYAI_IDENTITY_KEY_CORRUPT" &&
      !String(error.message).includes("bad")
  );
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
