import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { createPrivacyError } from "@privacy-ai/sdk";

import { isSameLiveProcess, readProcessStartIdentity } from "./process-identity.js";

const DEFAULT_LOCK_DIR = join(homedir(), ".local", "state", "privacyai", "launches");

/**
 * Prevent two PrivacyAI wrappers from launching the same native agent in the
 * same working directory. A duplicate wrapper would create another gateway,
 * another Codex process tree, and another stream of local-model classification
 * work before either session becomes usable.
 */
export async function acquireNativeLaunchLock(flavor, cwd, options = {}) {
  if (typeof flavor !== "string" || flavor.length === 0) {
    throw new TypeError("PrivacyAI launch lock requires an agent flavor.");
  }
  const resolvedCwd = resolve(cwd || process.cwd());

  // Older PrivacyAI versions did not create launch locks. On Linux, detect
  // those still-running wrappers before relying on the new lock file so an
  // upgrade cannot accidentally create a second reconnecting Codex tree.
  const active = await (options.findActiveNativeLaunch || findActiveNativeLaunch)(
    flavor,
    resolvedCwd
  );
  if (active) throw duplicateLaunchError(flavor, active.pid);

  const lockDir = resolve(options.launchLockDir || DEFAULT_LOCK_DIR);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });

  const key = createHash("sha256")
    .update(flavor)
    .update("\0")
    .update(resolvedCwd)
    .digest("hex")
    .slice(0, 32);
  const path = join(lockDir, `${flavor}-${key}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = `${JSON.stringify({
      pid: process.pid,
      flavor,
      cwd: resolvedCwd,
      createdAt: Date.now(),
      token: randomUUID(),
      processStart: await readProcessStartIdentity(process.pid)
    })}\n`;
    try {
      await writeFile(path, owner, { flag: "wx", mode: 0o600 });
      let released = false;
      return {
        path,
        async release() {
          if (released) return;
          released = true;
          await removeLockIfUnchanged(path, owner);
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readLock(path);
      if (existing?.serialized && await isSameLiveProcess(existing.record)) {
        throw duplicateLaunchError(flavor, Number(existing.record.pid));
      }
      if (existing?.serialized) {
        await removeLockIfUnchanged(path, existing.serialized);
        continue;
      }
    }
  }

  const error = new Error("PrivacyAI could not acquire its native-agent launch lock.");
  error.code = "PRIVACYAI_LAUNCH_LOCK_UNAVAILABLE";
  throw error;
}

export async function findActiveNativeLaunch(flavor, cwd) {
  if (process.platform !== "linux") return null;
  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return null;
  }

  const resolvedCwd = resolve(cwd);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid) continue;

    try {
      if (resolve(await readlink(`/proc/${pid}/cwd`)) !== resolvedCwd) continue;
      const commandLine = await readFile(`/proc/${pid}/cmdline`);
      const args = commandLine
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
      if (!isPrivacyAiWrapperProcess(args, flavor)) continue;
      return { pid };
    } catch (error) {
      if (new Set(["EACCES", "ENOENT", "EPERM"]).has(error?.code)) continue;
      throw error;
    }
  }
  return null;
}

function isPrivacyAiWrapperProcess(args, flavor) {
  if (!Array.isArray(args) || args.length < 2) return false;
  const executable = basename(String(args[0]));
  const nodeLaunch = /^(?:node|nodejs)(?:\.exe)?$/i.test(executable)
    && basename(String(args[1])) === "privacyai.js"
    && args[2] === flavor;
  const directLaunch = executable === "privacyai" && args[1] === flavor;
  return nodeLaunch || directLaunch;
}

function duplicateLaunchError(flavor, ownerPid) {
  const publicMessage =
    `PrivacyAI already has an active ${flavor} session for this working directory. ` +
    "Close that session before starting another one.";
  const duplicate = createPrivacyError({
    code: "PRIVACYAI_AGENT_ALREADY_RUNNING",
    category: "internal",
    phase: "startup",
    status: 409,
    retryable: false,
    message: publicMessage,
    publicMessage
  });
  duplicate.ownerPid = Number(ownerPid);
  return duplicate;
}

async function readLock(path) {
  try {
    const serialized = await readFile(path, "utf8");
    const record = JSON.parse(serialized);
    return { serialized, record };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // A malformed lock is not trusted as a live owner. Return its exact bytes
    // so the caller can remove it only if it remains unchanged.
    try {
      return { serialized: await readFile(path, "utf8"), record: {} };
    } catch (readError) {
      if (readError?.code === "ENOENT") return null;
      throw readError;
    }
  }
}

async function removeLockIfUnchanged(path, expected) {
  try {
    if (await readFile(path, "utf8") !== expected) return false;
    await rm(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}
