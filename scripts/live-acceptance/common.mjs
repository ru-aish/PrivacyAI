import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const COMPLETION_MARKER = "PRIVACYAI_LIVE_REVIEW_COMPLETE";
export const SYNTHETIC_PRIVATE_VALUE = "qa-review-7f8a@example.test";

export function assertExactSha(value, name = "SHA") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new TypeError(`${name} must be an exact 40-character hexadecimal commit SHA.`);
  }
  return normalized;
}

export function assertPrNumbers(values) {
  if (!Array.isArray(values) || values.length !== 1) {
    throw new TypeError("Exactly one pull request number is required.");
  }
  const normalized = values.map(value => Number(value));
  if (normalized.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError("Pull request numbers must be positive integers.");
  }
  return normalized;
}

export function assertRepository(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new TypeError("Repository must use owner/name format.");
  }
  return normalized;
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writePrivateFile(path, value) {
  await ensurePrivateDirectory(dirname(path));
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value, options = {}) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (options.private) await writePrivateFile(path, text);
  else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

export async function prepareIgnoredReviewScope(workspace, home) {
  const gitPath = (await runChecked("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: workspace,
    timeoutMs: 30_000
  })).stdout.trim();
  const excludePath = resolve(workspace, gitPath);
  let existed = true;
  let original;
  try {
    original = await readFile(excludePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    existed = false;
    original = Buffer.alloc(0);
  }
  const backupPath = reviewScopeBackupPath(home);
  await writeJson(backupPath, {
    version: 1,
    excludePath,
    existed,
    contentBase64: original.toString("base64")
  }, { private: true });

  const marker = "/LIVE_REVIEW_SCOPE.md";
  const lines = original.toString("utf8").split(/\r?\n/);
  if (!lines.includes(marker)) {
    const source = original.toString("utf8");
    const prefix = original.length > 0 && !source.endsWith("\n") ? "\n" : "";
    await mkdir(dirname(excludePath), { recursive: true });
    await writeFile(excludePath, Buffer.concat([
      original,
      Buffer.from(prefix + marker + "\n")
    ]));
  }
  return backupPath;
}

export async function restoreIgnoredReviewScope(home) {
  const backupPath = reviewScopeBackupPath(home);
  let backup;
  try {
    backup = await readJson(backupPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const bytes = Buffer.from(String(backup.contentBase64 || ""), "base64");
  if (backup.existed) {
    await mkdir(dirname(backup.excludePath), { recursive: true });
    await writeFile(backup.excludePath, bytes);
  } else {
    await rm(backup.excludePath, { force: true });
  }
  await rm(backupPath, { force: true });
  return true;
}

function reviewScopeBackupPath(home) {
  return join(home, ".privacyai-live-private", "git-info-exclude-backup.json");
}

export function safeMetadataText(value, maximum = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

export function redactText(value, secrets = []) {
  let text = String(value || "");
  const candidates = [SYNTHETIC_PRIVATE_VALUE, ...secrets]
    .filter(item => typeof item === "string" && item.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of candidates) text = text.split(secret).join("[REDACTED]");
  return text;
}

export function run(command, args = [], options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ownsProcessGroup = options.processGroup === true && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      detached: ownsProcessGroup,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const maximumBytes = options.maximumBytes ?? 16 * 1024 * 1024;
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      terminateProcessGroup(child, ownsProcessGroup, "SIGKILL");
      rejectPromise(error);
    };
    const append = (current, chunk) => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > maximumBytes) {
        throw new Error(`Command output exceeded ${maximumBytes} bytes.`);
      }
      return next;
    };
    child.stdout.on("data", chunk => {
      try { stdout = append(stdout, chunk); } catch (error) { rejectOnce(error); }
    });
    child.stderr.on("data", chunk => {
      try { stderr = append(stderr, chunk); } catch (error) { rejectOnce(error); }
    });
    child.on("error", rejectOnce);
    if (options.stdin !== undefined) child.stdin.end(String(options.stdin));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminateProcessGroup(child, ownsProcessGroup, "SIGTERM");
          setTimeout(() => terminateProcessGroup(child, ownsProcessGroup, "SIGKILL"), 5000).unref();
        }, options.timeoutMs)
      : null;
    child.on("close", async (code, signal) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      const survivingProcessGroup = ownsProcessGroup
        ? processGroupMembers(child.pid)
        : [];
      if (survivingProcessGroup.length) {
        terminateProcessGroup(child, true, "SIGTERM");
        await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
        terminateProcessGroup(child, true, "SIGKILL");
      }
      settled = true;
      resolvePromise({
        code: Number.isInteger(code) ? code : 1,
        signal,
        stdout,
        stderr,
        timedOut,
        processGroupId: ownsProcessGroup ? child.pid : null,
        survivingProcessGroup
      });
    });
  });
}

function terminateProcessGroup(child, ownsProcessGroup, signal) {
  try {
    if (ownsProcessGroup && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processGroupMembers(processGroupId) {
  if (!processGroupId) return [];
  const result = spawnSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8" });
  if (result.status !== 0) return [{ pid: null, command: "Unable to inspect provider process group." }];
  const members = [];
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match || Number(match[2]) !== processGroupId) continue;
    members.push({ pid: Number(match[1]), command: match[3] });
  }
  return members;
}

export async function runChecked(command, args = [], options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0 || result.timedOut) {
    const rendered = [command, ...args].join(" ");
    const error = new Error(
      `${rendered} ${result.timedOut ? "timed out" : `exited ${result.code}`}.\n` +
      `${redactText(result.stderr || result.stdout, options.secrets).slice(-4000)}`
    );
    error.result = result;
    throw error;
  }
  return result;
}

export function parseRepeatedArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = args[++index];
    if (value == null || value.startsWith("--")) throw new Error(`${key} requires a value.`);
    const list = values.get(key) || [];
    list.push(value);
    values.set(key, list);
  }
  return values;
}

export function one(values, key, options = {}) {
  const found = values.get(key) || [];
  if (found.length > 1) throw new Error(`${key} may be supplied only once.`);
  if (found.length === 0) {
    if (options.required) throw new Error(`${key} is required.`);
    return options.defaultValue;
  }
  return found[0];
}

export function absolute(path) {
  return resolve(String(path));
}
