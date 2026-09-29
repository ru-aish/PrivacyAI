#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalRegistry } from "./local-registry.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliSourceRoot = join(repositoryRoot, "packages", "agent-tui");
const sdkSourceRoot = join(repositoryRoot, "packages", "sdk");
const ptyRunner = join(repositoryRoot, "scripts", "deployment-assurance", "pty-runner.py");
const fakeAgentFixture = join(
  repositoryRoot,
  "scripts",
  "deployment-assurance",
  "fixtures",
  "fake-native-agent.mjs"
);
const PRIVATE_FIXTURE = "assurance.private@example.test";
const PROVIDER_FAILURE_FIXTURE = "provider-failure-secret-do-not-print";
const EXECUTABLE_FAILURE_FIXTURE = "executable-failure-secret-do-not-print";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const ASSURANCE_SCOPE = process.env.PRIVACYAI_ASSURANCE_SCOPE || "full";
if (!new Set(["full", "platform-storage"]).has(ASSURANCE_SCOPE)) {
  throw new Error("Unsupported deployment-assurance scope.");
}

const timings = [];
let temporaryRoot;
let toolEnvironment;
let registry;
let provider;

try {
  temporaryRoot = await mkdtemp(join(tmpdir(), "privacyai-deployment-assurance-"));
  await chmod(temporaryRoot, 0o700);
  toolEnvironment = await createToolEnvironment();

  const artifacts = await step("pack production SDK and CLI artifacts", packReleaseArtifacts);
  const release = await step("validate release metadata, compatibility, and integrity", () =>
    validateReleaseArtifacts(artifacts)
  );
  const installation = await step("install tarballs with a localhost-only dependency registry", () =>
    installReleaseArtifacts(artifacts, release)
  );
  await step("detect installed package-content mutation", () =>
    verifyInstalledMutationGate(installation, release)
  );
  const runtime = await step("prepare deterministic local provider and native-agent fixtures", () =>
    prepareRuntimeFixtures(installation)
  );
  await step("reject unsafe installed onboarding state", () =>
    exerciseUnsafeOnboarding(runtime)
  );
  await step("install, onboard, and validate private filesystem state", () =>
    exerciseOnboarding(runtime)
  );
  await step("recover from transient and unavailable provider failures", () =>
    exerciseDoctorRecovery(runtime)
  );
  await step("handle missing and corrupt native executables safely", () =>
    exerciseExecutableFailures(runtime)
  );
  if (ASSURANCE_SCOPE === "full") {
    await step("dispatch a sanitized installed AGY flow and clean resources", () =>
      exerciseSuccessfulDispatch(runtime)
    );
    await step("clean up after a failed native child", () =>
      exerciseFailedDispatch(runtime)
    );
    await step("interrupt, reap, restart, and resume installed dispatch", () =>
      exerciseInterruptedDispatch(runtime)
    );
  }
  await step("assert final credential and filesystem hygiene", () =>
    assertFinalFilesystemHygiene(runtime, { requireIdentity: ASSURANCE_SCOPE === "full" })
  );

  const elapsed = timings.reduce((total, item) => total + item.seconds, 0);
  process.stdout.write(
    `[deployment-assurance] PASS ${timings.length} gates in ${elapsed.toFixed(2)}s\n`
  );
  for (const timing of timings) {
    process.stdout.write(
      `[deployment-assurance] evidence ${timing.name}: ${timing.seconds.toFixed(2)}s\n`
    );
  }
} catch (error) {
  process.stderr.write(`[deployment-assurance] FAIL ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  await provider?.close().catch(() => {});
  await registry?.close().catch(() => {});
  if (temporaryRoot && process.env.PRIVACYAI_KEEP_ASSURANCE_TEMP !== "1") {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  } else if (temporaryRoot) {
    process.stderr.write(`[deployment-assurance] retained ${temporaryRoot}\n`);
  }
}

async function step(name, operation) {
  const started = process.hrtime.bigint();
  process.stdout.write(`[deployment-assurance] running ${name}\n`);
  const value = await operation();
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  timings.push({ name, seconds });
  process.stdout.write(`[deployment-assurance] passed ${name} (${seconds.toFixed(2)}s)\n`);
  return value;
}

async function createToolEnvironment() {
  const home = join(temporaryRoot, "tool-home");
  const cache = join(temporaryRoot, "tool-cache");
  const temporary = join(temporaryRoot, "tool-tmp");
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(cache, { recursive: true, mode: 0o700 }),
    mkdir(temporary, { recursive: true, mode: 0o700 })
  ]);
  const userConfig = join(home, ".npmrc");
  await writeFile(userConfig, "", { mode: 0o600 });
  return sanitizedEnvironment({
    HOME: home,
    TMPDIR: temporary,
    npm_config_userconfig: userConfig,
    npm_config_cache: cache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false"
  });
}

async function packReleaseArtifacts() {
  const artifactRoot = join(temporaryRoot, "artifacts");
  await mkdir(artifactRoot, { mode: 0o700 });
  const sourceManifestBefore = await readFile(join(cliSourceRoot, "package.json"), "utf8");

  await runChecked("npm", [
    "pack",
    sdkSourceRoot,
    "--ignore-scripts",
    "--pack-destination",
    artifactRoot
  ], { cwd: repositoryRoot, env: toolEnvironment, timeoutMs: 60_000 });
  await runChecked("npm", [
    "run",
    "pack:production",
    "--",
    "--pack-destination",
    artifactRoot
  ], { cwd: cliSourceRoot, env: toolEnvironment, timeoutMs: 60_000 });

  assert.equal(
    await readFile(join(cliSourceRoot, "package.json"), "utf8"),
    sourceManifestBefore,
    "production packing must restore the source manifest"
  );
  await assertPathMissing(join(cliSourceRoot, "vendor"));
  await assertPathMissing(join(cliSourceRoot, ".privacyai-package.json.pack-backup"));
  await assertPathMissing(join(cliSourceRoot, ".privacyai-package-watch"));

  const names = (await readdir(artifactRoot)).filter(name => name.endsWith(".tgz"));
  const sdkName = names.find(name => name.startsWith("privacy-ai-sdk-"));
  const cliName = names.find(name => name.startsWith("privacy-ai-cli-"));
  assert.ok(sdkName, "SDK tarball was not produced");
  assert.ok(cliName, "CLI tarball was not produced");

  return {
    artifactRoot,
    sdkTarball: join(artifactRoot, sdkName),
    cliTarball: join(artifactRoot, cliName)
  };
}

async function validateReleaseArtifacts(artifacts) {
  const extractRoot = join(temporaryRoot, "extracted");
  const sdkExtract = join(extractRoot, "sdk");
  const cliExtract = join(extractRoot, "cli");
  await Promise.all([
    mkdir(sdkExtract, { recursive: true, mode: 0o700 }),
    mkdir(cliExtract, { recursive: true, mode: 0o700 })
  ]);
  await Promise.all([
    runChecked("tar", ["-xzf", artifacts.sdkTarball, "-C", sdkExtract]),
    runChecked("tar", ["-xzf", artifacts.cliTarball, "-C", cliExtract])
  ]);

  const sdkPackageRoot = join(sdkExtract, "package");
  const cliPackageRoot = join(cliExtract, "package");
  const sdkManifest = JSON.parse(await readFile(join(sdkPackageRoot, "package.json"), "utf8"));
  const cliManifest = JSON.parse(await readFile(join(cliPackageRoot, "package.json"), "utf8"));

  validateReleasePair(cliManifest, sdkManifest);
  validateCompatibility(cliManifest, {
    platform: process.platform,
    version: process.version
  });
  validateCompatibility(cliManifest, { platform: "darwin", version: "v18.18.0" });
  assert.throws(
    () => validateCompatibility(cliManifest, { platform: "win32", version: "v22.0.0" }),
    /unsupported platform/
  );
  assert.throws(
    () => validateCompatibility(cliManifest, { platform: "linux", version: "v18.17.0" }),
    /unsupported Node.js runtime/
  );

  assert.equal(cliManifest.name, "@privacy-ai/cli");
  assert.equal(cliManifest.bin?.privacyai, "bin/privacyai.js");
  assert.equal(cliManifest.dependencies?.["@privacy-ai/agent-bridge"], undefined);
  assert.equal(cliManifest.dependencies?.["@privacy-ai/sdk"], sdkManifest.version);
  assertNoWorkspaceSpecifiers(cliManifest);

  const cliTree = await hashTree(cliPackageRoot);
  for (const required of [
    "bin/privacyai.js",
    "src/cli.js",
    "src/bridge.js",
    "vendor/agent-bridge/src/cli.js",
    "vendor/agent-bridge/src/config-store.js",
    "vendor/agent-bridge/src/provider-registry.js",
    "vendor/agent-bridge/bin/privacyai-agent-hook.js"
  ]) {
    assert.ok(cliTree.has(required), `packed CLI is missing ${required}`);
  }
  for (const path of cliTree.keys()) {
    assert.doesNotMatch(path, /(?:^|\/)(?:\.env|\.npmrc|credentials?|.*\.pem)$/i);
    assert.doesNotMatch(path, /privacyai-package(?:\.json)?\.pack-backup|\.privacyai-package-watch/);
  }

  const sdkDigest = await sha256File(artifacts.sdkTarball);
  const cliDigest = await sha256File(artifacts.cliTarball);
  await verifyArtifactDigest(artifacts.sdkTarball, sdkDigest);
  await verifyArtifactDigest(artifacts.cliTarball, cliDigest);

  const tampered = join(artifacts.artifactRoot, "tampered-cli.tgz");
  await copyFile(artifacts.cliTarball, tampered);
  await appendFile(tampered, Buffer.from([0]));
  await assert.rejects(
    verifyArtifactDigest(tampered, cliDigest),
    /artifact digest mismatch/
  );

  const downgradedSdk = { ...sdkManifest, version: "0.0.1" };
  assert.throws(
    () => validateReleasePair(cliManifest, downgradedSdk),
    /SDK version mismatch/
  );

  return { sdkManifest, cliManifest, cliTree };
}

async function installReleaseArtifacts(artifacts, release) {
  const registryErrors = [];
  registry = await createLocalRegistry({
    repositoryRoot,
    storageRoot: join(temporaryRoot, "registry"),
    releases: [
      { manifest: release.sdkManifest, tarball: artifacts.sdkTarball },
      { manifest: release.cliManifest, tarball: artifacts.cliTarball }
    ],
    onError: error => registryErrors.push(error)
  });

  assert.ok(registry.packageCount > 2, "localhost registry did not index frozen dependencies");

  const installRoot = join(temporaryRoot, "install");
  const npmCache = join(temporaryRoot, "npm-cache");
  await Promise.all([
    mkdir(installRoot, { recursive: true, mode: 0o700 }),
    mkdir(npmCache, { recursive: true, mode: 0o700 })
  ]);

  const installResult = await runProcess("npm", [
    "install",
    "--prefix",
    installRoot,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    `--registry=${registry.url}`,
    artifacts.sdkTarball,
    artifacts.cliTarball
  ], {
    cwd: repositoryRoot,
    timeoutMs: 120_000,
    env: localOnlyNpmEnvironment(registry.url, npmCache)
  });
  assert.equal(installResult.code, 0, safeProcessFailure("local tarball install", installResult));
  assert.equal(registryErrors.length, 0, "localhost registry reported an internal error");
  assert.ok(registry.requests.length > 0, "artifact installation did not use the local registry");
  assert.ok(
    registry.requests.every(request => String(request.path || "").startsWith("/")),
    "registry request path was malformed"
  );

  const cli = join(installRoot, "node_modules", ".bin", "privacyai");
  const cliPackageRoot = join(installRoot, "node_modules", "@privacy-ai", "cli");
  const version = await runChecked(cli, ["--version"], { timeoutMs: 10_000 });
  assert.equal(version.stdout.trim(), `privacyai ${release.cliManifest.version}`);
  const help = await runChecked(cli, ["--help"], { timeoutMs: 10_000 });
  assert.match(help.stdout, /PrivacyAI protected agent shell/);
  assert.match(help.stdout, /privacyai onboard/);

  assert.deepEqual(
    await hashTree(cliPackageRoot),
    release.cliTree,
    "installed CLI bytes differ from the validated tarball"
  );
  return { cli, cliPackageRoot };
}

async function verifyInstalledMutationGate(installation, release) {
  const target = join(
    installation.cliPackageRoot,
    "vendor",
    "agent-bridge",
    "src",
    "cli.js"
  );
  const original = await readFile(target);
  await appendFile(target, "\n// deployment-assurance mutation\n");
  await assert.rejects(
    assertTreeMatches(installation.cliPackageRoot, release.cliTree),
    /installed package content changed/
  );
  await writeFile(target, original);
  await assertTreeMatches(installation.cliPackageRoot, release.cliTree);
}

async function prepareRuntimeFixtures(installation) {
  const runtimeRoot = join(temporaryRoot, "runtime");
  const home = join(runtimeRoot, "home");
  const state = join(runtimeRoot, "state");
  const temporary = join(runtimeRoot, "tmp");
  const fakeBin = join(runtimeRoot, "bin");
  for (const directory of [runtimeRoot, home, state, temporary, fakeBin]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  for (const name of ["agy"]) {
    const destination = join(fakeBin, name);
    await copyFile(fakeAgentFixture, destination);
    await chmod(destination, 0o755);
  }
  for (const [name, target] of [["node", process.execPath], ["python3", "/usr/bin/python3"]]) {
    const destination = join(fakeBin, name);
    await writeFile(destination, `#!/bin/sh\nexec ${target} \"$@\"\n`, { mode: 0o755 });
    await chmod(destination, 0o755);
  }

  provider = await startMockProvider();
  const logPath = join(state, "fake-agent.jsonl");
  const configPath = join(state, "config.json");
  const identityPath = join(state, "identity", "key-v1.json");
  const pidPath = join(state, "blocked-agent-pids.json");
  const env = sanitizedEnvironment({
    HOME: home,
    PATH: fakeBin,
    TMPDIR: temporary,
    PRIVACYAI_CONFIG_FILE: configPath,
    PRIVACYAI_CONTEXT_DB: join(state, "context.sqlite3"),
    PRIVACYAI_IDENTITY_KEY_FILE: identityPath,
    PRIVACYAI_LM_STUDIO_BASE_URL: `${provider.url}/v1`,
    PRIVACYAI_FAKE_AGENT_LOG: logPath,
    PRIVACYAI_FAKE_AGENT_PID_FILE: pidPath,
    npm_config_update_notifier: "false"
  });

  return {
    ...installation,
    runtimeRoot,
    home,
    state,
    temporary,
    fakeBin,
    logPath,
    configPath,
    identityPath,
    pidPath,
    env
  };
}

