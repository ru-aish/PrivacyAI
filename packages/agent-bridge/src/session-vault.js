import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const VAULT_VERSION = 1;

export class SessionVault {
  constructor(options = {}) {
    this.baseDir = resolve(
      options.baseDir ||
      process.env.PRIVACYAI_AGENT_VAULT_DIR ||
      join(homedir(), ".local", "share", "privacyai", "agent-sessions")
    );
  }

  pathForSession(sessionId) {
    if (!sessionId || typeof sessionId !== "string") {
      throw new TypeError("SessionVault requires a non-empty session id.");
    }
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.baseDir, `${digest}.json`);
  }

  async load(sessionId) {
    const path = this.pathForSession(sessionId);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      return {
        version: parsed.version || VAULT_VERSION,
        sessionId,
        sessionMap: normalizeSessionMap(parsed.sessionMap),
        updatedAt: parsed.updatedAt || null,
        path
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return {
        version: VAULT_VERSION,
        sessionId,
        sessionMap: {},
        updatedAt: null,
        path
      };
    }
  }

  async save(sessionId, sessionMap) {
    const path = this.pathForSession(sessionId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    const record = {
      version: VAULT_VERSION,
      sessionId,
      sessionMap: normalizeSessionMap(sessionMap),
      updatedAt: new Date().toISOString()
    };
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
    return { ...record, path };
  }

  async merge(sessionId, additions) {
    const current = await this.load(sessionId);
    return this.save(sessionId, {
      ...current.sessionMap,
      ...normalizeSessionMap(additions)
    });
  }
}

export async function loadSessionMap(options = {}) {
  if (options.mapFile || process.env.PRIVACYAI_SESSION_MAP_FILE) {
    const path = resolve(options.mapFile || process.env.PRIVACYAI_SESSION_MAP_FILE);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return normalizeSessionMap(parsed.sessionMap || parsed);
  }

  const sessionId = options.sessionId;
  if (!sessionId) return {};
  const vault = options.vault || new SessionVault(options);
  return (await vault.load(sessionId)).sessionMap;
}

function normalizeSessionMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([dummy, original]) =>
        typeof dummy === "string" &&
        typeof original === "string" &&
        dummy.length > 0 &&
        original.length > 0 &&
        dummy !== original
    )
  );
}
