import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
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

    const root = await mkdtemp(join(tmpdir(), "privacyai-codex-live-"));
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