async function exerciseUnsafeOnboarding(runtime) {
  const unsafeRoot = join(runtime.runtimeRoot, "unsafe-onboard");
  const redirected = join(unsafeRoot, "redirected");
  const linkedDirectory = join(unsafeRoot, "config-link");
  await Promise.all([
    mkdir(redirected, { recursive: true, mode: 0o700 }),
    mkdir(join(unsafeRoot, "identity"), { recursive: true, mode: 0o700 })
  ]);
  await symlink(redirected, linkedDirectory, "dir");
  const result = await runPty(runtime.cli, ["onboard"], "1\n", {
    ...runtime.env,
    PRIVACYAI_CONFIG_FILE: join(linkedDirectory, "config.json"),
    PRIVACYAI_IDENTITY_KEY_FILE: join(unsafeRoot, "identity", "key.json")
  });
  assert.equal(result.code, 1, "onboarding through a symlinked config parent must fail");
  assertPrivacySafe(result, [PRIVATE_FIXTURE, PROVIDER_FAILURE_FIXTURE]);
  assert.match(result.output, /configuration is invalid or unreadable|internal failure/i);
  assert.deepEqual(await readdir(redirected), []);
  await rm(unsafeRoot, { recursive: true, force: true });
}

async function exerciseOnboarding(runtime) {
  const result = await runPty(runtime.cli, ["onboard"], "1\n", runtime.env);
  assert.equal(result.code, 0, safeProcessFailure("installed onboarding", result));
  assert.match(result.output, /PrivacyAI is ready\./);
  assert.match(result.output, /Model:\s+assurance-model/);
  assertPrivacySafe(result, [PRIVATE_FIXTURE, PROVIDER_FAILURE_FIXTURE]);

  const config = JSON.parse(await readFile(runtime.configPath, "utf8"));
  assert.equal(config.provider, "lm-studio");
  assert.equal(config.model, "assurance-model");
  assert.equal(config.baseURL, `${provider.url}/v1`);
  assert.equal((await stat(runtime.configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(runtime.configPath))).mode & 0o022, 0);
  await assertNotSymlink(runtime.configPath);
}

