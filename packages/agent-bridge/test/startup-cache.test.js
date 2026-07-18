import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { MemoryContextVerificationStore } from "../src/context-verification-store.js";
import { auditCodexStartupContext } from "../src/startup-audit.js";
import { readStableStartupText, renderedStartupFingerprint, resolveStartupFileManifest, sanitizeStartupFiles, startupFileVerificationKey } from "../src/startup-cache.js";

const execFile = promisify(execFileCallback);
const policy = "sha256:test-policy";
const sanitizer = calls => async () => { calls.count += 1; return { sessionMap: {} }; };

test("startup verification keys isolate content and policy identities", () => {
  const first = startupFileVerificationKey("sha256:content-a", "sha256:policy-a");
  assert.notEqual(first, startupFileVerificationKey("sha256:content-b", "sha256:policy-a"));
  assert.notEqual(first, startupFileVerificationKey("sha256:content-a", "sha256:policy-b"));
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test("startup byte limits reject oversized files before any content read", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "AGENTS.md");
  await writeFile(file, "oversized");
  let reads = 0;

  await assert.rejects(
    resolveStartupFileManifest([file], {
      cwd: root,
      maxBytes: 4,
      readStableFile: async () => {
        reads += 1;
        throw new Error("oversized startup file must not be read");
      }
    }),
    error => error?.code === "PRIVACYAI_STARTUP_CONTEXT_TOO_LARGE"
  );
  assert.equal(reads, 0);
});

test("startup file-count limits stop before reading the excess file", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-file-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "AGENTS.md");
  const second = join(root, "CLAUDE.md");
  await writeFile(first, "first");
  await writeFile(second, "second");
  let reads = 0;

  await assert.rejects(
    resolveStartupFileManifest([first, second], {
      cwd: root,
      maxFiles: 1,
      readStableFile: async ({ path }) => {
        reads += 1;
        return path === first ? "first" : "second";
      }
    }),
    error => error?.code === "PRIVACYAI_STARTUP_CONTEXT_TOO_LARGE"
  );
  assert.equal(reads, 1);
});

test("stable startup reads reject stale metadata and stale content identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-stable-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "AGENTS.md");
  await writeFile(file, "first");
  const first = await resolveStartupFileManifest([file], {
    cwd: root,
    verificationStore: new MemoryContextVerificationStore()
  });
  const staleRecord = first.records[0];

  await writeFile(file, "grown-after-lstat");
  await assert.rejects(
    readStableStartupText(staleRecord, { maxBytes: 1024 }),
    error => error?.code === "PRIVACYAI_STARTUP_FILE_CHANGED"
  );

  await writeFile(file, "world");
  const refreshed = await resolveStartupFileManifest([file], {
    cwd: root,
    verificationStore: new MemoryContextVerificationStore()
  });
  await assert.rejects(
    readStableStartupText(refreshed.records[0], {
      maxBytes: 1024,
      contentHash: staleRecord.contentHash
    }),
    error => error?.code === "PRIVACYAI_STARTUP_FILE_CHANGED"
  );
});

test("startup file metadata hit performs zero reads and sanitizer calls", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-cache-")); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "AGENTS.md"); await writeFile(file, "hello");
  const store = new MemoryContextVerificationStore(); const calls = { count: 0 };
  const first = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store });
  await sanitizeStartupFiles(first, { verificationStore: store, policyFingerprint: policy, sanitizer: sanitizer(calls) });
  const warm = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store });
  const result = await sanitizeStartupFiles(warm, { verificationStore: store, policyFingerprint: policy, sanitizer: sanitizer(calls) });
  assert.equal(warm.counters.reads, 0); assert.equal(warm.counters.metadataHits, 1); assert.equal(result.sanitizerCalls, 0); assert.equal(calls.count, 1);
});

test("first-time startup sanitization persists opaque private spans", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "AGENTS.md");
  await writeFile(file, "owner=private@example.test\n");
  const store = new MemoryContextVerificationStore();
  const manifest = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store });
  await sanitizeStartupFiles(manifest, {
    verificationStore: store,
    policyFingerprint: policy,
    sanitizer: async () => ({ sessionMap: { "[EMAIL_1]": "private@example.test" } })
  });
  const plan = store.getPrivacyPlan(manifest.records[0].contentHash, policy);
  assert.deepEqual(plan.spans.map(span => [span.start, span.end, span.classification]), [
    [6, 26, "email"]
  ]);
  assert.equal(JSON.stringify(plan).includes("private@example.test"), false);
});

test("metadata change with same bytes hashes then reuses per-file result; manifests detect mutations", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-cache-")); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "AGENTS.md"); await writeFile(file, "same");
  const store = new MemoryContextVerificationStore(); const calls = { count: 0 };
  let manifest = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store }); await sanitizeStartupFiles(manifest, { verificationStore: store, policyFingerprint: policy, sanitizer: sanitizer(calls) });
  await writeFile(file, "same"); manifest = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store });
  assert.equal(manifest.counters.reads, 1); const same = await sanitizeStartupFiles(manifest, { verificationStore: store, policyFingerprint: policy, sanitizer: sanitizer(calls) }); assert.equal(same.sanitizerCalls, 0);
  const before = manifest.manifestHash; await writeFile(file, "changed"); const changed = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store }); assert.notEqual(changed.manifestHash, before);
  const added = join(root, "CLAUDE.md"); await writeFile(added, "added"); const withAdded = await resolveStartupFileManifest([file, added], { cwd: root, verificationStore: store }); assert.notEqual(withAdded.manifestHash, changed.manifestHash);
  await rename(added, join(root, "RENAMED.md")); const renamed = await resolveStartupFileManifest([file, join(root, "RENAMED.md")], { cwd: root, verificationStore: store }); assert.notEqual(renamed.manifestHash, withAdded.manifestHash);
});

