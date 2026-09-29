import { readFile } from "node:fs/promises";

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export async function readProcessStartIdentity(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd === -1) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    // /proc/<pid>/stat field 22 is process start time. After removing fields
    // 1 (pid) and 2 (comm), it is index 19 in the remaining sequence.
    return fieldsAfterCommand[19] || null;
  } catch (error) {
    if (
      error?.code === "ENOENT" ||
      error?.code === "EACCES" ||
      error?.code === "ESRCH"
    ) {
      return null;
    }
    throw error;
  }
}

export async function isSameLiveProcess(record) {
  const pid = Number(record?.pid);
  if (!isProcessAlive(pid)) return false;
  if (!record?.processStart) return true;
  const currentStart = await readProcessStartIdentity(pid);
  if (currentStart !== null) return currentStart === record.processStart;
  return isProcessAlive(pid);
}