async function exerciseDoctorRecovery(runtime) {
  let result = await runCli(runtime, ["doctor", "--json"]);
  assert.equal(result.code, 0, safeProcessFailure("healthy doctor", result));
  let doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.localModel.ok, true);
  assert.equal(doctor.agents.find(agent => agent.name === "agy")?.ok, true);

  const beforeRetries = provider.state.chatRequests;
  provider.state.chatFailuresRemaining = 1;
  result = await runCli(runtime, ["doctor", "--json"]);
  assert.equal(result.code, 0, safeProcessFailure("transient doctor recovery", result));
  assert.ok(provider.state.chatRequests >= beforeRetries + 2);
  assertPrivacySafe(result, [PROVIDER_FAILURE_FIXTURE]);

  provider.state.discoveryFailure = true;
  result = await runCli(runtime, ["doctor", "--json"]);
  assert.equal(result.code, 1, "doctor must fail while the local provider is unavailable");
  doctor = JSON.parse(result.stdout);
  assert.equal(doctor.ok, false);
  assert.equal(doctor.localModel.ok, false);
  assert.equal(doctor.localModel.retryable, true);
  assertPrivacySafe(result, [PROVIDER_FAILURE_FIXTURE]);

  provider.state.discoveryFailure = false;
  result = await runCli(runtime, ["doctor", "--json"]);
  assert.equal(result.code, 0, safeProcessFailure("doctor after provider restart", result));
  assert.equal(JSON.parse(result.stdout).ok, true);
}

