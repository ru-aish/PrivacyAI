import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BoundedTextBuffer,
  runInheritedProcess,
  signalExitCode,
  terminateProcessTree
} from "../src/process-supervisor.js";

test("signal exit codes follow the platform signal table", () => {
  assert.equal(signalExitCode("SIGINT"), 130);
  assert.equal(signalExitCode("SIGTERM"), 143);
  assert.equal(signalExitCode("SIGKILL"), 137);
  assert.equal(signalExitCode("SIGSEGV"), 139);
  assert.equal(signalExitCode("NOT_A_SIGNAL"), 1);
});

test("inherited process runner returns shell-compatible signal exits", async () => {
  assert.equal(
    await runInheritedProcess(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGKILL')"
    ]),
    137
  );
});

test("inherited process runner removes descendants left behind by a successful parent", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-inherited-orphan-"));
  const pidPath = join(root, "descendant.pid");
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
    "child.unref();",
    `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`
  ].join("\n");

  assert.equal(
    await runInheritedProcess(process.execPath, ["-e", script], {
      orphanGraceMs: 50,
      killWaitMs: 1000
    }),
    0
  );
  const descendantPid = Number(await readFile(pidPath, "utf8"));
  assert.equal(processExists(descendantPid), false);
});

test("bounded process output rejects excess bytes without retaining them", () => {
  const buffer = new BoundedTextBuffer(5, "test output");
  assert.equal(buffer.append(Buffer.from("abc")), true);
  assert.equal(buffer.append(Buffer.from("de")), true);
  assert.equal(buffer.append(Buffer.from("f")), false);
  assert.equal(buffer.text(), "abcde");
});

test("process-tree termination escalates and removes signal-resistant descendants", {
  skip: process.platform === "win32"
}, async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
    "child.unref();",
    "process.stdout.write(String(child.pid) + '\\n');",
    "setInterval(() => {}, 1000);"
  ].join("\n");
  const parent = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
  const [chunk] = await once(parent.stdout, "data");
  const descendantPid = Number(String(chunk).trim());
  const parentExit = once(parent, "exit");

  await terminateProcessTree(parent, { graceMs: 50, killWaitMs: 1000 });
  await parentExit;

  assert.equal(processExists(parent.pid), false);
  assert.equal(processExists(descendantPid), false);
});

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
