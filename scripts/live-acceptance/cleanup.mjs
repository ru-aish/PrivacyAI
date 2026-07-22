#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { absolute, one, parseRepeatedArgs, run } from "./common.mjs";

export async function cleanupLiveReview(options) {
  const home = absolute(options.home);
  const workspace = absolute(options.workspace);
  await rm(join(workspace, "LIVE_REVIEW_SCOPE.md"), { force: true });
  await rm(home, { recursive: true, force: true });

  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: workspace,
    timeoutMs: 30_000
  });
  if (status.code !== 0 || status.stdout.trim()) {
    throw new Error("Live-review cleanup left the release checkout dirty.");
  }
}

async function main() {
  const values = parseRepeatedArgs(process.argv.slice(2));
  await cleanupLiveReview({
    home: one(values, "--home", { required: true }),
    workspace: one(values, "--workspace", { required: true })
  });
  process.stdout.write("Live-review credentials and temporary state removed.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
