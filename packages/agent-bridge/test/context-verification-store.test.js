import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  MemoryContextVerificationStore,
  openContextVerificationStore,
  verificationFingerprint
} from "../src/index.js";
import { createTestTempDir } from "./test-temp-dir.js";

test("SQLite verification store persists thread maps and verified items across restart", async t => {
  const root = await createTestTempDir("privacyai-context-db-");
  const path = join(root, "context.sqlite3");
  const policyFingerprint = verificationFingerprint({ model: "local-test", prompt: "span-v2" });
  const record = {
    cacheKey: "cache-1",
    contentHash: "content-1",
    artifactType: "instructions",
    policyFingerprint,
    sessionMapAdditions: { "[EMAIL_1]": "private@example.test" }
  };

  const first = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => first.close());
  first.saveThread("codex-provider:thread-1", {
    parentSessionKeys: ["codex-provider:parent"],
    sessionMap: record.sessionMapAdditions,
    policyFingerprint
  });
  first.putVerification(record);
  first.recordThreadItem({
    sessionKey: "codex-provider:thread-1",
    slotKey: "instructions",
    cacheKey: record.cacheKey,
    contentHash: record.contentHash,
    artifactType: record.artifactType
  });
  first.close();

  const second = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => second.close());
  assert.deepEqual(second.loadThread("codex-provider:thread-1").sessionMap, record.sessionMapAdditions);
  assert.deepEqual(second.getVerification(record.cacheKey, policyFingerprint).sessionMapAdditions, record.sessionMapAdditions);
  assert.equal(second.getVerification(record.cacheKey, "different-policy"), undefined);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("SQLite verification store supports separate writers without losing thread records", async t => {
  const root = await createTestTempDir("privacyai-context-db-writers-");
  const path = join(root, "context.sqlite3");
  const left = await openContextVerificationStore({ verificationDbPath: path });
  const right = await openContextVerificationStore({ verificationDbPath: path });
  t.after(() => left.close());
  t.after(() => right.close());

  left.saveThread("left", { sessionMap: { "[EMAIL_1]": "left@example.test" } });
  right.saveThread("right", { sessionMap: { "[EMAIL_1]": "right@example.test" } });
  assert.equal(right.loadThread("left").sessionMap["[EMAIL_1]"], "left@example.test");
  assert.equal(left.loadThread("right").sessionMap["[EMAIL_1]"], "right@example.test");
});

test("corrupt context database fails closed", async t => {
  const root = await createTestTempDir("privacyai-context-db-corrupt-");
  const path = join(root, "context.sqlite3");
  await writeFile(path, "not a sqlite database", { mode: 0o600 });
  await assert.rejects(
    openContextVerificationStore({ verificationDbPath: path }),
    error => error?.code === "PRIVACYAI_CONTEXT_DB_UNAVAILABLE"
  );
});


test("SQLite verification entries expire before they can be touched again", async t => {
  const root = await createTestTempDir("privacyai-context-db-age-");
  const path = join(root, "context.sqlite3");
  const store = await openContextVerificationStore({
    verificationDbPath: path,
    verificationMaxAgeMs: 2
  });
  t.after(() => store.close());
  const policyFingerprint = "age-policy";
  store.putVerification({
    cacheKey: "old-cache",
    contentHash: "old-content",
    artifactType: "instructions",
    policyFingerprint,
    sessionMapAdditions: {}
  });

  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(store.getVerification("old-cache", policyFingerprint), undefined);
});

test("in-memory verification fallback enforces age and item bounds", async () => {
  const store = new MemoryContextVerificationStore({
    maxVerifiedItems: 2,
    maxThreadItems: 2,
    maxThreads: 2,
    verificationMaxAgeMs: 5
  });

  for (let index = 0; index < 3; index += 1) {
    store.saveThread(`thread-${index}`, { sessionMap: {} });
    store.putVerification({
      cacheKey: `cache-${index}`,
      contentHash: `content-${index}`,
      artifactType: "message_text",
      policyFingerprint: "memory-policy",
      sessionMapAdditions: {}
    });
    store.recordThreadItem({
      sessionKey: `thread-${index}`,
      slotKey: "input",
      cacheKey: `cache-${index}`,
      contentHash: `content-${index}`,
      artifactType: "message_text"
    });
    await new Promise(resolve => setTimeout(resolve, 2));
  }

  assert.equal(store.threads.size <= 2, true);
  assert.equal(store.verifications.size <= 2, true);
  assert.equal(store.threadItems.size <= 2, true);

  store.putVerification({
    cacheKey: "expiring",
    contentHash: "expiring-content",
    artifactType: "message_text",
    policyFingerprint: "memory-policy",
    sessionMapAdditions: {}
  });
  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(store.getVerification("expiring", "memory-policy"), undefined);
  store.close();
  assert.equal(store.threads.size + store.verifications.size + store.threadItems.size, 0);
});
