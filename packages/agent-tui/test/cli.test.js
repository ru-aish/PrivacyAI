import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLI_EXIT_CODES,
  runPrivacyAiCli
} from "../src/cli.js";

const CLI = fileURLToPath(new URL("../bin/privacyai.js", import.meta.url));

test("help and version expose the canonical product shell", async () => {
  const output = capture();
  const code = await runPrivacyAiCli(["--help"], { stdout: output.stream });
  assert.equal(code, CLI_EXIT_CODES.success);
  assert.match(output.text(), /privacyai agent <name>/);
  assert.match(output.text(), /privacyai cache/);
  assert.match(output.text(), /privacyai lineage/);
  assert.match(output.text(), /Compatibility aliases/);

  const version = capture();
  assert.equal(
    await runPrivacyAiCli(["--version"], { stdout: version.stream, version: "9.8.7" }),
    CLI_EXIT_CODES.success
  );
  assert.equal(version.text(), "privacyai 9.8.7\n");
});

test("canonical agent routing and direct compatibility aliases preserve arguments", async () => {
  const calls = [];
  const bridgeCli = {
    runPrivacyAiCli: async (argv, options) => {
      calls.push({ argv, options });
      return 0;
    }
  };
  const streams = ttyStreams();

  assert.equal(
    await runPrivacyAiCli(["agent", "codex", "resume", "thread-1"], {
      ...streams,
      bridgeCli
    }),
    0
  );
  assert.equal(
    await runPrivacyAiCli(["claude", "--continue"], { ...streams, bridgeCli }),
    0
  );
  assert.equal(
    await runPrivacyAiCli(["antigravity", "--print", "hello"], {
      ...streams,
      bridgeCli
    }),
    0
  );

  assert.deepEqual(calls.map(call => call.argv), [
    ["codex", "resume", "thread-1"],
    ["claude", "--continue"],
    ["antigravity", "--print", "hello"]
  ]);
});

test("agent delegation propagates child exits and contains asynchronous failures", async () => {
  const streams = ttyStreams();
  assert.equal(
    await runPrivacyAiCli(["agent", "codex"], {
      ...streams,
      bridgeCli: { runPrivacyAiCli: async () => 143 }
    }),
    143
  );

  const stdout = capture();
  const stderr = capture();
  const code = await runPrivacyAiCli(["agent", "agy", "--print", "hello"], {
    stdin: ttyInput(),
    stdout: stdout.stream,
    stderr: stderr.stream,
    bridgeCli: {
      runPrivacyAiCli: async () => {
        throw new Error("Agent launch failed safely.");
      }
    }
  });
  assert.equal(code, CLI_EXIT_CODES.failure);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "Agent launch failed safely.\n");
});

test("invalid commands use stderr and the stable usage exit code", async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runPrivacyAiCli(["agent", "unknown"], {
    stdout: stdout.stream,
    stderr: stderr.stream
  });
  assert.equal(code, CLI_EXIT_CODES.usage);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /Unknown PrivacyAI agent/);
  assert.match(stderr.text(), /privacyai --help/);
});

test("onboarding fails fast outside a TTY without invoking the bridge", async () => {
  let invoked = false;
  const stdout = capture(false);
  const stderr = capture(false);
  const stdin = new PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: false });
  const code = await runPrivacyAiCli(["onboard"], {
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    bridgeCli: {
      runPrivacyAiCli: async () => {
        invoked = true;
        return 0;
      }
    }
  });
  assert.equal(code, CLI_EXIT_CODES.usage);
  assert.equal(invoked, false);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /requires an interactive terminal/);
});

test("doctor reports missing configuration with exit code 3 and JSON on stdout", async () => {
  const stdout = capture();
  const stderr = capture();
  const bridgeModule = {
    loadPrivacyConfig: async () => ({
      configured: false,
      path: "/tmp/privacyai-config.json",
      config: null
    }),
    checkPrivacyModel: async () => {
      throw new Error("model check must not run without configuration");
    },
    resolveExecutable: async () => null,
    verifyNativeExecutable: async () => ({ version: null })
  };

  const code = await runPrivacyAiCli(["doctor", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    bridgeModule
  });
  assert.equal(code, CLI_EXIT_CODES.configurationRequired);
  assert.equal(stderr.text(), "");
  const result = JSON.parse(stdout.text());
  assert.equal(result.ok, false);
  assert.equal(result.configuration.configured, false);
});

