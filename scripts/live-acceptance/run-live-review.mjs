#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  COMPLETION_MARKER,
  SYNTHETIC_PRIVATE_VALUE,
  absolute,
  one,
  parseRepeatedArgs,
  prepareIgnoredReviewScope,
  readJson,
  redactText,
  restoreIgnoredReviewScope,
  run,
  runChecked,
  writeJson
} from "./common.mjs";

const FAILURE_PATTERNS = Object.freeze([
  /422 Unprocessable Entity/i,
  /privacy boundary could not be verified/i,
  /PrivacyAI encountered an internal failure/i,
  /authentication required/i,
  /not signed in/i,
  /rate limit(?:ed)?/i,
  /timed out/i
]);

export async function runLiveReview(options) {
  const workspace = absolute(options.workspace);
  const scopePath = absolute(options.scopePath);
  const scopeJsonPath = absolute(options.scopeJsonPath);
  const imagePath = absolute(options.imagePath);
  const home = absolute(options.home);
  const privacyai = absolute(options.privacyai);
  const outputDir = absolute(options.outputDir);
  const providers = normalizeProviders(options.providers);
  const scope = await readJson(scopeJsonPath);
  const expectedHead = String(scope.releaseSha || "").toLowerCase();
  const selectedPrNumbers = (scope.selectedPullRequests || []).map(item => Number(item.number));
  const reviewScopePath = join(workspace, "LIVE_REVIEW_SCOPE.md");
  const prompt = await readFile(new URL("./prompts/launch.txt", import.meta.url), "utf8");
  const paths = await readJson(join(home, "ci-paths.json"));
  const secretValues = await collectSecretValuesFromHome(home, paths);

  await mkdir(outputDir, { recursive: true });
  await cp(scopePath, join(outputDir, "LIVE_REVIEW_SCOPE.md"));
  await cp(scopeJsonPath, join(outputDir, "scope.json"));
  const beforeProcesses = await agentProcessSnapshot();
  const beforeRuntimeDirs = new Set(await privacyRuntimeDirectories());
  await assertTrackedClean(workspace, expectedHead);

  const env = buildRuntimeEnvironment(home, paths);
  const evidence = {
    schemaVersion: 1,
    releaseSha: expectedHead,
    providers: {},
    doctor: null,
    statePreflight: null,
    trackedCheckoutClean: false,
    cleanup: null,
    eligible: false
  };

  try {
    await prepareIgnoredReviewScope(workspace, home);
    await cp(scopePath, reviewScopePath);
    evidence.statePreflight = await captureDiagnostic(
      privacyai,
      ["state", "preflight", "--json"],
      workspace,
      env,
      join(outputDir, "state-preflight.json"),
      secretValues
    );
    evidence.doctor = await captureDiagnostic(
      privacyai,
      ["doctor", "--json"],
      workspace,
      env,
      join(outputDir, "doctor.json"),
      secretValues,
      { allowNonZero: true }
    );
    assertSafeDiagnostics(evidence.doctor, evidence.statePreflight);

    if (providers.includes("codex")) {
      evidence.providers.codex = await runCodex({
        privacyai, workspace, imagePath, prompt, outputDir, env, home, secretValues,
        expectedHead, selectedPrNumbers, model: options.codexModel
      });
    }
    if (providers.includes("agy")) {
      evidence.providers.agy = await runAgy({
        privacyai, workspace, imagePath, prompt, outputDir, env, home, secretValues,
        expectedHead, selectedPrNumbers, model: options.agyModel
      });
    }
  } finally {
    await rm(reviewScopePath, { force: true });
    await restoreIgnoredReviewScope(home);
    evidence.trackedCheckoutClean = await isTrackedClean(workspace, expectedHead);
    evidence.cleanup = await inspectCleanup(beforeProcesses, beforeRuntimeDirs);
    evidence.eligible =
      evidence.trackedCheckoutClean &&
      evidence.cleanup.ok &&
      Object.keys(evidence.providers).length === providers.length &&
      Object.values(evidence.providers).every(result => result.ok);
    await writeJson(join(outputDir, "harness-result.json"), evidence);
    await writeChecksums(outputDir);
  }

  if (!evidence.eligible) {
    throw new Error("PrivacyAI live release review did not satisfy the release gate. See sanitized evidence.");
  }
  return evidence;
}

