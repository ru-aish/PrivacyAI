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

import { createTesseractOcrEngine, normalizeImage } from "@privacy-ai/sdk/image";

import {
  SessionVault,
  launchAgy,
  loadPrivacyConfig,
  resolveExecutable
} from "../src/index.js";

const ENABLED = process.env.PRIVACYAI_AGY_IMAGE_LIVE_E2E === "1";
const MODEL = process.env.PRIVACYAI_AGY_IMAGE_TEST_MODEL || "Gemini 3.5 Flash (High)";
const PRIVATE_EMAIL = "agy.image.private@example.test";
const EVIDENCE_DIR = process.env.PRIVACYAI_AGY_IMAGE_EVIDENCE_DIR || null;

const MCP_SERVER_SOURCE = String.raw`import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const imagePath = process.env.PRIVACYAI_TEST_IMAGE;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const result = (id, value) => send({ jsonrpc: "2.0", id, result: value });
const failure = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  const { id, method, params } = request;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "privacyai-image-e2e", version: "1.0.0" }
    });
  } else if (method === "ping") {
    result(id, {});
  } else if (method === "tools/list") {
    result(id, {
      tools: [{
        name: "show_private_image",
        description: "Call this tool directly with an empty object. It returns a screenshot; inspect the image and report the OWNER field exactly. Do not inspect files or schemas first.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }]
    });
  } else if (method === "tools/call") {
    if (params?.name !== "show_private_image") {
      failure(id, -32602, "Unknown tool");
      continue;
    }
    const data = (await readFile(imagePath)).toString("base64");
    result(id, {
      content: [
        { type: "text", text: "Read the OWNER field from the attached screenshot." },
        { type: "image", data, mimeType: "image/png" }
      ]
    });
  } else if (id != null) {
    failure(id, -32601, "Method not found");
  }
}
`;

