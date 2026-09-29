import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { BoundedTextBuffer, detachedProcessOptions, terminateProcessTree } from "./process-supervisor.js";

const DEFAULT_EXECUTABLE_PROBE_TIMEOUT_MS = 10000;
const DEFAULT_EXECUTABLE_PROBE_MAX_BYTES = 64 * 1024;

export async function resolveExecutable(name, options = {}) {
  if (name.includes("/")) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }

  const pathValue = options.path || process.env.PATH || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];

  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        if (name === "codex") {
          const resolution = await resolveCodexNpmCandidate(candidate);
          if (resolution.native) return resolution.native;
          if (resolution.recognizedPackage) continue;
        }
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

export function verifyNativeExecutable(flavor, binary, options = {}) {
  if (!binary || typeof binary !== "string") {
    throw new TypeError("Native executable verification requires a binary path.");
  }
  const timeoutMs = positiveInteger(
    options.timeoutMs,
    DEFAULT_EXECUTABLE_PROBE_TIMEOUT_MS,
    "executable probe timeout"
  );
  const maxBytes = positiveInteger(
    options.maxBytes,
    DEFAULT_EXECUTABLE_PROBE_MAX_BYTES,
    "executable probe output limit"
  );

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(binary, ["--version"], detachedProcessOptions({
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    }));
    const stdout = new BoundedTextBuffer(maxBytes, "executable probe stdout");
    const stderr = new BoundedTextBuffer(maxBytes, "executable probe stderr");
    let outputBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateProcessTree(child, { graceMs: 250, killWaitMs: 750 }).then(
        () => error ? rejectPromise(error) : resolvePromise(value),
        cleanupError => rejectPromise(error || cleanupError)
      );
    };
    const append = (buffer, chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxBytes || !buffer.append(chunk)) {
        finish(brokenExecutableError(
          flavor,
          "produced excessive diagnostic output during its startup check"
        ));
      }
    };
    const timer = setTimeout(() => {
      finish(brokenExecutableError(
        flavor,
        `did not complete its startup check within ${Math.ceil(timeoutMs / 1000)} seconds`
      ));
    }, timeoutMs);

    child.on("error", () => {
      finish(brokenExecutableError(flavor, "could not be started"));
    });
    child.stdout.on("data", chunk => append(stdout, chunk));
    child.stderr.on("data", chunk => append(stderr, chunk));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(null, { version: stdout.text().trim() || stderr.text().trim() || null });
        return;
      }
      finish(codexExecutableFailure(flavor, stderr.text(), code, signal));
    });
  });
}

async function resolveCodexNpmCandidate(entrypoint) {
  if (process.platform !== "linux") return { native: null, recognizedPackage: false };
  const platform = process.arch === "x64"
    ? {
        packageName: "codex-linux-x64",
        packageVersionSuffix: "linux-x64",
        target: "x86_64-unknown-linux-musl"
      }
    : process.arch === "arm64"
      ? {
          packageName: "codex-linux-arm64",
          packageVersionSuffix: "linux-arm64",
          target: "aarch64-unknown-linux-musl"
        }
      : null;
  if (!platform) return { native: null, recognizedPackage: false };

  let resolved;
  try {
    resolved = await realpath(entrypoint);
  } catch {
    return { native: null, recognizedPackage: false };
  }
  const packageRoot = dirname(dirname(resolved));
  let launcherPackage;
  try {
    launcherPackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch {
    return { native: null, recognizedPackage: false };
  }
  if (launcherPackage?.name !== "@openai/codex") {
    return { native: null, recognizedPackage: false };
  }

  const platformRoot = join(packageRoot, "node_modules", "@openai", platform.packageName);
  const vendorRoot = join(platformRoot, "vendor", platform.target);
  const native = join(vendorRoot, "bin", "codex");
  try {
    const platformPackage = JSON.parse(await readFile(join(platformRoot, "package.json"), "utf8"));
    const packageMarker = JSON.parse(await readFile(join(vendorRoot, "codex-package.json"), "utf8"));
    if (
      typeof launcherPackage.version !== "string" ||
      platformPackage?.name !== "@openai/codex" ||
      platformPackage?.version !== `${launcherPackage.version}-${platform.packageVersionSuffix}` ||
      packageMarker?.layoutVersion !== 1 ||
      packageMarker?.version !== launcherPackage.version ||
      packageMarker?.target !== platform.target ||
      packageMarker?.entrypoint !== "bin/codex"
    ) {
      return { native: null, recognizedPackage: true };
    }
    await access(native, constants.X_OK);
    return { native, recognizedPackage: true };
  } catch {
    return { native: null, recognizedPackage: true };
  }
}

function codexExecutableFailure(flavor, stderr, code, signal) {
  if (
    flavor === "codex" &&
    /Missing optional dependency @openai\/codex-[A-Za-z0-9_-]+/i.test(stderr)
  ) {
    return brokenExecutableError(
      flavor,
      "has an incomplete platform package. Reinstall it with: npm install -g @openai/codex@latest"
    );
  }
  const termination = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
  return brokenExecutableError(
    flavor,
    `crashed or exited during its startup check (${termination}). Reinstall it before launching PrivacyAI`
  );
}

function brokenExecutableError(flavor, reason) {
  const displayName = flavor === "codex" ? "Codex" : flavor === "claude" ? "Claude Code" : flavor;
  const error = new Error(`${displayName} ${reason}.`);
  error.code = flavor === "codex"
    ? "PRIVACYAI_CODEX_EXECUTABLE_BROKEN"
    : "PRIVACYAI_NATIVE_EXECUTABLE_BROKEN";
  return error;
}

function positiveInteger(value, fallback, label) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return normalized;
}