async function exerciseExecutableFailures(runtime) {
  const agy = join(runtime.fakeBin, "agy");
  const agyBackup = join(runtime.fakeBin, "agy.backup");
  await rename(agy, agyBackup);
  let result;
  try {
    result = await runCli(runtime, ["doctor", "--json"]);
    assert.equal(result.code, 0, "missing optional agents must not make doctor fail");
    const doctor = JSON.parse(result.stdout);
    const agent = doctor.agents.find(item => item.name === "agy");
    assert.deepEqual(
      { installed: agent.installed, ok: agent.ok, binary: agent.binary },
      { installed: false, ok: true, binary: null }
    );

    result = await runCli(runtime, [
      "agent",
      "agy",
      "--privacy-strict",
      "--print",
      "public fixture prompt"
    ]);
    assert.equal(result.code, 1, "dispatch must fail when the native executable is missing");
    assert.match(result.stderr, /internal failure/i);
  } finally {
    await rename(agyBackup, agy);
  }

  const codex = join(runtime.fakeBin, "codex");
  await copyFile(fakeAgentFixture, codex);
  await chmod(codex, 0o755);
  try {
    result = await runCli(runtime, ["doctor", "--json"], {
      env: {
        ...runtime.env,
        PRIVACYAI_FAKE_VERSION_FAILURE: "1",
        PRIVACYAI_FAKE_VERSION_SECRET: EXECUTABLE_FAILURE_FIXTURE
      }
    });
    assert.equal(result.code, 1, "a broken installed agent must make doctor fail");
    const doctor = JSON.parse(result.stdout);
    const agent = doctor.agents.find(item => item.name === "codex");
    assert.equal(agent.installed, true);
    assert.equal(agent.ok, false);
    assert.equal(agent.reason, "PrivacyAI encountered an internal failure.");
    assertPrivacySafe(result, [EXECUTABLE_FAILURE_FIXTURE]);
  } finally {
    await rm(codex, { force: true });
  }

  result = await runCli(runtime, ["doctor", "--json"]);
  assert.equal(result.code, 0, "doctor must recover after the corrupt executable is removed");
}

