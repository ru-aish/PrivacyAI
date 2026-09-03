import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { assertPrNumbers, run, runChecked, writeJson } from "./common.mjs";
import { generateReviewScope } from "./generate-scope.mjs";
import { prepareCiHome } from "./prepare-ci-home.mjs";
import { parseReviewResponse, runLiveReview } from "./run-live-review.mjs";
import { renderSummary } from "./write-summary.mjs";
import { localSanitize } from "../../packages/sdk/src/index.js";
import { createImageSanitizer } from "../../packages/sdk/src/image/index.js";

const ASSET = new URL("./assets/review-instructions.png", import.meta.url).pathname;

test("scope generation validates an exact clean release and one merged PR", async t => {
  const fixture = await gitFixture(t);
  const output = join(fixture.root, "scope-output");
  const pulls = new Map([[11, {
    number: 11,
    title: "PR 1\nmetadata",
    html_url: "https://example.test/pr/11",
    state: "closed",
    merged_at: "2026-07-21T00:00:00Z",
    merge_commit_sha: fixture.commits[1],
    base: { sha: fixture.commits[0] },
    head: { sha: fixture.commits[1] }
  }]]);
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
    prNumbers: [11],
    outputDir: output,
    cwd: fixture.repo,
    token: "fixture-token",
    fetch
  });

  assert.equal(scope.releaseSha, fixture.commits.at(-1));
  assert.equal(scope.baseSha, fixture.commits[0]);
  assert.deepEqual(scope.selectedPullRequests.map(item => item.number), [11]);
  assert.equal(scope.reviewHeadSha, fixture.commits[1]);
  assert.equal(scope.reviewRange, fixture.commits[0] + ".." + fixture.commits[1]);
  assert.match(await readFile(join(output, "LIVE_REVIEW_SCOPE.md"), "utf8"), /untrusted context/i);
  assert.match(await readFile(join(output, "LIVE_REVIEW_SCOPE.md"), "utf8"), /PR #11/);
});