async function runCodex(context) {
  const privateDir = join(context.home, ".privacyai-live-private");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const finalPath = join(privateDir, "codex-final.txt");
  const args = [
    "agent", "codex", "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--ask-for-approval", "never",
    "--sandbox", "workspace-write",
    "--image", context.imagePath,
    "--output-last-message", finalPath,
    "--color", "never"
  ];
  if (context.model) args.push("--model", context.model);
  args.push(context.prompt);
  return runProvider("codex", context.privacyai, args, { ...context, finalPath });
}

async function runAgy(context) {
  const mcpConfigPath = join(context.home, ".gemini", "config", "mcp_config.json");
  const settingsPath = join(context.home, ".gemini", "antigravity-cli", "settings.json");
  const serverPath = resolve(new URL("./review-image-mcp.mjs", import.meta.url).pathname);
  let existingSettings = {};
  try {
    existingSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await writeJson(settingsPath, {
    ...existingSettings,
    enableTelemetry: false,
    toolPermission: "always-proceed",
    trustedWorkspaces: [context.workspace]
  }, { private: true });
  await writeJson(mcpConfigPath, {
    mcpServers: {
      privacyai_live_review_image: {
        command: process.execPath,
        args: [serverPath],
        env: { PRIVACYAI_REVIEW_IMAGE: context.imagePath }
      }
    }
  }, { private: true });
  const agyPrompt = [
    "Immediately call the MCP tool named read_privacyai_review_instructions exactly once with an empty object.",
    "Read the returned image completely before using any other tool.",
    context.prompt
  ].join("\n\n");
  const args = [
    "agent", "agy",
    "--print", agyPrompt,
    "--mode", "plan",
    "--sandbox",
    "--print-timeout", "20m"
  ];
  if (context.model) args.push("--model", context.model);
  return runProvider("agy", context.privacyai, args, context);
}

async function runProvider(name, command, args, context) {
  const result = await run(command, args, {
    cwd: context.workspace,
    env: context.env,
    timeoutMs: 20 * 60_000,
    maximumBytes: 24 * 1024 * 1024,
    processGroup: true
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  const safeOutput = redactText(combined, context.secretValues);
  await writeFile(join(context.outputDir, `${name}-output.txt`), safeOutput);
  let final = "";
  try {
    final = context.finalPath
      ? await readFile(context.finalPath, "utf8")
      : result.stdout;
  } catch {
    final = result.stdout;
  } finally {
    if (context.finalPath) await rm(context.finalPath, { force: true });
  }
  const safeFinal = redactText(final, context.secretValues);
  await writeFile(join(context.outputDir, `${name}-result.txt`), safeFinal);
  const failures = FAILURE_PATTERNS.filter(pattern => pattern.test(combined)).map(pattern => pattern.source);
  const structured = parseReviewResponse(safeFinal, context);
  const ok =
    result.code === 0 &&
    !result.timedOut &&
    result.survivingProcessGroup.length === 0 &&
    failures.length === 0 &&
    safeFinal.includes(COMPLETION_MARKER) &&
    structured.ok &&
    !safeOutput.includes(SYNTHETIC_PRIVATE_VALUE) &&
    !safeFinal.includes(SYNTHETIC_PRIVATE_VALUE);
  return {
    ok,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    survivingProcessGroup: result.survivingProcessGroup.map(item => ({
      pid: item.pid,
      command: redactText(item.command, context.secretValues)
    })),
    completionMarker: safeFinal.includes(COMPLETION_MARKER),
    result: structured.fields.RESULT || null,
    missingFields: structured.missingFields,
    structuredResponseValid: structured.ok,
    failurePatterns: failures
  };
}

export function parseReviewResponse(text, context) {
  const labels = [
    "RESULT",
    "HEAD",
    "PRS",
    "FINDINGS",
    "CHANGES",
    "TESTS",
    "LIVE FLOW",
    "PRIVACY",
    "CLEANUP",
    "RELEASE ELIGIBLE"
  ];
  const fields = Object.fromEntries(labels.map(label => [label, responseField(text, label)]));
  const missingFields = labels.filter(label => !fields[label]);
  const reportedHead = fields.HEAD?.match(/[0-9a-f]{40}/i)?.[0]?.toLowerCase() || null;
  const reportedPrNumbers = [...String(fields.PRS || "").matchAll(/#([1-9][0-9]*)\b/g)]
    .map(match => Number(match[1]));
  const prsValid =
    context.selectedPrNumbers.length === 3 &&
    reportedPrNumbers.length === 3 &&
    new Set(reportedPrNumbers).size === 3 &&
    context.selectedPrNumbers.every(number => reportedPrNumbers.includes(number));
  const ok =
    missingFields.length === 0 &&
    /^PASS\b/i.test(fields.RESULT) &&
    reportedHead === context.expectedHead &&
    prsValid &&
    /^none\b/i.test(fields.FINDINGS) &&
    /^none\b/i.test(fields.CHANGES) &&
    /^PASS\b/i.test(fields.PRIVACY) &&
    /^PASS\b/i.test(fields.CLEANUP) &&
    /^YES\b/i.test(fields["RELEASE ELIGIBLE"]);
  return { ok, fields, missingFields };
}

function responseField(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text).match(new RegExp(`^${escaped}:\\s*(.+)$`, "im"))?.[1]?.trim() || null;
}

async function captureDiagnostic(command, args, cwd, env, outputPath, secrets, options = {}) {
  const result = await run(command, args, { cwd, env, timeoutMs: 3 * 60_000 });
  if (result.timedOut || (!options.allowNonZero && result.code !== 0)) {
    throw new Error(`${basename(command)} ${args.join(" ")} failed.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${basename(command)} ${args.join(" ")} did not return JSON.`);
  }
  const sanitized = JSON.parse(redactText(JSON.stringify(parsed), secrets));
  await writeJson(outputPath, sanitized);
  return sanitized;
}

function assertSafeDiagnostics(doctor, state) {
  if (!doctor?.configuration?.configured) throw new Error("Installed PrivacyAI configuration was not loaded.");
  if (!doctor?.localModel?.ok) throw new Error("Remote CI sanitizer readiness check failed.");
  const unsafe = (state?.components || []).filter(item =>
    new Set(["unsafe", "corrupt", "unsupported", "busy"]).has(item?.status)
  );
  if (unsafe.length) throw new Error("Isolated PrivacyAI state preflight reported unsafe state.");
}

function buildRuntimeEnvironment(home, paths) {
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: paths.codexHome,
    GEMINI_DIR: paths.geminiDir,
    XDG_CONFIG_HOME: paths.configHome,
    XDG_CACHE_HOME: paths.cacheHome,
    XDG_DATA_HOME: paths.dataHome,
    PRIVACYAI_CONFIG_FILE: paths.configPath,
    PRIVACYAI_CONTEXT_DB: paths.contextDb,
    PRIVACYAI_LINEAGE_DB: paths.lineageDb,
    PRIVACYAI_IDENTITY_KEY_FILE: paths.identityKey,
    PRIVACYAI_AGENT_VAULT_DIR: paths.vaultDir,
    PRIVACYAI_ALLOW_REMOTE_SANITIZER: "1",
    CI: "true",
    NO_COLOR: "1"
  };
}

async function assertTrackedClean(workspace, expectedHead) {
  if (!await isTrackedClean(workspace, expectedHead)) {
    throw new Error("Release checkout is not clean or does not match the reviewed SHA.");
  }
}

async function isTrackedClean(workspace, expectedHead) {
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: workspace, timeoutMs: 30_000 });
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: workspace,
    timeoutMs: 30_000
  });
  return head.code === 0 && status.code === 0 &&
    head.stdout.trim().toLowerCase() === expectedHead && status.stdout.trim() === "";
}

