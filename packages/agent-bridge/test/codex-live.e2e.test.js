import { createTestTempDir } from "./test-temp-dir.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCodexProviderArgs,
  resolveExecutable,
  startCodexProviderGateway
} from "../src/index.js";

const ENABLED = process.env.PRIVACYAI_CODEX_LIVE_E2E === "1";
const MODEL = process.env.PRIVACYAI_CODEX_TEST_MODEL || "gpt-5.4-mini";
const PARITY_MODEL = process.env.PRIVACYAI_CODEX_PARITY_MODEL || "gpt-5.6-luna";
const PRIVATE_EMAIL = "gateway-live-private@example.test";
const PRIVATE_KEY = "sk-live-e2e-fake-1234567890";
const EMAIL_PLACEHOLDER = "[EMAIL_1]";
const KEY_PLACEHOLDER = "[API_KEY_1]";

test(
  "live GPT-5.4 mini keeps native Codex file, patch, and terminal work behind the provider gateway",
  { skip: !ENABLED, timeout: 240_000 },
  async t => {
    const codex = await resolveExecutable("codex");
    assert.ok(codex, "Codex must be installed for the live E2E");

    const sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    await stat(join(sourceHome, "auth.json"));

    const root = await createTestTempDir("privacyai-codex-live-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const codexHome = join(root, "codex-home");
    const vaultDir = join(root, "vault");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await copyPrivateFile(join(sourceHome, "auth.json"), join(codexHome, "auth.json"));
    await copyOptionalPrivateFile(
      join(sourceHome, "installation_id"),
      join(codexHome, "installation_id")
    );

    await writeFile(
      join(workspace, "private-input.txt"),
      `${PRIVATE_EMAIL}\n${PRIVATE_KEY}\n`,
      { mode: 0o600 }
    );
    await writeFile(join(workspace, "app.txt"), "EMAIL=PLACEHOLDER\nKEY=PLACEHOLDER\n", {
      mode: 0o600
    });

    const observedBodies = [];
    const gatewayErrors = [];
    const gateway = await startCodexProviderGateway({
      baseDir: vaultDir,
      sanitizer: deterministicSanitizer,
      onSanitizedRequest: body => {
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes(PRIVATE_EMAIL), false);
        assert.equal(serialized.includes(PRIVATE_KEY), false);
        observedBodies.push(serialized);
      },
      onGatewayError: error => gatewayErrors.push(error)
    });
    t.after(() => gateway.close());

    const prompt = [
      "Work only in the current temporary directory.",
      "Read private-input.txt using a normal Codex file or terminal tool.",
      "Create result.txt containing exactly the two lines from private-input.txt.",
      "You must use apply_patch to modify app.txt so EMAIL and KEY contain the corresponding values from private-input.txt.",
      "Run terminal verification commands that compare result.txt with private-input.txt and verify app.txt contains both values.",
      "Do not print file contents in the final answer. Finish with exactly LIVE_E2E_OK after verification succeeds."
    ].join(" ");

    const args = [
      ...buildCodexProviderArgs(gateway.baseURL, {
        requestMaxRetries: 0,
        streamMaxRetries: 0
      }),
      "-m",
      MODEL,
      "-a",
      "never",
      "-s",
      "workspace-write",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      prompt
    ];
    const result = await run(codex, args, {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        NO_COLOR: "1"
      }
    });

    assert.equal(
      result.code,
      0,
      `Live Codex ${MODEL} failed without exposing auth material. Gateway diagnostics: ${JSON.stringify(gatewayErrors)}\n${safeTail(result.stderr)}\n${safeTail(result.stdout)}`
    );
    assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), `${PRIVATE_EMAIL}\n${PRIVATE_KEY}\n`);
    assert.equal(
      await readFile(join(workspace, "app.txt"), "utf8"),
      `EMAIL=${PRIVATE_EMAIL}\nKEY=${PRIVATE_KEY}\n`
    );
    assert.equal(observedBodies.length >= 3, true, "Expected multiple real Codex model turns");
    assert.equal(observedBodies.some(body => body.includes(EMAIL_PLACEHOLDER)), true);
    assert.equal(observedBodies.some(body => body.includes(KEY_PLACEHOLDER)), true);
    assert.equal(result.stdout.includes("LIVE_E2E_OK"), true);
    assert.equal(
      /file.?change|apply_patch/i.test(result.stdout),
      true,
      "Codex JSONL should show a native file-change/apply_patch lifecycle"
    );
  }
);

