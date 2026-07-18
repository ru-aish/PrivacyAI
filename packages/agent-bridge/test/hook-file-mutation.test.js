import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MemoryContextVerificationStore,
  commitHookFileMutation,
  hookFileMutationId,
  openContextVerificationStore,
  resolveStartupFileManifest,
  rollbackHookFileMutation,
  sanitizeStartupFiles,
  stageHookFileMutation,
  startupFileVerificationKey
} from "../src/index.js";

const policyFingerprint = "sha256:hook-file-policy";
const sessionMap = { "[LOCATION_1]": "private-workspace-name" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "privacyai-hook-mutation-"));
  await mkdir(join(root, ".git"), { recursive: true });
  return { root, store: new MemoryContextVerificationStore() };
}

function writeEvent(root, content = "workspace=private-workspace-name\n") {
  return {
    hook_event_name: "PreToolUse",
    session_id: "session-1",
    tool_use_id: "tool-write-1",
    tool_name: "Write",
    cwd: root,
    tool_input: { file_path: "CLAUDE.md", content }
  };
}

test("structured Write stages, verifies, and seeds exact startup reuse", async () => {
  const { root, store } = await fixture();
  const event = writeEvent(root);
  const path = join(root, "CLAUDE.md");

  const staged = await stageHookFileMutation(event, { store, sessionMap });
  assert.equal(staged.status, "pending");
  assert.equal(staged.stagedCount, 1);
  const mutationId = hookFileMutationId(event, path);
  assert.equal(store.getFileMutation(mutationId).status, "pending");
  assert.equal(JSON.stringify(store.getFileMutation(mutationId)).includes("private-workspace-name"), false);

  await writeFile(path, event.tool_input.content);
  const committed = await commitHookFileMutation(
    { ...event, hook_event_name: "PostToolUse" },
    { store, sessionMap, policyFingerprint }
  );
  assert.equal(committed.status, "committed");
  const mutation = store.getFileMutation(mutationId);
  assert.equal(mutation.status, "committed");

  const plan = store.getPrivacyPlan(mutation.nextContentHash, policyFingerprint);
  assert.deepEqual(plan.spans.map(span => [span.start, span.end, span.classification]), [
    [10, 32, "location"]
  ]);
  const cached = store.getVerification(
    startupFileVerificationKey(mutation.nextContentHash, policyFingerprint),
    policyFingerprint
  );
  assert.equal(cached.artifactType, "startup_static_file_plan");
  assert.deepEqual(cached.sessionMapAdditions, {});

  const manifest = await resolveStartupFileManifest([path], {
    cwd: root,
    verificationStore: store
  });
  const reused = await sanitizeStartupFiles(manifest, {
    verificationStore: store,
    policyFingerprint,
    sanitizer: async () => {
      throw new Error("opaque plan reuse must not call the local model");
    }
  });
  assert.equal(reused.sanitizerCalls, 0);
  assert.deepEqual(reused.sessionMapAdditions, sessionMap);
});

