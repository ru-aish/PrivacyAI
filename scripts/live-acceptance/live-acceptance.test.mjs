import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertPrNumbers, run, runChecked, writeJson } from "./common.mjs";
import { generateReviewScope } from "./generate-scope.mjs";
import { prepareCiHome } from "./prepare-ci-home.mjs";
import { parseReviewResponse, runLiveReview } from "./run-live-review.mjs";
import { renderSummary } from "./write-summary.mjs";

const ASSET = new URL("./assets/review-instructions.png", import.meta.url).pathname;

test("scope generation validates an exact clean release and three merged PRs", async t => {
  const fixture = await gitFixture(t);
  const output = join(fixture.root, "scope-output");
  const pulls = new Map(fixture.commits.slice(1).map((commit, index) => [index + 11, {
    number: index + 11,
    title: `PR ${index + 1}\nmetadata`,
    html_url: `https://example.test/pr/${index + 11}`,
    state: "closed",
    merged_at: `2026-07-2${index + 1}T00:00:00Z`,
    merge_commit_sha: commit,
    base: { sha: fixture.commits[index] },
    head: { sha: commit }
  }]));
  const fetch = async url => {
    const parsed = new URL(url);
    const prMatch = parsed.pathname.match(/\/pulls\/(\d+)$/);
    const filesMatch = parsed.pathname.match(/\/pulls\/(\d+)\/files$/);
    if (prMatch) return jsonResponse(pulls.get(Number(prMatch[1])));
    if (filesMatch) return jsonResponse([{ filename: `file-${filesMatch[1]}.txt` }]);
    return jsonResponse({ message: "not found" }, 404);
  };

  const scope = await generateReviewScope({
    repository: "ru-aish/PrivacyAI",
    releaseSha: fixture.commits.at(-1),
    prNumbers: [11, 12, 13],
    outputDir: output,
    cwd: fixture.repo,
    token: "fixture-token",
    fetch
  });

  assert.equal(scope.releaseSha, fixture.commits.at(-1));
  assert.equal(scope.baseSha, fixture.commits[0]);
  assert.deepEqual(scope.selectedPullRequests.map(item => item.number), [11, 12, 13]);
  assert.match(await readFile(join(output, "LIVE_REVIEW_SCOPE.md"), "utf8"), /untrusted context/i);
  assert.match(await readFile(join(output, "LIVE_REVIEW_SCOPE.md"), "utf8"), /PR #13/);
});

test("scope and PR argument validation fail closed", () => {
  assert.throws(() => assertPrNumbers([1, 1, 2]), /unique/);
  assert.throws(() => assertPrNumbers([1, 2]), /Exactly three/);
});

test("provider process groups expose and terminate background descendants", async () => {
  const result = await run("bash", ["-c", "sleep 30 >/dev/null 2>&1 &"], {
    processGroup: true,
    timeoutMs: 5000
  });
  assert.equal(result.code, 0);
  assert.equal(result.survivingProcessGroup.some(item => /sleep 30/.test(item.command)), true);
  await new Promise(resolve => setTimeout(resolve, 100));
  for (const item of result.survivingProcessGroup) {
    if (!item.pid) continue;
    assert.throws(() => process.kill(item.pid, 0), error => error?.code === "ESRCH");
  }
});

test("CI home contains only the explicit remote override and approved auth files", async t => {
  const root = await mkdtemp(join(tmpdir(), "privacyai-live-home-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const codex = { tokens: { access_token: "codex-fixture-token" } };
  const agy = {
    "antigravity-oauth-token": Buffer.from("agy-fixture-token").toString("base64"),
    installation_id: Buffer.from("fixture-installation").toString("base64")
  };
  const paths = await prepareCiHome({
    home,
    model: "fixture-model",
    apiKey: "mistral-fixture-key",
    codexAuthJson: JSON.stringify(codex),
    agyAuthJson: JSON.stringify(agy)
  });
  const config = JSON.parse(await readFile(paths.configPath, "utf8"));
  assert.equal(config.provider, "openai-compatible");
  assert.equal(config.baseURL, "https://api.mistral.ai/v1");
  assert.equal(config.model, "fixture-model");
  assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(paths.codexHome, "auth.json"), "utf8")), codex);
  assert.equal(
    await readFile(join(paths.geminiDir, "antigravity-cli", "antigravity-oauth-token"), "utf8"),
    "agy-fixture-token"
  );
});