test("linked worktrees reuse Git blob identities and non-Git directories work", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-git-")); t.after(() => rm(root, { recursive: true, force: true }));
  await execFile("git", ["init", root]); await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]); await execFile("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "AGENTS.md"), "shared"); await execFile("git", ["-C", root, "add", "AGENTS.md"]); await execFile("git", ["-C", root, "commit", "-m", "init"]);
  const other = join(root, "other"); await execFile("git", ["-C", root, "worktree", "add", other, "-b", "other"]);
  const store = new MemoryContextVerificationStore();
  const calls = { count: 0 };
  const original = await resolveStartupFileManifest([join(root, "AGENTS.md")], { cwd: root, verificationStore: store });
  await sanitizeStartupFiles(original, {
    verificationStore: store,
    policyFingerprint: policy,
    sanitizer: sanitizer(calls)
  });
  const reused = await resolveStartupFileManifest([join(other, "AGENTS.md")], { cwd: other, verificationStore: store });
  const sharedDecision = await sanitizeStartupFiles(reused, {
    verificationStore: store,
    policyFingerprint: policy,
    sanitizer: async () => {
      throw new Error("linked worktrees must reuse the shared privacy decision");
    }
  });
  assert.equal(reused.repositoryId, original.repositoryId);
  assert.notEqual(reused.worktreeId, original.worktreeId);
  assert.equal(reused.counters.reads, 0);
  assert.equal(reused.counters.gitBlobReuses, 1);
  assert.equal(sharedDecision.sanitizerCalls, 0);
  assert.equal(calls.count, 1);
  const nongit = await mkdtemp(join(tmpdir(), "privacyai-startup-nongit-")); t.after(() => rm(nongit, { recursive: true, force: true })); await writeFile(join(nongit, "CLAUDE.md"), "ok");
  assert.equal((await resolveStartupFileManifest([join(nongit, "CLAUDE.md")], { cwd: nongit, verificationStore: store })).repo.isGit, false);
});

test("rendered startup proof skips capture and misses on every identity change", async () => {
  const store = new MemoryContextVerificationStore(); let captures = 0;
  const base = { manifestHash: "sha256:manifest", policyFingerprint: policy, protectedArgs: ["--x"], config: { a: 1 }, cwd: process.cwd(), repositoryId: "sha256:repo", worktreeId: "sha256:worktree", executable: { version: "1" }, renderContractVersion: 1 };
  const run = async input => auditCodexStartupContext({ codexPath: "/fake", cwd: process.cwd(), sanitizer: async text => ({ sanitizedPrompt: text, sessionMap: {} }), verificationStore: store, policyFingerprint: policy, renderedFingerprint: renderedStartupFingerprint(input), capture: async () => { captures += 1; return [{ text: "ok", prompt: "canary" }]; }, canaryPlaceholder: "canary", blockHighRisk: false });
  assert.equal((await run(base)).cache.hit, false); assert.equal(captures, 1); assert.equal((await run(base)).cache.hit, true); assert.equal(captures, 1);
  for (const change of [{ protectedArgs: ["--y"] }, { config: { a: 2 } }, { manifestHash: "sha256:other" }, { renderContractVersion: 2 }, { executable: { version: "2" } }, { policyFingerprint: "sha256:other-policy" }]) {
    const value = { ...base, ...change }; await run(value); assert.equal(captures > 1, true);
  }
});

test("dirty tracked files never reuse a stale Git index blob", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-startup-dirty-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFile("git", ["init", root]);
  await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", root, "config", "user.name", "Test"]);
  const file = join(root, "AGENTS.md");
  await writeFile(file, "committed");
  await execFile("git", ["-C", root, "add", "AGENTS.md"]);
  await execFile("git", ["-C", root, "commit", "-m", "init"]);

  const store = new MemoryContextVerificationStore();
  const committed = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store });
  await writeFile(file, "dirty-worktree-value");
  const dirty = await resolveStartupFileManifest([file], { cwd: root, verificationStore: store });

  assert.equal(dirty.counters.gitBlobReuses, 0);
  assert.equal(dirty.counters.reads, 1);
  assert.notEqual(dirty.records[0].contentHash, committed.records[0].contentHash);
});

test("per-file sanitizer mappings are rebased when placeholders collide", async () => {
  const store = new MemoryContextVerificationStore();
  let call = 0;
  const manifest = {
    records: [
      { path: "/one", pathHash: "sha256:path-one", contentHash: "sha256:content-one", content: "one" },
      { path: "/two", pathHash: "sha256:path-two", contentHash: "sha256:content-two", content: "two" }
    ]
  };
  const result = await sanitizeStartupFiles(manifest, {
    verificationStore: store,
    policyFingerprint: policy,
    sanitizer: async () => ({
      sessionMap: { "[EMAIL_1]": call++ === 0 ? "one@example.test" : "two@example.test" }
    })
  });

  assert.deepEqual(Object.values(result.sessionMapAdditions).sort(), [
    "one@example.test",
    "two@example.test"
  ]);
  assert.equal(new Set(Object.keys(result.sessionMapAdditions)).size, 2);
});