test("mutation plan reuse keeps private originals out of SQLite and WAL", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-hook-ledger-private-"));
  const workspace = join(root, "workspace");
  const dbPath = join(root, "context.sqlite3");
  const secret = "mutation-private-value-DO-NOT-PERSIST";
  await mkdir(join(workspace, ".git"), { recursive: true });
  const store = await openContextVerificationStore({ verificationDbPath: dbPath });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const event = {
    hook_event_name: "PreToolUse",
    session_id: "session-private-ledger",
    tool_use_id: "tool-private-ledger",
    tool_name: "Write",
    cwd: workspace,
    tool_input: { file_path: "CLAUDE.md", content: "value=" + secret + "\n" }
  };
  const map = { "[PRIVATE_VALUE_1]": secret };
  await stageHookFileMutation(event, { store, sessionMap: map });
  const path = join(workspace, "CLAUDE.md");
  await writeFile(path, event.tool_input.content);
  await commitHookFileMutation(
    { ...event, hook_event_name: "PostToolUse" },
    { store, sessionMap: map, policyFingerprint }
  );

  const mutation = store.getFileMutation(hookFileMutationId(event, path));
  const proof = store.getVerification(
    startupFileVerificationKey(mutation.nextContentHash, policyFingerprint),
    policyFingerprint
  );
  assert.equal(proof.artifactType, "startup_static_file_plan");
  assert.deepEqual(proof.sessionMapAdditions, {});

  const manifest = await resolveStartupFileManifest([path], {
    cwd: workspace,
    verificationStore: store
  });
  const reuse = await sanitizeStartupFiles(manifest, {
    verificationStore: store,
    policyFingerprint,
    sanitizer: async () => {
      throw new Error("verified opaque plans must bypass the local model");
    }
  });
  assert.equal(reuse.sanitizerCalls, 0);
  assert.deepEqual(Object.values(reuse.sessionMapAdditions), [secret]);

  for (const candidate of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    let bytes;
    try {
      bytes = await readFile(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    assert.equal(bytes.includes(Buffer.from(secret)), false, candidate);
  }
});

test("Edit seeds a complete result only when the source was already verified", async () => {
  const { root, store } = await fixture();
  const path = join(root, "CLAUDE.md");
  await writeFile(path, "name=public\n");
  const event = {
    hook_event_name: "PreToolUse",
    session_id: "session-2",
    tool_use_id: "tool-edit-1",
    tool_name: "Edit",
    cwd: root,
    tool_input: {
      file_path: path,
      old_string: "public",
      new_string: "private-workspace-name"
    }
  };

  await stageHookFileMutation(event, { store, sessionMap });
  const mutationId = hookFileMutationId(event, path);
  const staged = store.getFileMutation(mutationId);
  await writeFile(path, "name=private-workspace-name\n");
  await commitHookFileMutation(
    { ...event, hook_event_name: "PostToolUse" },
    { store, sessionMap, policyFingerprint }
  );
  const firstResult = store.getFileMutation(mutationId);
  assert.equal(firstResult.status, "committed");
  assert.equal(
    store.getVerification(
      startupFileVerificationKey(firstResult.nextContentHash, policyFingerprint),
      policyFingerprint
    ),
    undefined
  );

  const nextEvent = {
    ...event,
    tool_use_id: "tool-edit-2",
    tool_input: {
      file_path: path,
      old_string: "private-workspace-name",
      new_string: "private-workspace-name-v2"
    }
  };
  store.putVerification({
    cacheKey: startupFileVerificationKey(firstResult.nextContentHash, policyFingerprint),
    contentHash: firstResult.nextContentHash,
    artifactType: "startup_static_file",
    policyFingerprint,
    sessionMapAdditions: sessionMap
  });
  await stageHookFileMutation(nextEvent, { store, sessionMap });
  await writeFile(path, "name=private-workspace-name-v2\n");
  await commitHookFileMutation(
    { ...nextEvent, hook_event_name: "PostToolUse" },
    { store, sessionMap, policyFingerprint }
  );
  const second = store.getFileMutation(hookFileMutationId(nextEvent, path));
  const proof = store.getVerification(
    startupFileVerificationKey(second.nextContentHash, policyFingerprint),
    policyFingerprint
  );
  assert.equal(proof.artifactType, "startup_static_file_plan");
  assert.deepEqual(proof.sessionMapAdditions, {});
  assert.equal(staged.operationType, "replace_in_file");
});

test("hash mismatches roll back and failed tool events remove pending reuse", async () => {
  const { root, store } = await fixture();
  const path = join(root, "CLAUDE.md");
  const mismatchEvent = writeEvent(root, "expected\n");
  await stageHookFileMutation(mismatchEvent, { store, sessionMap });
  await writeFile(path, "different\n");
  const mismatch = await commitHookFileMutation(
    { ...mismatchEvent, hook_event_name: "PostToolUse" },
    { store, sessionMap, policyFingerprint }
  );
  assert.equal(mismatch.results[0].status, "mismatch");
  assert.equal(store.getFileMutation(hookFileMutationId(mismatchEvent, path)).status, "rolled_back");

  const failedEvent = {
    ...writeEvent(root, "another\n"),
    tool_use_id: "tool-write-failed"
  };
  await stageHookFileMutation(failedEvent, { store, sessionMap });
  const rolledBack = rollbackHookFileMutation(
    { ...failedEvent, hook_event_name: "PostToolUseFailure" },
    { store, toolInput: failedEvent.tool_input }
  );
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(store.getFileMutation(hookFileMutationId(failedEvent, path)).status, "rolled_back");
});

test("MultiEdit and multi-file apply_patch commit exact predicted results", async () => {
  const { root, store } = await fixture();
  const multiPath = join(root, "multi.txt");
  await writeFile(multiPath, "one two three\n");
  const multiEvent = {
    hook_event_name: "PreToolUse",
    session_id: "session-multi",
    tool_use_id: "tool-multi",
    tool_name: "MultiEdit",
    cwd: root,
    tool_input: {
      file_path: multiPath,
      edits: [
        { old_string: "one", new_string: "ONE" },
        { old_string: "three", new_string: "private-workspace-name" }
      ]
    }
  };
  assert.equal((await stageHookFileMutation(multiEvent, { store, sessionMap })).status, "pending");
  await writeFile(multiPath, "ONE two private-workspace-name\n");
  assert.equal((await commitHookFileMutation({ ...multiEvent, hook_event_name: "PostToolUse" }, {
    store,
    sessionMap,
    policyFingerprint
  })).status, "committed");

  const updatePath = join(root, "update.txt");
  const deletePath = join(root, "delete.txt");
  await writeFile(updatePath, "before\n");
  await writeFile(deletePath, "remove me\n");
  const patch = [
    "*** Begin Patch",
    "*** Update File: update.txt",
    "@@",
    "-before",
    "+private-workspace-name",
    "*** Add File: added.txt",
    "+added private-workspace-name",
    "*** Delete File: delete.txt",
    "*** End Patch"
  ].join("\n");
  const patchEvent = {
    hook_event_name: "PreToolUse",
    session_id: "session-patch",
    tool_use_id: "tool-patch",
    tool_name: "apply_patch",
    cwd: root,
    tool_input: { patch }
  };
  const staged = await stageHookFileMutation(patchEvent, { store, sessionMap });
  assert.equal(staged.stagedCount, 3);
  await writeFile(updatePath, "private-workspace-name\n");
  await writeFile(join(root, "added.txt"), "added private-workspace-name\n");
  await import("node:fs/promises").then(({ rm }) => rm(deletePath));
  const committed = await commitHookFileMutation({ ...patchEvent, hook_event_name: "PostToolUse" }, {
    store,
    sessionMap,
    policyFingerprint
  });
  assert.equal(committed.committedCount, 3);
  assert.equal(store.getFileMutation(hookFileMutationId(patchEvent, updatePath)).operationType, "apply_patch");
  assert.equal(store.getFileMutation(hookFileMutationId(patchEvent, join(root, "added.txt"))).operationType, "write_file");
  assert.equal(store.getFileMutation(hookFileMutationId(patchEvent, deletePath)).status, "committed");
});

test("malformed or ambiguous apply_patch input is not recorded", async () => {
  const { root, store } = await fixture();
  await writeFile(join(root, "duplicate.txt"), "same\nsame\n");
  const result = await stageHookFileMutation({
    hook_event_name: "PreToolUse",
    session_id: "session-patch-bad",
    tool_use_id: "tool-patch-bad",
    tool_name: "apply_patch",
    cwd: root,
    tool_input: { patch: "*** Begin Patch\n*** Update File: duplicate.txt\n@@\n-same\n+next\n*** End Patch" }
  }, { store, sessionMap });
  assert.equal(result.status, "unsupported");

  const traversal = await stageHookFileMutation({
    hook_event_name: "PreToolUse",
    session_id: "session-patch-traversal",
    tool_use_id: "tool-patch-traversal",
    tool_name: "apply_patch",
    cwd: root,
    tool_input: {
      patch: "*** Begin Patch\n*** Add File: ../outside.txt\n+blocked\n*** End Patch"
    }
  }, { store, sessionMap });
  assert.equal(traversal.status, "unsupported");
});

test("ambiguous edits and opaque shell commands are not recorded", async () => {
  const { root, store } = await fixture();
  const path = join(root, "file.txt");
  await writeFile(path, "same same");
  const ambiguous = await stageHookFileMutation({
    hook_event_name: "PreToolUse",
    session_id: "session-3",
    tool_use_id: "tool-edit-ambiguous",
    tool_name: "Edit",
    cwd: root,
    tool_input: { file_path: path, old_string: "same", new_string: "next" }
  }, { store, sessionMap });
  assert.equal(ambiguous.status, "unsupported");

  const shell = await stageHookFileMutation({
    hook_event_name: "PreToolUse",
    session_id: "session-3",
    tool_use_id: "tool-shell",
    tool_name: "Bash",
    cwd: root,
    tool_input: { command: "printf private > file.txt" }
  }, { store, sessionMap });
  assert.equal(shell.status, "unsupported");
});