test(
  "live AGY image tool traffic is OCR-sanitized before Gemini and restored only locally",
  { skip: !ENABLED, timeout: 420_000 },
  async t => {
    const agy = process.env.PRIVACYAI_AGY_BINARY || await resolveExecutable("agy");
    assert.ok(agy, "AGY must be installed for the live image E2E");

    const loaded = await loadPrivacyConfig({
      path: process.env.PRIVACYAI_CONFIG_FILE
    });
    assert.equal(loaded.configured, true, "PrivacyAI must be configured for the live image E2E");
    assert.equal(loaded.config.provider, "ollama", "The AGY image E2E requires Ollama");

    const sourceGeminiDir = process.env.GEMINI_DIR || join(homedir(), ".gemini");
    const sourceCliDir = join(sourceGeminiDir, "antigravity-cli");
    await stat(join(sourceCliDir, "antigravity-oauth-token"));

    const root = await createTestTempDir("privacyai-agy-image-live-");
    const geminiDir = join(root, ".gemini");
    const cliDir = join(geminiDir, "antigravity-cli");
    const configDir = join(geminiDir, "config");
    const vaultDir = join(root, "vault");
    const imagePath = join(root, "private-input.png");
    const serverPath = join(root, "image-mcp.mjs");
    const evidenceDir = EVIDENCE_DIR || join(root, "evidence");
    await mkdir(cliDir, { recursive: true, mode: 0o700 });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));

    for (const name of [
      "antigravity-oauth-token",
      "installation_id",
      "jetski_state.pbtxt",
      "settings.json"
    ]) {
      await copyOptionalPrivateFile(join(sourceCliDir, name), join(cliDir, name));
    }
    await copyOptionalPrivateFile(
      join(sourceGeminiDir, "config", "config.json"),
      join(configDir, "config.json")
    );

    await writeFile(serverPath, MCP_SERVER_SOURCE, { mode: 0o700 });
    await writeFile(
      join(configDir, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          privacy_image_e2e: {
            command: process.execPath,
            args: [serverPath],
            env: { PRIVACYAI_TEST_IMAGE: imagePath }
          }
        }
      }, null, 2),
      { mode: 0o600 }
    );
    await createPrivateScreenshot(imagePath);

    const observedBodies = [];
    const providerImages = [];
    const sessionKeys = new Set();
    const proxyErrors = [];
    let requestIndex = 0;
    const prompt = [
      "Immediately call the available MCP tool whose name ends with show_private_image exactly once using an empty object.",
      "Do not inspect schemas, files, resources, permissions, or call any other tool first.",
      "Wait for its result and inspect the returned screenshot image.",
      `The same owner value is present here for synchronization: ${PRIVATE_EMAIL}.`,
      "Your final answer must be exactly OWNER=<the value shown after OWNER: in the screenshot>."
    ].join(" ");

    const result = await launchAgy([
      "--print",
      prompt,
      "--model",
      MODEL,
      "--dangerously-skip-permissions",
      "--print-timeout",
      "6m"
    ], {
      binary: agy,
      cwd: root,
      configPath: loaded.path,
      baseDir: vaultDir,
      env: {
        HOME: root,
        GEMINI_DIR: geminiDir,
        XDG_CONFIG_HOME: join(root, ".config"),
        XDG_CACHE_HOME: join(root, ".cache"),
        XDG_DATA_HOME: join(root, ".local", "share")
      },
      onProxyError: event => proxyErrors.push(event),
      async onSanitizedRequest(body, metadata) {
        requestIndex += 1;
        const serialized = JSON.stringify(body);
        assert.equal(serialized.toLowerCase().includes(PRIVATE_EMAIL.toLowerCase()), false);
        observedBodies.push(serialized);
        sessionKeys.add(metadata.sessionKey);
        await writeFile(
          join(evidenceDir, `provider-request-${String(requestIndex).padStart(2, "0")}.json`),
          serialized,
          { mode: 0o600 }
        );
        for (const image of collectInlineImages(body)) {
          const buffer = Buffer.from(image.inlineData.data, "base64");
          providerImages.push({ ...image, buffer, requestIndex });
          const imageNumber = providerImages.length;
          await writeFile(
            join(evidenceDir, `provider-image-${String(imageNumber).padStart(2, "0")}.png`),
            buffer,
            { mode: 0o600 }
          );
          await writeFile(
            join(evidenceDir, `provider-image-${String(imageNumber).padStart(2, "0")}.json`),
            JSON.stringify({
              requestIndex,
              path: image.path,
              mimeType: image.inlineData.mimeType,
              bytes: buffer.length
            }, null, 2),
            { mode: 0o600 }
          );
        }
      },
      runChild: captureChild
    });

    assert.equal(
      result.code,
      0,
      `Live AGY ${MODEL} failed. Proxy diagnostics: ${JSON.stringify(proxyErrors)}\n${safeTail(result.stderr)}\n${safeTail(result.stdout)}`
    );
    assert.equal(observedBodies.length >= 2, true, "Expected prompt and tool-result model turns");
    assert.equal(providerImages.length, 1, "Expected exactly one provider-bound AGY image");
    assert.match(
      providerImages[0].path,
      /^request\.contents\.\d+\.parts\.\d+\.functionResponse\.parts\.\d+\.inlineData$/,
      "Expected the image only in an AGY tool-result part"
    );
    assert.equal(sessionKeys.size, 1, "Expected one AGY privacy session");

    const sessionKey = [...sessionKeys][0];
    const session = await new SessionVault({ baseDir: vaultDir }).load(sessionKey);
    const aliases = Object.entries(session.sessionMap)
      .filter(([, original]) => original === PRIVATE_EMAIL)
      .map(([alias]) => alias);
    assert.equal(aliases.length >= 1, true, "Expected a session alias for the private image value");

    const ocr = createTesseractOcrEngine();
    const providerOcrRecords = [];
    try {
      for (const image of providerImages) {
        const lines = await ocr.recognize(image.buffer);
        const text = lines.map(line => line.text).join("\n");
        const normalized = normalizeOcr(text);
        assert.equal(
          normalized.includes(normalizeOcr(PRIVATE_EMAIL)),
          false,
          `Private text remained in provider image at ${image.path}`
        );
        providerOcrRecords.push({ path: image.path, text, normalized });
      }
    } finally {
      await ocr.close();
    }

    const promptBodies = observedBodies.slice(0, providerImages[0].requestIndex - 1);
    assert.equal(promptBodies.length >= 1, true, "Expected a provider prompt before the image turn");
    const sharedAlias = aliases.find(alias =>
      promptBodies.some(body => body.includes(alias)) &&
      providerOcrRecords.every(record => record.normalized.includes(normalizeOcr(alias)))
    );
    assert.ok(sharedAlias, "Expected the same safe alias in a pre-image prompt and every image OCR result");

    const ownerLines = result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith("OWNER="));
    assert.deepEqual(ownerLines, [`OWNER=${PRIVATE_EMAIL}`]);
    assert.equal(result.stdout.split(PRIVATE_EMAIL).length - 1, 1);
    const localOutput = ownerLines[0];
    assert.equal(localOutput.includes(sharedAlias), false);

    const privateNeedle = PRIVATE_EMAIL.toLowerCase();
    const summary = {
      command: `${agy} --print <prompt> --model ${MODEL} --dangerously-skip-permissions --print-timeout 6m`,
      model: MODEL,
      privacyProvider: loaded.config.provider,
      privacyModel: loaded.config.model,
      requestCount: observedBodies.length,
      providerImageCount: providerImages.length,
      providerImagePath: providerImages[0].path,
      providerImagePaths: providerImages.map(image => image.path),
      privatePresentInProviderRequests: observedBodies.some(body => body.toLowerCase().includes(privateNeedle)),
      privatePresentInProviderImageOcr: providerOcrRecords.some(record =>
        record.normalized.includes(normalizeOcr(PRIVATE_EMAIL))
      ),
      sharedAlias,
      providerImageOcr: providerOcrRecords.map(record => record.text).join("\n---\n"),
      localOutput
    };
    await writeFile(
      join(evidenceDir, "run-summary.json"),
      JSON.stringify(summary, null, 2),
      { mode: 0o600 }
    );
    t.diagnostic(JSON.stringify(summary));
  }
);

