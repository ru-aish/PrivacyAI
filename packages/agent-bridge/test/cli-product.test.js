import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runPrivacyAiCli } from "../src/cli.js";

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

function capture(isTTY = false) {
  const stream = new PassThrough();
  Object.defineProperty(stream, "isTTY", { value: isTTY });
  let value = "";
  stream.on("data", chunk => { value += chunk.toString(); });
  return { stream, text: () => value };
}
