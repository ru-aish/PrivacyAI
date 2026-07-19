import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";

import { openContextVerificationStore, retryContextStoreOperation } from "../src/index.js";
import { createTestTempDir } from "./test-temp-dir.js";

test("retry success yields to the event loop and timeout hides SQLite lock text", async t => {
  const root = await createTestTempDir("privacyai-a4-retry-");
  const path = join(root, "context.sqlite3");
  const store = await openContextVerificationStore({ verificationDbPath: path, verificationBusyTimeoutMs: 0 });
  const blocker = new DatabaseSync(path);
  blocker.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  t.after(() => { try { blocker.exec("ROLLBACK"); } catch {} blocker.close(); store.close(); });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 2);
  const release = setTimeout(() => blocker.exec("COMMIT"), 35);
  t.after(() => { clearInterval(timer); clearTimeout(release); });
  await retryContextStoreOperation(() => store.saveThread("yielded", { sessionMap: {} }), { timeoutMs: 500 });
  assert.ok(ticks > 0);

  blocker.exec("BEGIN IMMEDIATE");
  await assert.rejects(
    retryContextStoreOperation(() => store.saveThread("timed-out", { sessionMap: {} }), { timeoutMs: 30 }),
    error => error?.code === "PRIVACYAI_CONTEXT_DB_RETRY_TIMEOUT" && !/locked|busy/i.test(error.message)
  );
});

test("retry supports AbortSignal, preserves non-contention identity, and honors elapsed deadlines", async () => {
  const controller = new AbortController();
  const reason = new Error("controlled abort");
  const promise = retryContextStoreOperation(() => { const error = new Error("database is locked"); error.code = "SQLITE_BUSY"; throw error; }, { timeoutMs: 500, signal: controller.signal });
  setTimeout(() => controller.abort(reason), 15);
  await assert.rejects(promise, error => error === reason);

  const original = new Error("validation identity");
  await assert.rejects(retryContextStoreOperation(() => { throw original; }), error => error === original);

  const contention = new Error("database is locked"); contention.code = "SQLITE_BUSY";
  await assert.rejects(retryContextStoreOperation(() => { throw contention; }, { deadlineAt: Date.now() - 1 }), error => error?.code === "PRIVACYAI_CONTEXT_DB_RETRY_TIMEOUT");
});


test("retry does not invoke an operation after its deadline", async () => {
  let attempts = 0;
  await assert.rejects(
    retryContextStoreOperation(() => {
      attempts += 1;
      const error = new Error("database is locked");
      error.code = "SQLITE_BUSY";
      throw error;
    }, { deadlineAt: Date.now() + 5 }),
    error => error?.code === "PRIVACYAI_CONTEXT_DB_RETRY_TIMEOUT"
  );
  assert.equal(attempts, 1);
});