async function createPrivateScreenshot(target) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="360">` +
    `<rect width="1400" height="360" fill="#111827"/>` +
    `<text x="55" y="85" fill="#93c5fd" font-family="DejaVu Sans Mono" font-size="34">` +
    `PRIVACYAI AGY IMAGE E2E</text>` +
    `<text x="55" y="185" fill="#f8fafc" font-family="DejaVu Sans Mono" font-size="46">` +
    `OWNER: ${PRIVATE_EMAIL}</text>` +
    `<text x="55" y="270" fill="#fbbf24" font-family="DejaVu Sans Mono" font-size="30">` +
    `Read the owner from this screenshot.</text></svg>`
  );
  await writeFile(target, await normalizeImage(svg), { mode: 0o600 });
}

function collectInlineImages(value, path = [], output = []) {
  if (!value || typeof value !== "object") return output;
  if (!Array.isArray(value) && value.inlineData && typeof value.inlineData === "object") {
    output.push({ path: [...path, "inlineData"].join("."), inlineData: value.inlineData });
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectInlineImages(entry, [...path, index], output));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      collectInlineImages(entry, [...path, key], output);
    }
  }
  return output;
}

function captureChild(command, args, options) {
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

async function copyOptionalPrivateFile(source, target) {
  try {
    await copyFile(source, target);
    await chmod(target, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function normalizeOcr(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function safeTail(value, max = 6000) {
  return String(value || "")
    .replaceAll(PRIVATE_EMAIL, "[fake-email]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted-long-token]")
    .slice(-max);
}