async function exerciseSuccessfulDispatch(runtime) {
  const result = await runCli(runtime, [
    "agent",
    "agy",
    "--privacy-strict",
    "--print",
    `Contact ${PRIVATE_FIXTURE} with the public deployment result.`
  ], { timeoutMs: 30_000 });
  assert.equal(result.code, 0, safeProcessFailure("installed AGY dispatch", result));
  assert.match(result.stdout, /fixture native agent completed/);
  assert.match(result.stderr, /AGY strict mode/);
  assertPrivacySafe(result, [PRIVATE_FIXTURE]);

  const entries = await readJsonLines(runtime.logPath);
  const latest = entries.at(-1);
  assert.equal(latest.executable, "agy");
  assert.equal(latest.flavor, "agy");
  assert.equal(latest.privacyMode, "strict");
  const forwarded = JSON.stringify(latest.args);
  assert.doesNotMatch(forwarded, new RegExp(escapeRegExp(PRIVATE_FIXTURE)));
  assert.match(forwarded, /\[PAI1_[A-Z0-9_]+\]/);
  await assertAgyCleanup(runtime);
}

async function exerciseFailedDispatch(runtime) {
  const result = await runCli(runtime, [
    "agent",
    "agy",
    "--privacy-strict",
    "--print",
    "public child failure fixture"
  ], {
    env: { ...runtime.env, PRIVACYAI_FAKE_AGENT_EXIT: "9" },
    timeoutMs: 30_000
  });
  assert.equal(result.code, 9, "native child exit code must be preserved");
  assertPrivacySafe(result, [PRIVATE_FIXTURE]);
  await assertAgyCleanup(runtime);
}

