import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SessionVault,
  processHookEvent,
  restoreValue,
  sanitizeKnownValue,
  sanitizeModelVisibleValue
} from "../src/index.js";

const AGENT_HOOK = fileURLToPath(new URL("../bin/privacyai-agent-hook.js", import.meta.url));

const sessionMap = {
  "[PERSON_1]": "Ada Lovelace",
  "[API_KEY_1]": "sk-local-secret"
};

const passThroughSanitizer = async text => ({ sanitizedPrompt: text, sessionMap: {} });

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

test("context gateway skips meaningless top-level null and boolean results", async () => {
  let sanitizerCalls = 0;
  const sanitizer = async text => {
    sanitizerCalls += 1;
    return { sanitizedPrompt: text, sessionMap: {} };
  };

  for (const value of [null, true, false]) {
    assert.deepEqual(await sanitizeModelVisibleValue(value, { sanitizer }), {
      value,
      sessionMapAdditions: {},
      changed: false
    });
  }
  assert.equal(sanitizerCalls, 0);
});

test("PreToolUse returns a Claude/Codex-compatible updatedInput envelope", async () => {
  const result = await processHookEvent(
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

test("Codex defaults to prompt-only isolation before every tool call", async () => {
  const result = await processHookEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" }
    },
    { sessionMap: {}, flavor: "codex" }
  );

  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /prompt-only isolation/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /failed, cancelled, deferred/);
});

test("PreToolUse restores Gmail and arbitrary MCP tool arguments", async () => {
  const allToolMap = {
    "contact1@example.com": "intended.recipient@example.test",
    "[API_KEY_1]": "real-local-secret"
  };

  const gmail = await processHookEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "codex_apps.gmail.send_email",
      tool_input: {
        to: "contact1@example.com",
        subject: "hi",
        body: "hi"
      }
    },
    { sessionMap: allToolMap, flavor: "codex", toolPolicy: "gateway" }
  );
  assert.deepEqual(gmail.hookSpecificOutput.updatedInput, {
    to: "intended.recipient@example.test",
    subject: "hi",
    body: "hi"
  });

  const mcp = await processHookEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "mcp__example__create_record",
      tool_input: {
        records: [
          { owner: "contact1@example.com", credentials: { token: "[API_KEY_1]" } }
        ]
      }
    },
    { sessionMap: allToolMap, flavor: "claude" }
  );
  assert.deepEqual(mcp.hookSpecificOutput.updatedInput, {
    records: [
      {
        owner: "intended.recipient@example.test",
        credentials: { token: "real-local-secret" }
      }
    ]
  });

  const codexAppWrapper = await processHookEvent(
    {
      hook_event_name: "PreToolUse",
      tool_name: "exec",
      tool_input: {
        input:
          'const r = await tools.mcp__codex_apps__gmail_send_email({to:"contact1@example.com",subject:"hi",body:"hi"});'
      }
    },
    { sessionMap: allToolMap, flavor: "codex", toolPolicy: "gateway" }
  );
  assert.equal(
    codexAppWrapper.hookSpecificOutput.updatedInput.input.includes(
      'to:"intended.recipient@example.test"'
    ),
    true
  );
  assert.equal(
    codexAppWrapper.hookSpecificOutput.updatedInput.input.includes("contact1@example.com"),
    false
  );
});

test("PostToolUse sanitizes arbitrary MCP tool output", async () => {
  const result = await processHookEvent(
    {
      hook_event_name: "PostToolUse",
      tool_name: "mcp__example__lookup_record",
      tool_response: {
        recipient: "intended.recipient@example.test",
        nested: ["real-local-secret"]
      }
    },
    {
      flavor: "claude",
      sessionMap: {
        "contact1@example.com": "intended.recipient@example.test",
        "[API_KEY_1]": "real-local-secret"
      },
      sanitizer: passThroughSanitizer
    }
  );

  assert.deepEqual(result.hookSpecificOutput.updatedToolOutput, {
    recipient: "contact1@example.com",
    nested: ["[API_KEY_1]"]
  });
});

test("PreToolUse fails closed when placeholders cannot be resolved", async () => {
  const result = await processHookEvent(
    {
      hook_event_name: "PreToolUse",
      tool_input: { command: "printf [EMAIL_7]" }
    },
    { sessionMap: {}, flavor: "claude" }
  );

  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /could not be resolved/);
});

