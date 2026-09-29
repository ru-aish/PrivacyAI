import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexTuiSessionActionArgs,
  parseCodexTuiSessionActionRecord,
  supportsCodexTuiSessionActions
} from "../src/codex-tui-session-action.js";

test("Codex TUI session actions accept only protected resume and fork selectors", () => {
  assert.deepEqual(
    parseCodexTuiSessionActionRecord({ version: 1, action: "resume", selector: null }),
    { action: "resume", selector: null }
  );
  assert.deepEqual(
    parseCodexTuiSessionActionRecord({ version: 1, action: "fork", selector: "--last" }),
    { action: "fork", selector: "--last" }
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

  for (const record of [
    null,
    { version: 2, action: "resume", selector: null },
    { version: 1, action: "exec", selector: null },
    { version: 1, action: "resume", selector: "--search" },
    { version: 1, action: "fork", selector: "session prompt" },
    { version: 1, action: "fork", selector: "/tmp/private" }
  ]) {
    assert.equal(parseCodexTuiSessionActionRecord(record), null);
  }
});

test("Codex TUI session relaunch preserves safe launch options but drops prior selectors and prompts", () => {
  const args = buildCodexTuiSessionActionArgs(
    [
      "--no-alt-screen",
      "-C",
      "/tmp/project",
      "--model=gpt-5.6-luna",
      "resume",
      "--all",
      "old-session",
      "private startup prompt"
    ],
    { action: "fork", selector: "--last" }
  );

  assert.deepEqual(args, [
    "--no-alt-screen",
    "-C",
    "/tmp/project",
    "--model=gpt-5.6-luna",
    "fork",
    "--last"
  ]);
});

test("Codex TUI session interception is limited to interactive invocations", () => {
  assert.equal(supportsCodexTuiSessionActions([]), true);
  assert.equal(supportsCodexTuiSessionActions(["--no-alt-screen"]), true);
  assert.equal(supportsCodexTuiSessionActions(["resume", "--last"]), true);
  assert.equal(supportsCodexTuiSessionActions(["fork", "--all"]), true);
  assert.equal(supportsCodexTuiSessionActions(["Explain this repository"]), true);

  assert.equal(supportsCodexTuiSessionActions(["exec", "echo test"]), false);
  assert.equal(supportsCodexTuiSessionActions(["e", "echo test"]), false);
  assert.equal(supportsCodexTuiSessionActions(["apply"]), false);
  assert.equal(supportsCodexTuiSessionActions(["a"]), false);
  assert.equal(supportsCodexTuiSessionActions(["review"]), false);
  assert.equal(supportsCodexTuiSessionActions(["--help"]), false);
  assert.equal(supportsCodexTuiSessionActions(["resume", "--help"]), false);
  assert.equal(supportsCodexTuiSessionActions(["--", "--help"]), true);
  assert.equal(supportsCodexTuiSessionActions(["--", "exec"]), true);
});