async function exerciseInterruptedDispatch(runtime) {
  await rm(runtime.pidPath, { force: true });
  let child;
  let pids;
  let treeReaped = false;

  try {
    child = spawn(runtime.cli, [
      "agent",
      "agy",
      "--privacy-strict",
      "--print",
      "public interruption fixture"
    ], {
      env: { ...runtime.env, PRIVACYAI_FAKE_AGENT_BLOCK: "1" },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = captureChild(child);
    pids = await waitForJsonFile(runtime.pidPath, 10_000);
    child.kill("SIGTERM");
    const result = await waitForChild(child, output, 12_000);
    assert.equal(result.code, 143, safeProcessFailure("interrupted AGY dispatch", result));
    assertPrivacySafe(result, [PRIVATE_FIXTURE]);

    await waitForCondition(
      () => !processExists(pids.parent) && !processExists(pids.descendant),
      5_000,
      "interrupted native process tree remained alive"
    );
    treeReaped = true;
    await assertAgyCleanup(runtime);

    const restarted = await runCli(runtime, [
      "agent",
      "agy",
      "--privacy-strict",
      "--print",
      "public restart fixture"
    ], { timeoutMs: 30_000 });
    assert.equal(restarted.code, 0, safeProcessFailure("dispatch after interruption", restarted));
    await assertAgyCleanup(runtime);
  } finally {
    if (!treeReaped) {
      await forceCleanupInterruptedFixture(child, pids, runtime.pidPath);
    }
  }
}

async function assertFinalFilesystemHygiene(runtime, options = {}) {
  if (options.requireIdentity) {
    const identityMetadata = await stat(runtime.identityPath);
    assert.equal(identityMetadata.mode & 0o777, 0o600);
    assert.equal(identityMetadata.nlink, 1);
    await assertNotSymlink(runtime.identityPath);
  } else {
    await assertPathMissing(runtime.identityPath);
  }

  const files = await listTree(runtime.runtimeRoot);
  const forbidden = files.filter(path =>
    /privacyai-agy-|\.privacyai\.lock$|session-map\.json$|\.tmp$/.test(path)
  );
  assert.deepEqual(forbidden, [], `ephemeral runtime state remains: ${forbidden.join(", ")}`);

  for (const path of files) {
    const metadata = await lstat(join(runtime.runtimeRoot, path));
    assert.equal(metadata.isSymbolicLink(), false, `unexpected persistent symlink: ${path}`);
    if (!metadata.isFile()) continue;
    const bytes = await readFile(join(runtime.runtimeRoot, path));
    const text = bytes.toString("utf8");
    assert.equal(text.includes(PRIVATE_FIXTURE), false, `private prompt persisted in ${path}`);
    assert.equal(
      text.includes(PROVIDER_FAILURE_FIXTURE) || text.includes(EXECUTABLE_FAILURE_FIXTURE),
      false,
      `failure credential persisted in ${path}`
    );
  }
}

async function startMockProvider() {
  const state = {
    chatFailuresRemaining: 0,
    discoveryFailure: false,
    chatRequests: 0,
    requests: []
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    state.requests.push({ method: request.method, url: request.url, body });

    if (request.url === "/api/v0/models") {
      if (state.discoveryFailure) {
        sendJson(response, 503, { error: PROVIDER_FAILURE_FIXTURE });
      } else {
        sendJson(response, 200, {
          data: [{
            id: "assurance-model",
            type: "llm",
            state: "loaded",
            quantization: "Q4",
            max_context_length: 8192
          }]
        });
      }
      return;
    }
    if (request.url === "/v1/models") {
      if (state.discoveryFailure) {
        sendJson(response, 503, { error: PROVIDER_FAILURE_FIXTURE });
      } else {
        sendJson(response, 200, { data: [{ id: "assurance-model" }] });
      }
      return;
    }
    if (request.url === "/v1/chat/completions") {
      state.chatRequests += 1;
      if (state.chatFailuresRemaining > 0) {
        state.chatFailuresRemaining -= 1;
        sendJson(response, 503, { error: PROVIDER_FAILURE_FIXTURE });
        return;
      }
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const latest = [...messages].reverse().find(message => message?.role === "user");
      const text = String(latest?.content || "");
      const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0];
      const spans = email ? [{ value: email, type: "EMAIL" }] : [];
      sendJson(response, 200, {
        choices: [{
          message: { content: JSON.stringify({ spans }) },
          finish_reason: "stop"
        }]
      });
      return;
    }
    sendJson(response, 404, { error: "fixture route not found" });
  });

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, rejectPromise) => {
      server.close(error => error ? rejectPromise(error) : resolvePromise());
    })
  };
}

async function runCli(runtime, args, options = {}) {
  return runProcess(runtime.cli, args, {
    env: options.env || runtime.env,
    timeoutMs: options.timeoutMs || 20_000
  });
}

