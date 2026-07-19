import assert from "node:assert/strict";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadSessionMap, SessionVault } from "../src/index.js";
import { createTestTempDir } from "./test-temp-dir.js";

test("SessionVault preserves exact originals and rejects conflicting placeholders", async t => {
  const root = await createTestTempDir("privacyai-a4-vault-");
  const vault = new SessionVault({ baseDir: root });
  await vault.save("session", { "[EMAIL_1]": "Alice+tag@example.test", "[KEY_1]": "case-sensitive-Original" });
  assert.deepEqual((await vault.load("session")).sessionMap, { "[EMAIL_1]": "Alice+tag@example.test", "[KEY_1]": "case-sensitive-Original" });
  await assert.rejects(vault.merge("session", { "[EMAIL_1]": "other@example.test" }), error => error?.code === "PRIVACYAI_SESSION_MAP_COLLISION");
  assert.deepEqual((await vault.load("session")).sessionMap, { "[EMAIL_1]": "Alice+tag@example.test", "[KEY_1]": "case-sensitive-Original" });
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(vault.pathForSession("session"))).mode & 0o777, 0o600);
});

test("SessionVault lock waits are abortable and positive lock options are validated", async t => {
  const root = await createTestTempDir("privacyai-a4-vault-lock-");
  const vault = new SessionVault({ baseDir: root });
  const lockPath = `${vault.pathForSession("locked")}.lock`;
  await mkdir(root, { recursive: true });
  await (await import("node:fs/promises")).writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "held" }), { mode: 0o600 });
  const controller = new AbortController();
  const waiting = vault.update("locked", map => map.sessionMap, { lockRetryMs: 5, lockTimeoutMs: 500, signal: controller.signal });
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(waiting, error => error?.name === "AbortError");
  await assert.rejects(vault.update("other", map => map.sessionMap, { lockRetryMs: 0 }), TypeError);
  await assert.rejects(vault.update("other", map => map.sessionMap, { lockTimeoutMs: 0 }), TypeError);
});

test("SessionVault cleans a temp file when final rename cannot succeed", async t => {
  const root = await createTestTempDir("privacyai-a4-vault-temp-");
  const vault = new SessionVault({ baseDir: root });
  const path = vault.pathForSession("rename-failure");
  await mkdir(path);
  await writeFile(join(path, "keep"), "x");
  await assert.rejects(vault.save("rename-failure", { "[TOKEN_1]": "original" }));
  const names = await readdir(root);
  assert.deepEqual(names, [path.split("/").at(-1)]);
  assert.equal(names.some(name => name.endsWith(".tmp")), false);
});

test("SessionVault corruption errors never echo stored originals", async () => {
  const root = await createTestTempDir("privacyai-a4-vault-corrupt-");
  const vault = new SessionVault({ baseDir: root });
  const secret = "PRIVATE-VAULT-SECRET-DO-NOT-LOG";
  await writeFile(vault.pathForSession("corrupt"), '{"sessionMap": {"[TOKEN_1]": ' + secret + '}}', { mode: 0o600 });
  await assert.rejects(vault.load("corrupt"), error => {
    const diagnostic = [error?.message, error?.stack, error?.cause?.message, error?.cause?.stack]
      .filter(Boolean).join("\n");
    return error?.code === "PRIVACYAI_VAULT_CORRUPT" && !diagnostic.includes(secret);
  });

  const mapFile = join(root, "map.json");
  await writeFile(mapFile, '{"sessionMap": {"[TOKEN_1]": ' + secret + '}}', { mode: 0o600 });
  await assert.rejects(loadSessionMap({ mapFile }), error => {
    const diagnostic = [error?.message, error?.stack, error?.cause?.message, error?.cause?.stack]
      .filter(Boolean).join("\n");
    return error?.code === "PRIVACYAI_SESSION_MAP_FILE_CORRUPT" && !diagnostic.includes(secret);
  });
});