test("scope and PR argument validation fail closed", () => {
  assert.deepEqual(assertPrNumbers([1]), [1]);
  assert.throws(() => assertPrNumbers([1, 2]), /Exactly one/);
  assert.throws(() => assertPrNumbers([0]), /positive integers/);
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

test("review image stays public while the launch prompt carries the synthetic privacy probe", async () => {
  const instructionText = await readFile(new URL("./assets/review-instructions.txt", import.meta.url), "utf8");
  const launchPrompt = await readFile(new URL("./prompts/launch.txt", import.meta.url), "utf8");
  assert.doesNotMatch(instructionText, /qa-review-7f8a@example\.test/);
  assert.match(launchPrompt, /qa-review-7f8a@example\.test/);
  assert.match(launchPrompt, /Do not create subagents, background tasks, asynchronous commands/);
  assert.match(launchPrompt, /no more than 12 tool calls/);

  const imageBytes = await readFile(ASSET);
  const engine = createImageSanitizer();
  try {
    const result = await engine.sanitize(
      "data:image/png;base64," + imageBytes.toString("base64"),
      {
        sanitizer: async text => {
          const sanitized = await localSanitize(text);
          return { sanitizedPrompt: sanitized.sanitizedText, sessionMap: sanitized.sessionMap };
        },
        sessionMap: {}
      }
    );
    assert.equal(result.changed, false);
    assert.equal(result.verificationAttempts, 0);
  } finally {
    await engine.close();
  }
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
    selectedPullRequests: [{ number: 1 }]
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

test("failed provider evidence records provider cause and database diagnostics", async t => {
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
  await mkdir(join(home, ".local", "share", "privacyai"), { recursive: true });

  const contextDatabase = new DatabaseSync(paths.contextDb);
  contextDatabase.exec(`
    CREATE TABLE privacyai_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO privacyai_meta(key, value) VALUES('schema_version', '4');
    CREATE TABLE ledger_file_mutations(
      status TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    INSERT INTO ledger_file_mutations(status, operation_type, created_at, last_used_at)
    VALUES('rolled_back', 'write', 10, 20);
  `);
  contextDatabase.close();

  const lineageDatabase = new DatabaseSync(paths.lineageDb);
  lineageDatabase.exec(`
    CREATE TABLE privacyai_lineage_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO privacyai_lineage_meta(key, value) VALUES('schema_version', '1');
    CREATE TABLE lineage_events(
      row_id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      provider TEXT,
      operation TEXT,
      model TEXT,
      artifact_type TEXT,
      phase TEXT,
      reason_code TEXT NOT NULL,
      diagnostic_code TEXT
    );
    INSERT INTO lineage_events(
      event_type, occurred_at, recorded_at, provider, operation, model,
      artifact_type, phase, reason_code, diagnostic_code
    ) VALUES(
      'request_blocked', 100, 101, 'codex', 'responses', 'fixture-model',
      'prompt', 'request_validation', 'privacy_boundary', 'PRIVACYAI_CONTEXT_DB_WRITE_FAILED'
    );
  `);
  lineageDatabase.close();

  const scopeDir = join(root, "scope");
  await writeJson(join(scopeDir, "scope.json"), {
    releaseSha: fixture.commits.at(-1),
    selectedPullRequests: [{ number: 1 }]
  });
  await writeFile(join(scopeDir, "LIVE_REVIEW_SCOPE.md"), "# Fixture scope\n");
  const mock = join(root, "privacyai-failure");
  await writeFile(mock, mockPrivacyAiFailureSource());
  await chmod(mock, 0o755);
  const output = join(root, "evidence");

  await assert.rejects(
    runLiveReview({
      workspace: fixture.repo,
      scopePath: join(scopeDir, "LIVE_REVIEW_SCOPE.md"),
      scopeJsonPath: join(scopeDir, "scope.json"),
      imagePath: ASSET,
      home,
      privacyai: mock,
      outputDir: output,
      providers: "both"
    }),
    /provider:codex.*PRIVACYAI_CONTEXT_DB_WRITE_FAILED/i
  );

  const evidence = JSON.parse(await readFile(join(output, "harness-result.json"), "utf8"));
  assert.equal(evidence.eligible, false);
  assert.equal(evidence.providers.codex.failureCode, "PRIVACYAI_CONTEXT_DB_WRITE_FAILED");
  assert.equal(evidence.providers.agy.ok, true);
  assert.equal(evidence.failure.phase, "provider:codex");
  assert.equal(evidence.databaseDiagnostics.context.fileMutationStatuses[0].status, "rolled_back");
  assert.equal(
    evidence.databaseDiagnostics.lineage.recentEvents[0].diagnosticCode,
    "PRIVACYAI_CONTEXT_DB_WRITE_FAILED"
  );
  assert.match(await readFile(join(output, "codex-output.txt"), "utf8"), /PRIVACYAI_CONTEXT_DB_WRITE_FAILED/);
  const summary = renderSummary(
    { releaseSha: fixture.commits.at(-1), selectedPullRequests: [{ number: 1 }] },
    evidence
  );
  assert.match(summary, /PRIVACYAI_CONTEXT_DB_WRITE_FAILED/);
  assert.match(summary, /bounded sanitized log tail/);
  assert.match(summary, /request_blocked/);
});

test("provider diagnostics and explicit FAIL results outrank response-shape symptoms", async t => {
  const fixture = await gitFixture(t);
  const root = fixture.root;
  const home = join(root, "home");
  await prepareCiHome({
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
    selectedPullRequests: [{ number: 1 }]
  });
  await writeFile(join(scopeDir, "LIVE_REVIEW_SCOPE.md"), "# Fixture scope\n");
  const mock = join(root, "privacyai-contract-failure");
  await writeFile(mock, mockPrivacyAiContractFailureSource());
  await chmod(mock, 0o755);
  const output = join(root, "evidence");

  await assert.rejects(
    runLiveReview({
      workspace: fixture.repo,
      scopePath: join(scopeDir, "LIVE_REVIEW_SCOPE.md"),
      scopeJsonPath: join(scopeDir, "scope.json"),
      imagePath: ASSET,
      home,
      privacyai: mock,
      outputDir: output,
      providers: "both"
    }),
    /provider:codex.*PROVIDER_REVIEW_FAILED/i
  );

  const evidence = JSON.parse(await readFile(join(output, "harness-result.json"), "utf8"));
  assert.equal(evidence.providers.codex.failureCode, "PROVIDER_REVIEW_FAILED");
  assert.equal(evidence.providers.codex.structuredResponseValid, true);
  assert.equal(evidence.providers.codex.reviewResponsePassed, false);
  assert.deepEqual(evidence.providers.codex.diagnosticCodes, []);
  assert.equal(evidence.providers.agy.failureCode, "PRIVACYAI_AGY_SESSION_MAP_COLLISION");
  assert.equal(evidence.providers.agy.completionMarker, false);
  assert.deepEqual(evidence.providers.agy.diagnosticCodes, [
    "PRIVACYAI_AGY_SESSION_MAP_COLLISION"
  ]);
});

test("structured review validation rejects findings and inexact PR references", () => {
  const context = {
    expectedHead: "a".repeat(40),
    selectedPrNumbers: [1]
  };
  const valid = [
    "RESULT: PASS",
    `HEAD: ${context.expectedHead}`,
    "PR: #1",
    "FINDINGS: none",
    "CHANGES: none",
    "TESTS: passed",
    "LIVE FLOW: passed",
    "PRIVACY: PASS",
    "CLEANUP: PASS",
    "RELEASE ELIGIBLE: YES"
  ].join("\n");

  assert.equal(parseReviewResponse(valid, context).ok, true);
  assert.equal(parseReviewResponse(valid, context).contractValid, true);
  assert.equal(
    parseReviewResponse(
      valid.replace("LIVE FLOW:", "LIVE_FLOW:").replace("RELEASE ELIGIBLE:", "RELEASE_ELIGIBLE:"),
      context
    ).ok,
    true
  );
  const explicitFailure = [
    "RESULT: FAIL",
    "HEAD: unavailable",
    "PR: unavailable",
    "FINDINGS: repository shell access failed",
    "CHANGES: none",
    "TESTS: not run",
    "LIVE FLOW: not run",
    "PRIVACY: not verified",
    "CLEANUP: not applicable",
    "RELEASE ELIGIBLE: NO"
  ].join("\n");
  assert.equal(parseReviewResponse(explicitFailure, context).contractValid, true);
  assert.equal(parseReviewResponse(explicitFailure, context).ok, false);
  assert.equal(
    parseReviewResponse(valid.replace("PR: #1", "PR: #10"), context).ok,
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
  assert.match(workflow, /CODEX_VERSION: "0\.153\.0"/);
  assert.match(workflow, /AGY_VERSION: "1\.1\.5"/);
  assert.match(workflow, /sudo apt-get install --yes --no-install-recommends[\s\\]+[\s\S]*bubblewrap/);
  assert.match(workflow, /apparmor_parser -r \/etc\/apparmor\.d\/bwrap-userns-restrict/);
  assert.match(workflow, /bwrap --version/);
  assert.match(workflow, /--unshare-user/);
  assert.match(workflow, /sandbox-prerequisite-ok/);
  assert.doesNotMatch(workflow, /apparmor_restrict_unprivileged_userns=0/);
  assert.match(workflow, /test -f "\$RUNNER_TEMP\/agy-extract\/antigravity"/);
  assert.match(workflow, /test -x "\$RUNNER_TEMP\/agy-extract\/antigravity"/);
  assert.match(workflow, /install -m 0755 "\$RUNNER_TEMP\/agy-extract\/antigravity" "\$HOME\/\.local\/bin\/agy"/);
  assert.doesNotMatch(workflow, /find "\$RUNNER_TEMP\/agy-extract" -type f -name agy/);
  const jobPreamble = workflow.slice(0, workflow.indexOf("    steps:"));
  assert.doesNotMatch(jobPreamble, /runner\.temp/);
  assert.match(jobPreamble, /LIVE_HOME: \/tmp\/privacyai-live-home/);
  assert.match(workflow, /pr_number:/);
  assert.doesNotMatch(workflow, /pr_1:|pr_2:|pr_3:/);
  assert.match(workflow, /path: \/tmp\/privacyai-live-evidence/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.ok(workflow.includes("codex exec \\\n            --ephemeral"));
  assert.ok(workflow.includes("--config sandbox_workspace_write.network_access=true"));
  assert.ok(workflow.includes('--output-last-message "$RUNNER_TEMP/codex-interface-probe.txt"'));
  const runnerSource = await readFile(new URL("./run-live-review.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runnerSource, /--ask-for-approval/);
  assert.match(runnerSource, /"--sandbox", "workspace-write"/);
  assert.match(runnerSource, /"--config", "sandbox_workspace_write\.network_access=true"/);
  const validation = workflow.indexOf("Validate candidate identity before executing repository code");
  const dependencyInstall = workflow.indexOf("Install deterministic workspace dependencies");
  assert.ok(validation >= 0 && dependencyInstall > validation);
  assert.match(workflow, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/main/);
  assert.match(workflow, /steps\.candidate\.outputs\.validated == 'true'/);
});

test("job summary is public-safe and reports release eligibility", () => {
  const text = renderSummary(
    { releaseSha: "a".repeat(40), selectedPullRequests: [{ number: 1 }] },
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

function mockPrivacyAiContractFailureSource() {
  return `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "state") {
  console.log(JSON.stringify({ components: [
    { name: "configuration", status: "ready" },
    { name: "identity", status: "ready" },
    { name: "vault", status: "ready" },
    { name: "context", status: "ready" },
    { name: "lineage", status: "ready" }
  ] }));
  process.exit(0);
}
if (args[0] === "doctor") {
  console.log(JSON.stringify({ configuration: { configured: true }, localModel: { ok: true } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "codex") {
  const result = [
    "RESULT: FAIL",
    "HEAD: unavailable",
    "PR: unavailable",
    "FINDINGS: repository shell access failed",
    "CHANGES: none",
    "TESTS: not run",
    "LIVE FLOW: not run",
    "PRIVACY: not verified",
    "CLEANUP: not applicable",
    "RELEASE ELIGIBLE: NO",
    "PRIVACYAI_LIVE_REVIEW_COMPLETE",
    ""
  ].join("\\n");
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], result);
  process.stdout.write(result);
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "agy") {
  process.stdout.write("I launched two bounded review commands.\\n");
  process.stderr.write(
    "[PrivacyAI] AGY transport stopped a request " +
    "(intercepted-request: PRIVACYAI_AGY_SESSION_MAP_COLLISION).\\n"
  );
  process.exit(0);
}
process.exit(2);
`;
}

function mockPrivacyAiFailureSource() {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "state") {
  console.log(JSON.stringify({ components: [
    { name: "configuration", status: "ready" },
    { name: "identity", status: "ready" },
    { name: "vault", status: "ready" },
    { name: "context", status: "ready" },
    { name: "lineage", status: "ready" }
  ] }));
  process.exit(0);
}
if (args[0] === "doctor") {
  console.log(JSON.stringify({ configuration: { configured: true }, localModel: { ok: true } }));
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "codex") {
  process.stderr.write("PRIVACYAI_CONTEXT_DB_WRITE_FAILED: fixture database write failed\\n");
  process.exit(7);
}
if (args[0] === "agent" && args[1] === "agy") {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = [
    "RESULT: PASS",
    "HEAD: " + head,
    "PR: #1",
    "FINDINGS: none",
    "CHANGES: none",
    "TESTS: fixture diagnostics passed",
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
    const configIndex = args.indexOf("--config");
    if (configIndex < 0 || args[configIndex + 1] !== "sandbox_workspace_write.network_access=true") process.exit(25);
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
    "PR: #1",
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