test("Claude PostToolUse preserves structured output shape", async () => {
  const result = await processHookEvent(
    {
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "Ada Lovelace", code: 0 }
    },
    { sessionMap, flavor: "claude", sanitizer: passThroughSanitizer }
  );

  assert.deepEqual(result, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { stdout: "[PERSON_1]", code: 0 }
    }
  });
});

test("Claude PostToolBatch fails closed when a failed result still contains a known original", async () => {
  const result = await processHookEvent(
    {
      hook_event_name: "PostToolBatch",
      tool_calls: [
        {
          tool_name: "mcp__example__send_mail",
          tool_input: { to: "intended.recipient@example.test" },
          tool_use_id: "toolu_test",
          error: "Delivery failed for intended.recipient@example.test"
        }
      ]
    },
    {
      flavor: "claude",
      sessionMap: { "contact1@example.com": "intended.recipient@example.test" },
      sanitizer: passThroughSanitizer
    }
  );

  assert.equal(result.continue, false);
  assert.match(result.stopReason, /failed, cancelled, or batched tool result/);
});

test("Claude PostToolBatch ignores restored tool inputs after outputs were sanitized", async () => {
  const result = await processHookEvent(
    {
      hook_event_name: "PostToolBatch",
      tool_calls: [
        {
          tool_name: "mcp__example__send_mail",
          tool_input: { to: "intended.recipient@example.test" },
          tool_use_id: "toolu_test",
          tool_response: "Fake mail recorded for contact1@example.com"
        }
      ]
    },
    {
      flavor: "claude",
      sessionMap: { "contact1@example.com": "intended.recipient@example.test" },
      sanitizer: passThroughSanitizer
    }
  );

  assert.equal(result, null);
});

test("Codex PostToolUse uses sanitized feedback replacement", async () => {
  const result = await processHookEvent(
    {
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "Ada Lovelace", code: 0 }
    },
    { sessionMap, flavor: "codex", sanitizer: passThroughSanitizer, toolPolicy: "gateway" }
  );

  assert.equal(result.continue, false);
  assert.equal(result.reason, '{"stdout":"[PERSON_1]","code":0}');
  assert.doesNotMatch(result.reason, /Ada Lovelace/);
});


test("PostToolUse discovers new private values in JSON keys and persists one stable mapping", async () => {
  const additions = [];
  const result = await processHookEvent(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_response: {
        "fresh.secret@example.test": "owner=fresh.secret@example.test",
        nested: ["fresh.secret@example.test"]
      }
    },
    {
      flavor: "claude",
      sessionMap: {},
      sanitizer: async text => ({
        sanitizedPrompt: text.split("fresh.secret@example.test").join("[EMAIL_1]"),
        sessionMap: { "[EMAIL_1]": "fresh.secret@example.test" }
      }),
      onSessionMapAdditions: async value => additions.push(value)
    }
  );

  assert.deepEqual(result.hookSpecificOutput.updatedToolOutput, {
    "[EMAIL_1]": "owner=[EMAIL_1]",
    nested: ["[EMAIL_1]"]
  });
  assert.deepEqual(additions, [{ "[EMAIL_1]": "fresh.secret@example.test" }]);
});

test("failed tool events discover new private values and stop before another model request", async () => {
  const additions = [];
  const result = await processHookEvent(
    {
      hook_event_name: "PostToolUseFailure",
      session_id: "failure-session",
      tool_name: "Bash",
      tool_input: { command: "false" },
      stderr: "Authorization failed for sk-new-output-secret",
      error: "exit 1"
    },
    {
      flavor: "codex",
      sessionMap: {},
      sanitizer: async text => ({
        sanitizedPrompt: text.replace("sk-new-output-secret", "[API_KEY_1]"),
        sessionMap: { "[API_KEY_1]": "sk-new-output-secret" }
      }),
      onSessionMapAdditions: async value => additions.push(value)
    }
  );

  assert.equal(result.continue, false);
  assert.match(result.stopReason, /failed, cancelled, or batched tool result/);
  assert.deepEqual(additions, [{ "[API_KEY_1]": "sk-new-output-secret" }]);
});