async function runPty(cli, args, input, env) {
  const result = await runProcess("python3", [
    ptyRunner,
    "--input",
    input,
    "--timeout",
    "30",
    "--",
    cli,
    ...args
  ], { env, timeoutMs: 35_000 });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function runChecked(command, args, options = {}) {
  return runProcess(command, args, options).then(result => {
    if (result.code !== 0) throw new Error(safeProcessFailure(command, result));
    return result;
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || toolEnvironment || sanitizedEnvironment(),
      detached: process.platform !== "win32",
      stdio: [options.input == null ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    let pendingError = null;
    let forceTimer = null;

    const requestTermination = error => {
      if (!pendingError) pendingError = error;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (!forceTimer) {
        forceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2_000);
      }
    };
    const append = (target, chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > MAX_CAPTURE_BYTES) {
        requestTermination(new Error("process output exceeded the deployment-assurance limit"));
        return target;
      }
      return target + chunk.toString("utf8");
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      const finalError = error || pendingError;
      if (finalError) rejectPromise(finalError);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      requestTermination(
        new Error(`${basename(command)} exceeded its deployment-assurance timeout`)
      );
    }, options.timeoutMs || 30_000);

    child.stdout.on("data", chunk => { stdout = append(stdout, chunk); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk); });
    child.once("error", error => finish(error));
    child.once("close", (code, signal) => finish(null, {
      code: signal ? signalExitCode(signal) : code ?? 1,
      signal,
      stdout,
      stderr
    }));
    if (options.input != null) child.stdin.end(options.input);
  });
}

function killProcessGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function captureChild(child) {
  const output = { stdout: "", stderr: "", bytes: 0, error: null };
  const append = (name, chunk) => {
    output.bytes += chunk.length;
    if (output.bytes > MAX_CAPTURE_BYTES) {
      if (!output.error) {
        output.error = new Error("process output exceeded the deployment-assurance limit");
        child.kill("SIGTERM");
      }
      return;
    }
    output[name] += chunk.toString("utf8");
  };
  child.stdout.on("data", chunk => append("stdout", chunk));
  child.stderr.on("data", chunk => append("stderr", chunk));
  return output;
}

function waitForChild(child, output, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timeoutError = null;
    let forceTimer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      const finalError = error || output.error || timeoutError;
      if (finalError) rejectPromise(finalError);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      timeoutError = new Error("interrupted child did not settle before the timeout");
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), 2_000);
    }, timeoutMs);
    child.once("error", error => finish(error));
    child.once("close", (code, signal) => finish(null, {
      code: signal ? signalExitCode(signal) : code ?? 1,
      signal,
      stdout: output.stdout,
      stderr: output.stderr
    }));
  });
}

async function forceCleanupInterruptedFixture(child, pids, pidPath) {
  if (!pids) {
    try {
      pids = JSON.parse(await readFile(pidPath, "utf8"));
    } catch {
      pids = null;
    }
  }

  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await delay(100);
  }
  for (const pid of [pids?.descendant, pids?.parent]) {
    if (Number.isInteger(pid)) killPid(pid, "SIGKILL");
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    killProcessGroup(child, "SIGKILL");
  }
  await waitForCondition(
    () => [child?.pid, pids?.parent, pids?.descendant]
      .filter(Number.isInteger)
      .every(pid => !processExists(pid)),
    2_000,
    "could not clean interrupted fixture processes"
  );
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function waitForJsonFile(path, timeoutMs) {
  let value;
  await waitForCondition(async () => {
    try {
      value = JSON.parse(await readFile(path, "utf8"));
      return Number.isInteger(value.parent) && Number.isInteger(value.descendant);
    } catch {
      return false;
    }
  }, timeoutMs, "native child did not publish its process fixture");
  return value;
}

async function waitForCondition(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(message);
}

