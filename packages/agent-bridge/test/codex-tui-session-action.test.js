import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexTuiSessionActionArgs,
  parseCodexTuiSessionActionRecord,
  supportsCodexTuiSessionActions
} from "../src/codex-tui-session-action.js";

test("Codex TUI session actions accept only protected resume selectors", () => {
  assert.deepEqual(
    parseCodexTuiSessionActionRecord({ version: 1, action: "resume", selector: null }),
    { action: "resume", selector: null }
  );
  assert.deepEqual(
    parseCodexTuiSessionActionRecord({
      version: 1,
      action: "resume",
      selector: "019f6c22-5dcf-7cc3-9fd3-3e4572b07ff7"
    }),
    {
      action: "resume",
      selector: "019f6c22-5dcf-7cc3-9fd3-3e4572b07ff7"
    }
  );
  assert.deepEqual(
    parseCodexTuiSessionActionRecord({ version: 1, action: "resume", selector: "  Research thread  " }),
    { action: "resume", selector: "Research thread" }
  );

  for (const record of [
    null,
    { version: 2, action: "resume", selector: null },
    { version: 1, action: "exec", selector: null },
    { version: 1, action: "resume", selector: "--search" },
    { version: 1, action: "fork", selector: null },
    { version: 1, action: "resume", selector: "/tmp/private" }
  ]) {
    assert.equal(parseCodexTuiSessionActionRecord(record), null);
  }
});

test("Codex TUI resume relaunch preserves current launch state but drops prior selectors and prompts", () => {
  const args = buildCodexTuiSessionActionArgs(
    [
      "--no-alt-screen",
      "--search",
      "--approve-for-me",
      "--no-daemon",
      "-C",
      "/tmp/project",
      "--model=gpt-5.6-luna",
      "resume",
      "--all",
      "old-session",
      "private startup prompt"
    ],
    { action: "resume", selector: "Research thread" }
  );

  assert.deepEqual(args, [
    "--no-alt-screen",
    "--search",
    "--approve-for-me",
    "--no-daemon",
    "-C",
    "/tmp/project",
    "--model=gpt-5.6-luna",
    "resume",
    "Research thread"
  ]);
});

test("Codex TUI resume interception is limited to interactive invocations", () => {
  assert.equal(supportsCodexTuiSessionActions([]), true);
  assert.equal(supportsCodexTuiSessionActions(["--no-alt-screen"]), true);
  assert.equal(supportsCodexTuiSessionActions(["resume", "--last"]), true);
  assert.equal(supportsCodexTuiSessionActions(["fork", "--last"]), true);
  assert.equal(supportsCodexTuiSessionActions(["Explain this repository"]), true);

  assert.equal(supportsCodexTuiSessionActions(["exec", "echo test"]), false);
  assert.equal(supportsCodexTuiSessionActions(["e", "echo test"]), false);
  assert.equal(supportsCodexTuiSessionActions(["apply"]), false);
  assert.equal(supportsCodexTuiSessionActions(["a"]), false);
  assert.equal(supportsCodexTuiSessionActions(["review"]), false);
  assert.equal(supportsCodexTuiSessionActions(["agents"]), false);
  assert.equal(supportsCodexTuiSessionActions(["queue", "thread-id", "hello"]), false);
  assert.equal(supportsCodexTuiSessionActions(["migrate-rollouts"]), false);
  assert.equal(supportsCodexTuiSessionActions(["tcp-tunnel"]), false);
  assert.equal(supportsCodexTuiSessionActions(["--help"]), false);
  assert.equal(supportsCodexTuiSessionActions(["resume", "--help"]), false);
  assert.equal(supportsCodexTuiSessionActions(["--", "--help"]), true);
  assert.equal(supportsCodexTuiSessionActions(["--", "exec"]), true);
});