test("context gateway fails closed when sanitization corrupts structured output", async () => {
  await assert.rejects(
    processHookEvent(
      {
        hook_event_name: "PostToolUse",
        tool_response: { secret: "new-private-value" }
      },
      {
        flavor: "claude",
        sessionMap: {},
        sanitizer: async () => ({
          sanitizedPrompt: "not-json",
          sessionMap: { "[PRIVATE_VALUE_1]": "new-private-value" }
        }),
        onSessionMapAdditions: async () => {}
      }
    ),
    error => error?.code === "PRIVACYAI_INVALID_SANITIZED_CONTEXT"
  );
});

test("context gateway rejects oversized atomic tool results instead of partially scanning them", async () => {
  await assert.rejects(
    processHookEvent(
      {
        hook_event_name: "PostToolUse",
        tool_response: "x".repeat(64)
      },
      {
        flavor: "claude",
        sessionMap: {},
        maxContextChars: 32,
        sanitizer: passThroughSanitizer
      }
    ),
    error => error?.code === "PRIVACYAI_CONTEXT_TOO_LARGE"
  );
});

test("agent hook executable denies Codex tools in strict prompt-only mode", async () => {
  const result = await runHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "strict-codex-session",
      tool_name: "Bash",
      tool_input: { command: "pwd" }
    },
    { ...process.env, PRIVACYAI_AGENT_FLAVOR: "codex" }
  );

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /prompt-only isolation/);
});

test("agent hook executable fails closed before processing events without a session id", async () => {
  const result = await runHook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" }
    },
    { ...process.env, PRIVACYAI_AGENT_FLAVOR: "claude" }
  );

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /PrivacyAI agent hook blocked processing/);
  assert.doesNotMatch(result.stderr, /session_id/);
});

test("agent hook executable restores Claude tool inputs and sanitizes arbitrary outputs", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "privacyai-all-tool-hook-"));
  const sessionId = "all-tool-executable-session";
  const vault = new SessionVault({ baseDir });
  await vault.save(sessionId, {
    "contact1@example.com": "intended.recipient@example.test",
    "[PRIVATE_VALUE_1]": "private-body-value"
  });

  const env = {
    ...process.env,
    PRIVACYAI_AGENT_VAULT_DIR: baseDir,
    PRIVACYAI_AGENT_FLAVOR: "claude"
  };
  const pre = await runHook(
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "codex_apps.gmail.send_email",
      tool_input: {
        to: "contact1@example.com",
        subject: "hi",
        body: "[PRIVATE_VALUE_1]"
      }
    },
    env
  );
  assert.equal(pre.code, 0, pre.stderr);
  assert.deepEqual(JSON.parse(pre.stdout).hookSpecificOutput.updatedInput, {
    to: "intended.recipient@example.test",
    subject: "hi",
    body: "private-body-value"
  });

  const post = await runHook(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "mcp__example__lookup",
      tool_response: {
        recipient: "intended.recipient@example.test",
        body: "private-body-value"
      }
    },
    { ...env, PRIVACYAI_AGENT_FLAVOR: "claude" }
  );
  assert.equal(post.code, 0, post.stderr);
  assert.deepEqual(JSON.parse(post.stdout).hookSpecificOutput.updatedToolOutput, {
    recipient: "contact1@example.com",
    body: "[PRIVATE_VALUE_1]"
  });
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


test("SessionVault serializes concurrent map extensions without losing updates", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "privacyai-agent-vault-race-"));
  const vault = new SessionVault({ baseDir });
  const sessionId = "parallel-session";

  await Promise.all([
    vault.merge(sessionId, { "[EMAIL_1]": "first@example.test" }),
    vault.merge(sessionId, { "[API_KEY_1]": "sk-parallel-secret" }),
    vault.merge(sessionId, { "[PERSON_1]": "Parallel Person" })
  ]);

  assert.deepEqual((await vault.load(sessionId)).sessionMap, {
    "[EMAIL_1]": "first@example.test",
    "[API_KEY_1]": "sk-parallel-secret",
    "[PERSON_1]": "Parallel Person"
  });
});

function runHook(event, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_HOOK], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", code => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}