function processExists(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function assertAgyCleanup(runtime) {
  await assertPathMissing(join(runtime.home, ".gemini", "config", "hooks.json.privacyai.lock"));
  const hooksPath = join(runtime.home, ".gemini", "config", "hooks.json");
  try {
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.deepEqual(hooks, {});
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const tempEntries = await readdir(runtime.temporary);
  assert.deepEqual(
    tempEntries.filter(name => name.startsWith("privacyai-agy-")),
    []
  );
}

async function readJsonLines(path) {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function validateReleasePair(cliManifest, sdkManifest) {
  const requiredSdk = cliManifest.dependencies?.["@privacy-ai/sdk"];
  if (requiredSdk !== sdkManifest.version) {
    throw new Error(
      `SDK version mismatch: CLI requires ${requiredSdk || "none"}, artifact is ${sdkManifest.version}`
    );
  }
  if (String(requiredSdk).startsWith("workspace:")) {
    throw new Error("release CLI retained a workspace SDK dependency");
  }
}

function validateCompatibility(manifest, runtime) {
  const platforms = Array.isArray(manifest.os) ? manifest.os : [];
  if (!platforms.includes(runtime.platform)) {
    throw new Error(`unsupported platform: ${runtime.platform}`);
  }
  const match = String(manifest.engines?.node || "").match(/^>=(\d+)\.(\d+)$/);
  if (!match) throw new Error("release CLI has an unsupported Node.js engine declaration");
  const actual = String(runtime.version).match(/^v?(\d+)\.(\d+)/);
  if (!actual) throw new Error("unsupported Node.js runtime: unknown version");
  const minimum = [Number(match[1]), Number(match[2])];
  const current = [Number(actual[1]), Number(actual[2])];
  if (current[0] < minimum[0] || (current[0] === minimum[0] && current[1] < minimum[1])) {
    throw new Error(`unsupported Node.js runtime: ${runtime.version}`);
  }
}

function assertNoWorkspaceSpecifiers(value, path = "package.json") {
  if (typeof value === "string") {
    assert.equal(value.startsWith("workspace:"), false, `${path} retained a workspace specifier`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoWorkspaceSpecifiers(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assertNoWorkspaceSpecifiers(item, `${path}.${key}`);
  }
}

async function verifyArtifactDigest(path, expected) {
  if (await sha256File(path) !== expected) throw new Error("artifact digest mismatch");
}

async function assertTreeMatches(root, expected) {
  const actual = await hashTree(root);
  if (!mapsEqual(actual, expected)) throw new Error("installed package content changed");
}

async function hashTree(root) {
  const result = new Map();
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split("\\").join("/");
      const metadata = await lstat(path);
      assert.equal(metadata.isSymbolicLink(), false, `package contains a symlink: ${name}`);
      if (metadata.isDirectory()) await walk(path);
      else if (metadata.isFile()) {
        result.set(name, createHash("sha256").update(await readFile(path)).digest("hex"));
      } else {
        throw new Error(`package contains unsupported entry: ${name}`);
      }
    }
  }
  await walk(root);
  return result;
}

function mapsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function localOnlyNpmEnvironment(registryURL, cache) {
  return {
    ...toolEnvironment,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    npm_config_registry: registryURL,
    npm_config_cache: cache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_fetch_retries: "0",
    npm_config_update_notifier: "false"
  };
}

function sanitizedEnvironment(overrides = {}) {
  const env = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI"]) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return { ...env, ...overrides };
}

async function listTree(root) {
  const result = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split("\\").join("/");
      result.push(name);
      if (entry.isDirectory()) await walk(path);
    }
  }
  await walk(root);
  return result.sort();
}

async function assertNotSymlink(path) {
  assert.equal((await lstat(path)).isSymbolicLink(), false, `${path} must not be a symlink`);
}

async function assertPathMissing(path) {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${path} unexpectedly remains as a symlink to ${await readlink(path)}`);
    }
    throw new Error(`${path} unexpectedly remains`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertPrivacySafe(result, sentinels) {
  const output = `${result.stdout || ""}${result.stderr || ""}${result.output || ""}`;
  for (const sentinel of sentinels) {
    assert.equal(output.includes(sentinel), false, "privacy-safe output leaked a fixture sentinel");
  }
}

function safeProcessFailure(label, result) {
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`
    .replaceAll(PRIVATE_FIXTURE, "[PRIVATE_FIXTURE]")
    .replaceAll(PROVIDER_FAILURE_FIXTURE, "[PROVIDER_FAILURE_FIXTURE]")
    .replaceAll(EXECUTABLE_FAILURE_FIXTURE, "[EXECUTABLE_FAILURE_FIXTURE]")
    .trim()
    .slice(-2000);
  return `${label} exited ${result.code}${combined ? `: ${combined}` : ""}`;
}

function safeErrorMessage(error) {
  return String(error?.stack || error || "unknown deployment assurance failure")
    .replaceAll(PRIVATE_FIXTURE, "[PRIVATE_FIXTURE]")
    .replaceAll(PROVIDER_FAILURE_FIXTURE, "[PROVIDER_FAILURE_FIXTURE]")
    .replaceAll(EXECUTABLE_FAILURE_FIXTURE, "[EXECUTABLE_FAILURE_FIXTURE]")
    .slice(0, 8000);
}

function signalExitCode(signal) {
  const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15, SIGKILL: 9 };
  return 128 + (signals[signal] || 0);
}

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": bytes.length,
    "cache-control": "no-store",
    connection: "close"
  });
  response.end(bytes);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
