import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SessionVault,
  processHookEvent,
  restoreValue,
  sanitizeKnownValue
} from "../src/index.js";

const sessionMap = {
  "[PERSON_1]": "Ada Lovelace",
  "[API_KEY_1]": "sk-local-secret"
};

test("recursively restores tool arguments without changing object keys", () => {
  const input = {
    command: "echo [PERSON_1]",
    nested: ["[API_KEY_1]", { path: "/tmp/[PERSON_1]" }]
  };

  assert.deepEqual(restoreValue(input, sessionMap), {
    command: "echo Ada Lovelace",
    nested: ["sk-local-secret", { path: "/tmp/Ada Lovelace" }]
  });
});

test("recursively sanitizes known originals in tool output", () => {
  const output = {
    stdout: "Ada Lovelace used sk-local-secret",
    metadata: ["owner=Ada Lovelace"]
  };

  assert.deepEqual(sanitizeKnownValue(output, sessionMap), {
    stdout: "[PERSON_1] used [API_KEY_1]",
    metadata: ["owner=[PERSON_1]"]
  });
});

test("PreToolUse returns a Claude/Codex-compatible updatedInput envelope", () => {
  const result = processHookEvent(
    {
      hook_event_name: "PreToolUse",
      tool_input: { command: "printf [PERSON_1]" }
    },
    { sessionMap, flavor: "claude" }
  );

  assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(result.hookSpecificOutput.updatedInput, {
    command: "printf Ada Lovelace"
  });
});

test("PreToolUse fails closed when placeholders cannot be resolved", () => {
  const result = processHookEvent(
    {
      hook_event_name: "PreToolUse",
      tool_input: { command: "printf [EMAIL_7]" }
    },
    { sessionMap: {}, flavor: "claude" }
  );

  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /could not be resolved/);
});

test("Claude PostToolUse preserves structured output shape", () => {
  const result = processHookEvent(
    {
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "Ada Lovelace", code: 0 }
    },
    { sessionMap, flavor: "claude" }
  );

  assert.deepEqual(result, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { stdout: "[PERSON_1]", code: 0 }
    }
  });
});

test("Codex PostToolUse uses sanitized feedback replacement", () => {
  const result = processHookEvent(
    {
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "Ada Lovelace", code: 0 }
    },
    { sessionMap, flavor: "codex" }
  );

  assert.equal(result.continue, false);
  assert.equal(result.reason, '{"stdout":"[PERSON_1]","code":0}');
  assert.doesNotMatch(result.reason, /Ada Lovelace/);
});

test("SessionVault hashes session ids and writes private files", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "privacyai-agent-vault-"));
  const vault = new SessionVault({ baseDir });
  const saved = await vault.save("../../unsafe/session", sessionMap);

  assert.equal(saved.path.startsWith(baseDir), true);
  assert.equal(saved.path.includes("unsafe"), false);
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600);

  const loaded = JSON.parse(await readFile(saved.path, "utf8"));
  assert.deepEqual(loaded.sessionMap, sessionMap);
});
