import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";

import { resolveExecutable, verifyNativeExecutable } from "../src/index.js";
import { createTestTempDir } from "./test-temp-dir.js";

const linuxPlatform = process.arch === "x64"
  ? {
      packageName: "codex-linux-x64",
      versionSuffix: "linux-x64",
      target: "x86_64-unknown-linux-musl"
    }
  : process.arch === "arm64"
    ? {
        packageName: "codex-linux-arm64",
        versionSuffix: "linux-arm64",
        target: "aarch64-unknown-linux-musl"
      }
    : null;

async function createCodexInstall(root, name, options = {}) {
  const prefix = join(root, name);
  const binDir = join(prefix, "bin");
  const packageRoot = join(prefix, "lib", "node_modules", "@openai", "codex");
  const launcher = join(packageRoot, "bin", "codex.js");
  const version = options.version || "0.144.5";
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@openai/codex", version })
  );
  await writeFile(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
  await chmod(launcher, 0o755);
  await symlink(launcher, join(binDir, "codex"));

  const platformRoot = options.layout === "hoisted"
    ? join(packageRoot, "..", linuxPlatform.packageName)
    : join(packageRoot, "node_modules", "@openai", linuxPlatform.packageName);
  const vendorRoot = join(platformRoot, "vendor", linuxPlatform.target);
  const native = join(vendorRoot, "bin", "codex");
  await mkdir(join(vendorRoot, "bin"), { recursive: true });
  await writeFile(native, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o755 });
  await chmod(native, 0o755);

  if (options.complete !== false) {
    await writeFile(
      join(platformRoot, "package.json"),
      JSON.stringify({
        name: "@openai/codex",
        version: `${version}-${linuxPlatform.versionSuffix}`
      })
    );
    await writeFile(
      join(vendorRoot, "codex-package.json"),
      JSON.stringify({
        layoutVersion: 1,
        version,
        target: linuxPlatform.target,
        variant: "codex",
        entrypoint: "bin/codex",
        resourcesDir: "codex-resources",
        pathDir: "codex-path"
      })
    );
  }

  return { binDir, native };
}

test("Codex resolution accepts npm's hoisted platform-package layout", {
  skip: process.platform !== "linux" || !linuxPlatform
}, async () => {
  const root = await createTestTempDir("privacyai-codex-hoisted-resolution-");
  const install = await createCodexInstall(root, "hoisted", {
    layout: "hoisted",
    version: "0.152.1"
  });

  assert.equal(
    await resolveExecutable("codex", { path: install.binDir }),
    install.native
  );
  assert.deepEqual(
    await verifyNativeExecutable("codex", install.native, { timeoutMs: 1000 }),
    { version: "codex-cli 0.152.1" }
  );
});

test("Codex resolution skips an incomplete npm platform package and uses the next healthy install", {
  skip: process.platform !== "linux" || !linuxPlatform
}, async t => {
  const root = await createTestTempDir("privacyai-codex-resolution-");
  const broken = await createCodexInstall(root, "broken", { complete: false });
  const healthy = await createCodexInstall(root, "healthy");

  assert.equal(
    await resolveExecutable("codex", {
      path: `${broken.binDir}${delimiter}${healthy.binDir}`
    }),
    healthy.native
  );
  assert.equal(
    await resolveExecutable("codex", { path: broken.binDir }),
    null
  );
});

test("Codex resolution preserves non-npm custom executables", async t => {
  const root = await createTestTempDir("privacyai-custom-codex-");
  const binary = join(root, "codex");
  await writeFile(binary, "#!/bin/sh\nprintf 'custom codex\\n'\n", { mode: 0o755 });
  await chmod(binary, 0o755);

  assert.equal(await resolveExecutable("codex", { path: root }), binary);
});

test("native executable verification accepts a healthy binary", async t => {
  const root = await createTestTempDir("privacyai-executable-healthy-");
  const binary = join(root, "codex");
  await writeFile(binary, "#!/bin/sh\nprintf 'codex-cli 0.144.5\\n'\n", { mode: 0o755 });
  await chmod(binary, 0o755);

  assert.deepEqual(
    await verifyNativeExecutable("codex", binary, { timeoutMs: 1000 }),
    { version: "codex-cli 0.144.5" }
  );
});

test("native executable verification removes signal-resistant descendants", {
  skip: process.platform === "win32"
}, async () => {
  const root = await createTestTempDir("privacyai-executable-tree-");
  const binary = join(root, "codex");
  const pidPath = join(root, "descendant.pid");
  await writeFile(binary, [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`], { stdio: 'ignore' });",
    "child.unref();",
    "writeFileSync(process.env.PRIVACYAI_TEST_PID_PATH, String(child.pid));",
    "process.stdout.write('codex-cli test\\n');"
  ].join("\n"), { mode: 0o755 });
  await chmod(binary, 0o755);

  assert.deepEqual(
    await verifyNativeExecutable("codex", binary, {
      timeoutMs: 5000,
      env: { ...process.env, PRIVACYAI_TEST_PID_PATH: pidPath }
    }),
    { version: "codex-cli test" }
  );
  const descendantPid = Number(await import("node:fs/promises").then(fs => fs.readFile(pidPath, "utf8")));
  assert.equal(processExists(descendantPid), false);
});

test("native executable verification reports an incomplete Codex platform package", async t => {
  const root = await createTestTempDir("privacyai-executable-broken-");
  const binary = join(root, "codex");
  await writeFile(
    binary,
    [
      "#!/bin/sh",
      "printf '%s\\n' 'Error: Missing optional dependency @openai/codex-linux-x64.' >&2",
      "exit 1"
    ].join("\n"),
    { mode: 0o755 }
  );
  await chmod(binary, 0o755);

  await assert.rejects(
    verifyNativeExecutable("codex", binary, { timeoutMs: 1000 }),
    error =>
      error?.code === "PRIVACYAI_CODEX_EXECUTABLE_BROKEN" &&
      error.message.includes("npm install -g @openai/codex@latest") &&
      !error.message.includes(root)
  );
});
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