async function agentProcessSnapshot() {
  const result = await runChecked("ps", ["-eo", "pid=,args="], { timeoutMs: 30_000 });
  const map = new Map();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    if (/(^|[\s/])(privacyai|codex|agy)([\s/]|$)/i.test(match[2])) map.set(Number(match[1]), match[2]);
  }
  return map;
}

async function privacyRuntimeDirectories() {
  try {
    return (await readdir("/tmp", { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.startsWith("privacyai-agent-"))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

async function inspectCleanup(beforeProcesses, beforeRuntimeDirs) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 750));
  const afterProcesses = await agentProcessSnapshot();
  const surviving = [...afterProcesses.entries()]
    .filter(([pid]) => !beforeProcesses.has(pid))
    .map(([pid, command]) => ({ pid, command: redactText(command) }));
  const afterRuntimeDirs = await privacyRuntimeDirectories();
  const leftoverRuntimeDirs = afterRuntimeDirs.filter(name => !beforeRuntimeDirs.has(name));
  return {
    ok: surviving.length === 0 && leftoverRuntimeDirs.length === 0,
    survivingProcesses: surviving,
    leftoverRuntimeDirs
  };
}

async function writeChecksums(outputDir) {
  const files = (await readdir(outputDir)).filter(name => name !== "checksums.txt").sort();
  const lines = [];
  for (const name of files) {
    const result = await runChecked("sha256sum", [join(outputDir, name)], { timeoutMs: 30_000 });
    lines.push(`${result.stdout.trim().split(/\s+/)[0]}  ${name}`);
  }
  await writeFile(join(outputDir, "checksums.txt"), lines.join("\n") + "\n");
}

async function collectSecretValuesFromHome(home, paths) {
  const values = [];
  for (const path of [
    paths.configPath,
    join(paths.codexHome, "auth.json"),
    join(paths.geminiDir, "antigravity-cli", "antigravity-oauth-token"),
    join(paths.geminiDir, "antigravity-cli", "installation_id"),
    join(paths.geminiDir, "antigravity-cli", "jetski_state.pbtxt"),
    join(paths.geminiDir, "antigravity-cli", "settings.json"),
    join(paths.geminiDir, "config", "config.json")
  ]) {
    try {
      values.push(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  values.push(home);
  return collectSecretValues(values);
}

function collectSecretValues(values) {
  const collected = [];
  const visit = value => {
    if (typeof value === "string") {
      if (value.length >= 4) collected.push(value);
      try { visit(JSON.parse(value)); } catch {}
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  for (const value of values) visit(value);
  return [...new Set(collected)];
}

function normalizeProviders(value) {
  const normalized = String(value || "both").toLowerCase();
  if (normalized === "both") return ["codex", "agy"];
  if (normalized === "codex" || normalized === "agy") return [normalized];
  throw new Error("--providers must be both, codex, or agy.");
}

async function main() {
  const values = parseRepeatedArgs(process.argv.slice(2));
  const evidence = await runLiveReview({
    workspace: one(values, "--workspace", { required: true }),
    scopePath: one(values, "--scope", { required: true }),
    scopeJsonPath: one(values, "--scope-json", { required: true }),
    imagePath: one(values, "--image", { required: true }),
    home: one(values, "--home", { required: true }),
    privacyai: one(values, "--privacyai", { required: true }),
    outputDir: one(values, "--output", { required: true }),
    providers: one(values, "--providers", { defaultValue: "both" }),
    codexModel: process.env.PRIVACYAI_LIVE_CODEX_MODEL,
    agyModel: process.env.PRIVACYAI_LIVE_AGY_MODEL
  });
  process.stdout.write(`PrivacyAI live release review passed for ${evidence.releaseSha}.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