test("AGY image MCP exposes only the fixed instruction-image tool", async t => {
  const child = spawn(process.execPath, [new URL("./review-image-mcp.mjs", import.meta.url).pathname], {
    env: { ...process.env, PRIVACYAI_REVIEW_IMAGE: ASSET },
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => child.kill("SIGKILL"));
  const responses = [];
  let buffer = "";
  child.stdout.on("data", chunk => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      responses.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_privacyai_review_instructions", arguments: {} } }) + "\n");
  await waitUntil(() => responses.length === 3);
  assert.equal(responses[1].result.tools.length, 1);
  assert.equal(responses[2].result.content[1].type, "image");
  assert.equal(responses[2].result.content[1].mimeType, "image/png");
  assert.ok(Buffer.from(responses[2].result.content[1].data, "base64").length > 100_000);
});

test("live-review orchestrator accepts independently verified mock provider runs and restores cleanliness", async t => {
  const fixture = await gitFixture(t);
  const root = fixture.root;
  const home = join(root, "home");
  const paths = await prepareCiHome({
    home,
    model: "fixture-model",
    apiKey: "mistral-fixture-key",
    codexAuthJson: JSON.stringify({ token: "fixture" }),
    agyAuthJson: JSON.stringify({
      "antigravity-oauth-token": Buffer.from("fixture").toString("base64")
    })
  });
  const scopeDir = join(root, "scope");
  await writeJson(join(scopeDir, "scope.json"), {
    releaseSha: fixture.commits.at(-1),
    selectedPullRequests: [{ number: 1 }, { number: 2 }, { number: 3 }]
  });
  await writeFile(join(scopeDir, "LIVE_REVIEW_SCOPE.md"), "# Fixture scope\n");
  const mock = join(root, "privacyai");
  await writeFile(mock, mockPrivacyAiSource());
  await chmod(mock, 0o755);
  const output = join(root, "evidence");
  const excludePath = (await runChecked("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: fixture.repo
  })).stdout.trim();
  const originalExclude = await readFile(join(fixture.repo, excludePath));

  const result = await runLiveReview({
    workspace: fixture.repo,
    scopePath: join(scopeDir, "LIVE_REVIEW_SCOPE.md"),
    scopeJsonPath: join(scopeDir, "scope.json"),
    imagePath: ASSET,
    home,
    privacyai: mock,
    outputDir: output,
    providers: "both"
  });

  assert.equal(result.eligible, true);
  assert.equal(result.providers.codex.ok, true);
  assert.equal(result.providers.agy.ok, true);
  assert.equal((await runChecked("git", ["status", "--porcelain"], { cwd: fixture.repo })).stdout, "");
  assert.equal(JSON.parse(await readFile(join(output, "harness-result.json"), "utf8")).eligible, true);
  assert.equal((await readdir(output)).includes("codex-final.txt"), false);
  assert.deepEqual(await readFile(join(fixture.repo, excludePath)), originalExclude);
  assert.ok(paths.configPath);
});

test("structured review validation rejects findings and inexact PR references", () => {
  const context = {
    expectedHead: "a".repeat(40),
    selectedPrNumbers: [1, 2, 3]
  };
  const valid = [
    "RESULT: PASS",
    `HEAD: ${context.expectedHead}`,
    "PRS: #1, #2, #3",
    "FINDINGS: none",
    "CHANGES: none",
    "TESTS: passed",
    "LIVE FLOW: passed",
    "PRIVACY: PASS",
    "CLEANUP: PASS",
    "RELEASE ELIGIBLE: YES"
  ].join("\n");

  assert.equal(parseReviewResponse(valid, context).ok, true);
  assert.equal(
    parseReviewResponse(
      valid.replace("LIVE FLOW:", "LIVE_FLOW:").replace("RELEASE ELIGIBLE:", "RELEASE_ELIGIBLE:"),
      context
    ).ok,
    true
  );
  assert.equal(
    parseReviewResponse(valid.replace("PRS: #1, #2, #3", "PRS: #10, #2, #3"), context).ok,
    false
  );
  assert.equal(
    parseReviewResponse(valid.replace("FINDINGS: none", "FINDINGS: P1 cache corruption"), context).ok,
    false
  );
});

test("workflow pins agent versions and validates the candidate before repository code runs", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/live-release-review.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /codex_version|agy_version/);
  assert.doesNotMatch(workflow, /@openai\/codex@\$\{\{\s*inputs\./);
  assert.match(workflow, /CODEX_VERSION: "0\.144\.5"/);
  assert.match(workflow, /AGY_VERSION: "1\.1\.5"/);
  const validation = workflow.indexOf("Validate candidate identity before executing repository code");
  const dependencyInstall = workflow.indexOf("Install deterministic workspace dependencies");
  assert.ok(validation >= 0 && dependencyInstall > validation);
  assert.match(workflow, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/main/);
  assert.match(workflow, /steps\.candidate\.outputs\.validated == 'true'/);
});

test("job summary is public-safe and reports release eligibility", () => {
  const text = renderSummary(
    { releaseSha: "a".repeat(40), selectedPullRequests: [{ number: 1 }, { number: 2 }, { number: 3 }] },
    {
      eligible: true,
      trackedCheckoutClean: true,
      cleanup: { ok: true },
      providers: {
        codex: { ok: true, result: "PASS", completionMarker: true },
        agy: { ok: true, result: "PASS", completionMarker: true }
      }
    }
  );
  assert.match(text, /ELIGIBLE FOR HUMAN APPROVAL/);
  assert.doesNotMatch(text, /codex-fixture-token|mistral-fixture-key|agy-fixture-token/i);
});

async function gitFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "privacyai-live-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  await runChecked("git", ["init", "--initial-branch=main", repo]);
  await runChecked("git", ["config", "user.email", "ci@example.test"], { cwd: repo });
  await runChecked("git", ["config", "user.name", "CI Fixture"], { cwd: repo });
  const commits = [];
  for (let index = 0; index < 4; index += 1) {
    await writeFile(join(repo, `file-${index}.txt`), `fixture ${index}\n`);
    await runChecked("git", ["add", "."], { cwd: repo });
    await runChecked("git", ["commit", "-m", `fixture ${index}`], { cwd: repo });
    commits.push((await runChecked("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim());
  }
  await runChecked("git", ["update-ref", "refs/remotes/origin/main", commits.at(-1)], { cwd: repo });
  return { root, repo, commits };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function mockPrivacyAiSource() {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "state") {
  console.log(JSON.stringify({ components: [
    { name: "configuration", status: "ready" },
    { name: "identity", status: "uninitialized" },
    { name: "vault", status: "uninitialized" },
    { name: "context", status: "uninitialized" },
    { name: "lineage", status: "uninitialized" }
  ] }));
  process.exit(0);
}
if (args[0] === "doctor") {
  console.log(JSON.stringify({ configuration: { configured: true }, localModel: { ok: true } }));
  process.exit(1);
}
if (args[0] === "agent") {
  if (args[1] === "codex") {
    if (args.includes("--dangerously-bypass-approvals-and-sandbox")) process.exit(20);
    if (!args.includes("--sandbox") || !args.includes("workspace-write")) process.exit(21);
  }
  if (args[1] === "agy") {
    if (args.includes("--dangerously-skip-permissions")) process.exit(22);
    if (!args.includes("--sandbox")) process.exit(23);
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" }).trim();
  if (status) process.exit(24);
  const result = [
    "RESULT: PASS",
    "HEAD: " + head,
    "PRS: #1, #2, #3",
    "FINDINGS: none",
    "CHANGES: none",
    "TESTS: fixture diagnostics and repository inspection passed",
    "LIVE FLOW: protected fixture provider process completed",
    "PRIVACY: PASS",
    "CLEANUP: PASS",
    "RELEASE ELIGIBLE: YES",
    "PRIVACYAI_LIVE_REVIEW_COMPLETE",
    ""
  ].join("\\n");
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], result);
  process.stdout.write(result);
  process.exit(0);
}
process.exit(2);
`;
}