test(
  "live GPT-5.6 Luna keeps subagents, shell, web search, and image generation behind the provider gateway",
  { skip: !ENABLED, timeout: 360_000 },
  async t => {
    const codex = await resolveExecutable("codex");
    assert.ok(codex, "Codex must be installed for the live parity E2E");

    const sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    await stat(join(sourceHome, "auth.json"));

    const root = await createTestTempDir("privacyai-codex-parity-live-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const codexHome = join(root, "codex-home");
    const vaultDir = join(root, "vault");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await copyPrivateFile(join(sourceHome, "auth.json"), join(codexHome, "auth.json"));
    await copyOptionalPrivateFile(
      join(sourceHome, "installation_id"),
      join(codexHome, "installation_id")
    );
    await writeFile(
      join(workspace, "private-input.txt"),
      `${PRIVATE_EMAIL}\n${PRIVATE_KEY}\n`,
      { mode: 0o600 }
    );

    const observed = [];
    const providerEvents = [];
    const gatewayErrors = [];
    const gateway = await startCodexProviderGateway({
      baseDir: vaultDir,
      sanitizer: deterministicSanitizer,
      hostedToolPolicy: { webSearch: true, imageGeneration: true },
      onSanitizedRequest: (body, metadata) => {
        const serialized = JSON.stringify(body);
        assert.equal(serialized.includes(PRIVATE_EMAIL), false);
        assert.equal(serialized.includes(PRIVATE_KEY), false);
        observed.push({
          sessionKey: metadata.sessionKey,
          route: metadata.route,
          body: serialized,
          toolTypes: Array.isArray(body.tools) ? body.tools.map(tool => tool.type) : []
        });
      },
      onProviderEvent: event => providerEvents.push(event),
      onGatewayError: error => gatewayErrors.push(error)
    });
    t.after(() => gateway.close());

    const prompt = [
      "Work only in the current temporary directory.",
      `For privacy-boundary verification, the synthetic private email is ${PRIVATE_EMAIL} and the synthetic private key is ${PRIVATE_KEY}. Treat both as private and never repeat them in output.`,
      "You must use the collaboration spawn_agent tool to delegate this exact child task: read private-input.txt using shell, create child-copy.txt containing exactly the same two lines, verify the files are byte-identical, and return CHILD_COPY_OK. Do not create child-copy.txt in the parent; the spawned child must do it.",
      "Wait for that child to finish using the collaboration agent tools.",
      "In the parent, use the native web_search tool to search the public web for the official OpenAI Codex page. Do not use curl or shell for the search.",
      "Also in the parent, use the native image_generation tool to generate a simple image of one blue circle centered on a plain white background. The image itself does not need to be saved to the workspace.",
      "Finally use shell in the parent to verify child-copy.txt is byte-identical to private-input.txt.",
      "Do not print the file contents or the synthetic private values in the final answer.",
      "Only after the child, web search, image generation, and final shell verification all succeed, finish with exactly PARITY_E2E_OK."
    ].join(" ");

    const args = [
      ...buildCodexProviderArgs(gateway.baseURL, {
        requestMaxRetries: 0,
        streamMaxRetries: 0
      }),
      "--search",
      "--enable",
      "image_generation",
      "-m",
      PARITY_MODEL,
      "-a",
      "never",
      "-s",
      "workspace-write",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--json",
      prompt
    ];
    const result = await run(codex, args, {
      cwd: workspace,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        NO_COLOR: "1"
      }
    });

    assert.equal(
      result.code,
      0,
      `Live Codex ${PARITY_MODEL} parity run failed. Gateway diagnostics: ${JSON.stringify(gatewayErrors)}\n${safeTail(result.stderr)}\n${safeTail(result.stdout)}`
    );
    assert.equal(
      await readFile(join(workspace, "child-copy.txt"), "utf8"),
      `${PRIVATE_EMAIL}\n${PRIVATE_KEY}\n`
    );
    assert.equal(result.stdout.includes("PARITY_E2E_OK"), true);
    assert.equal(observed.length >= 4, true, "Expected multiple parent and child model turns");
    assert.equal(
      new Set(observed.map(entry => entry.sessionKey)).size >= 2,
      true,
      "Expected at least one distinct child Codex provider session"
    );
    assert.equal(
      observed.some(entry => entry.toolTypes.includes("web_search")),
      true,
      "Expected the sanitized provider request to expose native web search"
    );
    assert.equal(
      observed.some(entry => entry.toolTypes.includes("image_generation")),
      true,
      "Expected the sanitized provider request to expose native image generation"
    );
    assert.equal(
      observed.some(entry => entry.body.includes(EMAIL_PLACEHOLDER)),
      true,
      "Expected synthetic email placeholder in a model-bound request"
    );
    assert.equal(
      observed.some(entry => entry.body.includes(KEY_PLACEHOLDER)),
      true,
      "Expected synthetic key placeholder in a model-bound request"
    );
    assert.equal(
      /spawn_agent|collaboration/i.test(result.stdout),
      true,
      "Codex JSONL should show native collaboration/subagent activity"
    );
    assert.equal(
      providerEvents.some(event =>
        event.type.startsWith("response.web_search_call.") || event.itemType === "web_search_call"
      ),
      true,
      "PrivacyAI should observe a real native web-search provider event"
    );
    assert.equal(
      observed.some(entry => entry.route === "images_generations"),
      true,
      "PrivacyAI should observe a real sanitized native image-generation request"
    );
  }
);

async function deterministicSanitizer(text) {
  let sanitizedPrompt = text;
  const sessionMap = {};
  if (sanitizedPrompt.includes(PRIVATE_EMAIL)) {
    sanitizedPrompt = sanitizedPrompt.replaceAll(PRIVATE_EMAIL, EMAIL_PLACEHOLDER);
    sessionMap[EMAIL_PLACEHOLDER] = PRIVATE_EMAIL;
  }
  if (sanitizedPrompt.includes(PRIVATE_KEY)) {
    sanitizedPrompt = sanitizedPrompt.replaceAll(PRIVATE_KEY, KEY_PLACEHOLDER);
    sessionMap[KEY_PLACEHOLDER] = PRIVATE_KEY;
  }
  return { sanitizedPrompt, sessionMap };
}

async function copyPrivateFile(source, target) {
  await copyFile(source, target);
  await chmod(target, 0o600);
}

async function copyOptionalPrivateFile(source, target) {
  try {
    await copyPrivateFile(source, target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({
        code: signal ? 128 : code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function safeTail(value, max = 6000) {
  const text = String(value || "")
    .replaceAll(PRIVATE_EMAIL, "[fake-email]")
    .replaceAll(PRIVATE_KEY, "[fake-key]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted-long-token]");
  return text.slice(-max);
}