test("doctor distinguishes broken installed agents from absent optional agents", async () => {
  const stdout = capture();
  const bridgeModule = {
    loadPrivacyConfig: async () => ({
      configured: true,
      path: "/tmp/privacyai-config.json",
      config: { provider: "ollama", model: "local-model" }
    }),
    checkPrivacyModel: async () => ({ ok: true }),
    resolveExecutable: async name => name === "codex" ? "/usr/bin/codex" : null,
    verifyNativeExecutable: async () => {
      throw new Error("Codex is broken safely.");
    }
  };
  const code = await runPrivacyAiCli(["doctor", "--json"], {
    stdout: stdout.stream,
    bridgeModule
  });
  assert.equal(code, CLI_EXIT_CODES.failure);
  const result = JSON.parse(stdout.text());
  assert.equal(result.agents.find(agent => agent.name === "codex").ok, false);
  assert.equal(result.agents.find(agent => agent.name === "claude").installed, false);
});

test("doctor isolates executable discovery failures per agent", async () => {
  const stdout = capture();
  const stderr = capture();
  const bridgeModule = {
    loadPrivacyConfig: async () => ({
      configured: true,
      path: "/tmp/privacyai-config.json",
      config: { provider: "ollama", model: "local-model" }
    }),
    checkPrivacyModel: async () => ({ ok: true }),
    resolveExecutable: async name => {
      if (name === "claude") throw new Error("Executable discovery failed safely.");
      return null;
    },
    verifyNativeExecutable: async () => ({ version: null })
  };

  const code = await runPrivacyAiCli(["doctor", "--json"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    bridgeModule
  });
  assert.equal(code, CLI_EXIT_CODES.failure);
  assert.equal(stderr.text(), "");
  const result = JSON.parse(stdout.text());
  const claude = result.agents.find(agent => agent.name === "claude");
  assert.equal(claude.installed, false);
  assert.equal(claude.ok, false);
  assert.equal(claude.reason, "Executable discovery failed safely.");
});

test("cache and lineage inspection keep metadata on stdout and close the service", async () => {
  let closeCount = 0;
  const inspectionService = {
    inspectCache: async request => ({
      schemaVersion: 3,
      entries: [{
        cache_key: "cache-hash",
        content_hash: "content-hash",
        artifact_type: "prompt",
        policy_fingerprint: "policy-hash",
        created_at: 1,
        last_used_at: 2,
        hit_count: 3
      }],
      request
    }),
    inspectLineage: async request => ({
      schemaVersion: 3,
      mutations: [{
        mutation_id: "mutation-hash",
        status: "committed",
        operation_type: "write"
      }],
      request
    }),
    close: async () => { closeCount += 1; }
  };

  const cache = capture();
  assert.equal(
    await runPrivacyAiCli(["cache", "list", "--limit", "5", "--json"], {
      stdout: cache.stream,
      inspectionService
    }),
    0
  );
  assert.match(cache.text(), /cache-hash/);
  assert.doesNotMatch(cache.text(), /private@example\.test/);

  const lineage = capture();
  assert.equal(
    await runPrivacyAiCli(["lineage", "mutations", "--json"], {
      stdout: lineage.stream,
      inspectionService
    }),
    0
  );
  assert.match(lineage.text(), /mutation-hash/);
  assert.equal(closeCount, 0, "injected services remain caller-owned");
});

test("missing inspection records use exit code 4 and stderr only", async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await runPrivacyAiCli(["cache", "show", "missing"], {
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectionService: {
      inspectCache: async () => ({ entry: null })
    }
  });
  assert.equal(code, CLI_EXIT_CODES.notFound);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "Cache entry not found.\n");
});

