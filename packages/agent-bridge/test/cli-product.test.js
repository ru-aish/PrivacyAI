import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runPrivacyAiCli } from "../src/cli.js";
import { loadPrivacyConfig } from "../src/config-store.js";

test("internal CLI uses the stable usage exit code for unknown commands", async () => {
  const stderr = capture();
  const code = await runPrivacyAiCli(["unknown"], { stderr: stderr.stream });
  assert.equal(code, 2);
  assert.match(stderr.text(), /Unknown PrivacyAI command/);
  assert.match(stderr.text(), /privacyai --help/);
});

test("internal doctor uses exit code 3 when onboarding is required", async () => {
  const stdout = capture();
  const code = await runPrivacyAiCli(["doctor"], {
    stdout: stdout.stream,
    configPath: `/tmp/privacyai-missing-config-${process.pid}.json`
  });
  assert.equal(code, 3);
  assert.match(stdout.text(), /configuration: missing/i);
  assert.match(stdout.text(), /privacyai onboard/);
});

test("internal onboarding fails fast when no interactive terminal is available", async () => {
  let invoked = false;
  const stdin = new PassThrough();
  const stdout = capture(false);
  const stderr = capture(false);
  Object.defineProperty(stdin, "isTTY", { value: false });

  const code = await runPrivacyAiCli(["onboard"], {
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runOnboarding: async () => { invoked = true; }
  });
  assert.equal(code, 2);
  assert.equal(invoked, false);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /requires an interactive terminal/);
});

test("configuration discovery has explicit precedence and rejects invalid files", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-config-precedence-"));
  const explicitPath = join(root, "explicit.json");
  const environmentPath = join(root, "environment.json");
  const environmentDir = join(root, "config-dir");
  const directoryPath = join(environmentDir, "config.json");
  const previousFile = process.env.PRIVACYAI_CONFIG_FILE;
  const previousDir = process.env.PRIVACYAI_CONFIG_DIR;
  t.after(async () => {
    restoreEnvironment("PRIVACYAI_CONFIG_FILE", previousFile);
    restoreEnvironment("PRIVACYAI_CONFIG_DIR", previousDir);
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(environmentDir, { recursive: true });
  await Promise.all([
    writeConfig(explicitPath, "explicit-model"),
    writeConfig(environmentPath, "environment-model"),
    writeConfig(directoryPath, "directory-model")
  ]);
  process.env.PRIVACYAI_CONFIG_FILE = environmentPath;
  process.env.PRIVACYAI_CONFIG_DIR = environmentDir;

  assert.equal((await loadPrivacyConfig({ path: explicitPath })).config.model, "explicit-model");
  assert.equal((await loadPrivacyConfig()).config.model, "environment-model");

  delete process.env.PRIVACYAI_CONFIG_FILE;
  assert.equal((await loadPrivacyConfig()).config.model, "directory-model");

  await writeFile(directoryPath, "private-invalid-config-value", { mode: 0o600 });
  await assert.rejects(
    loadPrivacyConfig(),
    error => /invalid or unreadable/.test(error.message) &&
      !error.message.includes("private-invalid-config-value")
  );
});

function writeConfig(path, model) {
  return writeFile(path, JSON.stringify({
    provider: "ollama",
    model,
    baseURL: "http://127.0.0.1:11434"
  }), { mode: 0o600 });
}

function restoreEnvironment(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function capture(isTTY = false) {
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { value: isTTY });
  let value = "";
  stream.on("data", chunk => { value += chunk.toString(); });
  return { stream, text: () => value };
}
