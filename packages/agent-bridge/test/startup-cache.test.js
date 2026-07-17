import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { MemoryContextVerificationStore } from "../src/context-verification-store.js";
import { auditCodexStartupContext } from "../src/startup-audit.js";
import { renderedStartupFingerprint, resolveStartupFileManifest, sanitizeStartupFiles } from "../src/startup-cache.js";

const execFile = promisify(execFileCallback);
const policy = "sha256:test-policy";
const sanitizer = calls => async () => { calls.count += 1; return { sessionMap: {} }; };

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
  const store = new MemoryContextVerificationStore(); await resolveStartupFileManifest([join(root, "AGENTS.md")], { cwd: root, verificationStore: store });
  const reused = await resolveStartupFileManifest([join(other, "AGENTS.md")], { cwd: other, verificationStore: store }); assert.equal(reused.counters.reads, 0); assert.equal(reused.counters.gitBlobReuses, 1);
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