test("corrupt inspection state uses exit code 1 and stderr only", async t => {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    if (error?.code === "ERR_UNKNOWN_BUILTIN_MODULE" || error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip("node:sqlite is unavailable");
      return;
    }
    throw error;
  }

  const root = await mkdtemp(join(tmpdir(), "privacyai-cli-corrupt-inspection-"));
  const path = join(root, "context.sqlite3");
  const privateValue = "not-json-private@example.test";
  const publicMessage = "PrivacyAI local state contains invalid inspection metadata.";
  t.after(() => rm(root, { recursive: true, force: true }));

  const database = new sqlite.DatabaseSync(path);
  database.exec(`
    CREATE TABLE privacyai_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE threads(
      session_key TEXT PRIMARY KEY,
      parent_keys_json TEXT NOT NULL,
      session_map_json TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE verified_items(
      cache_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      policy_fingerprint TEXT NOT NULL,
      additions_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      hit_count INTEGER NOT NULL
    );
    CREATE TABLE thread_items(
      session_key TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE ledger_worktrees(worktree_id TEXT PRIMARY KEY);
    CREATE TABLE ledger_manifests(manifest_hash TEXT PRIMARY KEY);
    CREATE TABLE ledger_file_mutations(mutation_id TEXT PRIMARY KEY);
  `);
  database.prepare("INSERT INTO privacyai_meta(key,value) VALUES('schema_version','3')").run();
  database.prepare("INSERT INTO threads VALUES(?,?,?,?,?)")
    .run("session-hash", "[]", "{}", "policy-hash", 10);
  database.prepare("INSERT INTO verified_items VALUES(?,?,?,?,?,?,?,?)")
    .run("cache-hash", "content-hash", "prompt", "policy-hash", "{}", 1, 2, 3);
  database.close();

  const scenarios = [
    {
      argv: ["lineage", "show", "session-hash", "--json"],
      corrupt(db) {
        db.prepare("UPDATE threads SET parent_keys_json = ?, session_map_json = '{}' WHERE session_key = ?")
          .run(privateValue, "session-hash");
      }
    },
    {
      argv: ["lineage", "show", "session-hash", "--json"],
      corrupt(db) {
        db.prepare("UPDATE threads SET parent_keys_json = '[]', session_map_json = ? WHERE session_key = ?")
          .run(privateValue, "session-hash");
      }
    },
    {
      argv: ["cache", "show", "cache-hash", "--json"],
      corrupt(db) {
        db.prepare("UPDATE verified_items SET additions_json = ? WHERE cache_key = ?")
          .run(privateValue, "cache-hash");
      }
    }
  ];

  for (const scenario of scenarios) {
    const writer = new sqlite.DatabaseSync(path);
    scenario.corrupt(writer);
    writer.close();

    const stdout = capture();
    const stderr = capture();
    const code = await runPrivacyAiCli(scenario.argv, {
      stdout: stdout.stream,
      stderr: stderr.stream,
      verificationDbPath: path
    });
    assert.equal(code, CLI_EXIT_CODES.failure);
    assert.equal(stdout.text(), "");
    assert.equal(stderr.text(), `${publicMessage}\n`);
    assert.equal(stderr.text().includes(privateValue), false);
    assert.equal(stderr.text().includes(path), false);
  }
});

test("the real binary exposes help and version without loading an agent", async () => {
  const help = await runProcess("node", [CLI, "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /PrivacyAI protected agent shell/);
  assert.match(help.stdout, /agent <name>/);

  const version = await runProcess("node", [CLI, "--version"]);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), "privacyai 0.0.2");
});

function ttyStreams() {
  return {
    stdin: ttyInput(),
    stdout: capture(true).stream,
    stderr: capture(true).stream
  };
}

function ttyInput() {
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { value: true });
  return stream;
}

function capture(isTTY = false) {
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { value: isTTY });
  let value = "";
  stream.on("data", chunk => { value += chunk.toString(); });
  return { stream, text: () => value };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => resolve({ code, stdout, stderr }));
  });
}
