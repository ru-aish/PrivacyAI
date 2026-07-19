import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const DEFAULT_TERMINATION_GRACE_MS = 750;
const DEFAULT_KILL_WAIT_MS = 750;
const PROCESS_POLL_MS = 20;

export function detachedProcessOptions(options = {}) {
  return {
    ...options,
    detached: options.detached ?? process.platform !== "win32"
  };
}

export function signalExitCode(signal) {
  const number = osConstants.signals?.[signal];
  return Number.isInteger(number) && number > 0 ? 128 + number : 1;
}

export function runInheritedProcess(command, args = [], options = {}) {
  const {
    terminationGraceMs = 2000,
    killWaitMs = 1000,
    orphanGraceMs = 250,
    ...spawnOptions
  } = options;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, detachedProcessOptions({ ...spawnOptions, stdio: "inherit" }));
    let settled = false;
    let forwardedSignal = null;
    let terminationPromise = null;
    const signalHandlers = new Map();

    const cleanup = () => {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    };
    const settle = (error, code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(code);
    };
    const forward = signal => {
      if (forwardedSignal == null) forwardedSignal = signal;
      terminationPromise ||= terminateProcessTree(child, {
        signal,
        graceMs: terminationGraceMs,
        killWaitMs
      }).catch(error => settle(error));
    };

    for (const signal of ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]) {
      const handler = () => forward(signal);
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    child.once("error", error => settle(error));
    child.once("exit", (code, signal) => {
      const result = forwardedSignal
        ? signalExitCode(forwardedSignal)
        : signal
          ? signalExitCode(signal)
          : code ?? 1;
      const cleanupPromise = terminationPromise || terminateProcessTree(child, {
        signal: "SIGTERM",
        graceMs: orphanGraceMs,
        killWaitMs
      });
      cleanupPromise.then(() => settle(null, result), error => settle(error));
    });
  });
}

export function signalProcessTree(child, signal = "SIGTERM") {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function terminateProcessTree(child, options = {}) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;

  const graceMs = boundedNonNegativeInteger(
    options.graceMs,
    DEFAULT_TERMINATION_GRACE_MS,
    "process termination grace period"
  );
  const killWaitMs = boundedNonNegativeInteger(
    options.killWaitMs,
    DEFAULT_KILL_WAIT_MS,
    "process kill wait period"
  );
  const initialSignal = options.signal || "SIGTERM";

  signalProcessTree(child, initialSignal);
  if (await waitForProcessTreeExit(child, graceMs)) return;

  signalProcessTree(child, "SIGKILL");
  await waitForProcessTreeExit(child, killWaitMs);
}

export async function waitForProcessTreeExit(child, timeoutMs = DEFAULT_TERMINATION_GRACE_MS) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;

  const deadline = Date.now() + boundedNonNegativeInteger(
    timeoutMs,
    DEFAULT_TERMINATION_GRACE_MS,
    "process-tree wait timeout"
  );
  while (true) {
    if (!processTreeExists(child)) return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(PROCESS_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

export class BoundedTextBuffer {
  constructor(maxBytes, label = "process output") {
    this.maxBytes = positiveSafeInteger(maxBytes, label);
    this.label = label;
    this.bytes = 0;
    this.chunks = [];
  }

  append(chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (this.bytes + value.length > this.maxBytes) return false;
    this.bytes += value.length;
    this.chunks.push(value);
    return true;
  }

  text() {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

function processTreeExists(child) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  if (process.platform === "win32") {
    return child.exitCode == null && child.signalCode == null;
  }

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function boundedNonNegativeInteger(value, fallback, label) {
  const normalized = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > 60_000) {
    throw new TypeError(`${label} must be an integer between 0 and 60000.`);
  }
  return normalized;
}

function positiveSafeInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(`${label} limit must be a positive safe integer.`);
  }
  return normalized;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
