import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { verificationFingerprint } from "./context-verification-store.js";

const execFileAsync = promisify(execFile);
const CACHE_VERSION = 1;

const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const pathHash = value => digest(`path\0${resolve(value)}`);

/**
 * Resolve startup files through the cache ledger.  Metadata hits never read a
 * file: the content identity and its per-file static sanitizer result are
 * recovered from the ledger instead.
 */
export async function resolveStartupFileManifest(paths, options = {}) {
  const store = options.verificationStore;
  const cwd = resolve(options.cwd || process.cwd());
  const repo = await identifyGitWorktree(cwd);
  const worktreeId = digest(`worktree\0${repo.worktree || cwd}`);
  const repositoryId = digest(`repository\0${repo.commonDir || "non-git"}\0${repo.root || cwd}`);
  const counters = { lstat: 0, reads: 0, metadataHits: 0, contentReuses: 0, gitBlobReuses: 0, misses: 0 };
  if (store) {
    store.registerRepository({ repositoryId, rootRef: digest(repo.root || cwd) });
    store.registerWorktree({ worktreeId, repositoryId, pathHash: pathHash(repo.worktree || cwd), metadataRef: digest(JSON.stringify(repo)) });
  }
  const records = [];
  for (const candidate of [...new Set(paths.map(path => resolve(path)))].sort()) {
    let stat;
    try { stat = await lstat(candidate, { bigint: true }); counters.lstat += 1; } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const metadata = { size: Number(stat.size), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode) };
    const filePathHash = pathHash(candidate);
    const versionHash = digest(JSON.stringify(metadata));
    let version = store?.getFileVersion(worktreeId, filePathHash, versionHash);
    let contentHash = version?.contentHash;
    let gitBlobHash = version?.gitBlobHash || await gitBlobForPath(repo, candidate);
    if (contentHash) counters.metadataHits += 1;
    if (!contentHash && gitBlobHash) {
      const prior = store?.findContentByGitBlob(gitBlobHash);
      if (prior) { contentHash = prior.contentHash; counters.gitBlobReuses += 1; }
    }
    let content;
    if (!contentHash) {
      content = await readFile(candidate, "utf8"); counters.reads += 1; counters.misses += 1;
      contentHash = digest(content);
      store?.putContentIdentity({ contentHash, byteLength: Buffer.byteLength(content), kind: "startup-text", gitBlobHash, repositoryId });
    } else {
      counters.contentReuses += 1;
    }
    store?.putFileMetadata({ worktreeId, pathHash: filePathHash, contentHash, byteLength: metadata.size, mode: metadata.mode, metadataRef: digest(JSON.stringify(metadata)), versionHash, gitBlobHash, versionRef: versionHash });
    records.push({ path: candidate, pathHash: filePathHash, contentHash, gitBlobHash, mode: metadata.mode, content, metadata });
  }
  const entries = records.map(({ pathHash: entryPathHash, contentHash, gitBlobHash, mode }) => ({ pathHash: entryPathHash, contentHash, gitBlobHash, mode }));
  const manifestHash = digest(JSON.stringify(entries.sort((a, b) => a.pathHash.localeCompare(b.pathHash))));
  store?.putManifest({ manifestHash, worktreeId, metadataRef: digest(JSON.stringify({ version: CACHE_VERSION, repo, paths: records.map(record => record.pathHash) })), entries });
  return { records, manifestHash, repositoryId, worktreeId, repo, counters };
}

export async function sanitizeStartupFiles(manifest, options = {}) {
  const { verificationStore: store, policyFingerprint, sanitizer } = options;
  const additions = {};
  let sanitizerCalls = 0;
  for (const record of manifest.records) {
    const cacheKey = digest(`startup-static-file-v${CACHE_VERSION}\0${policyFingerprint}\0${record.contentHash}`);
    const cached = store?.getVerification(cacheKey, policyFingerprint);
    if (cached) { Object.assign(additions, cached.sessionMapAdditions); continue; }
    // A content identity recovered via a Git blob can still need first-time
    // sanitization; read it only in that exceptional path.
    const text = record.content ?? await readFile(record.path, "utf8");
    sanitizerCalls += 1;
    const result = await sanitizer(JSON.stringify({ path: record.pathHash, content: text }));
    const sessionMapAdditions = result?.sessionMap || {};
    store?.putVerification({ cacheKey, contentHash: record.contentHash, artifactType: "startup_static_file", policyFingerprint, sessionMapAdditions });
    Object.assign(additions, sessionMapAdditions);
  }
  return { sessionMapAdditions: additions, sanitizerCalls };
}

export function renderedStartupFingerprint(input) {
  return digest(JSON.stringify({
    version: CACHE_VERSION,
    manifestHash: input.manifestHash,
    policyFingerprint: input.policyFingerprint,
    protectedArgs: input.protectedArgs || [], config: input.config || {}, cwd: resolve(input.cwd),
    repositoryId: input.repositoryId, worktreeId: input.worktreeId,
    executable: input.executable || {}, renderContractVersion: input.renderContractVersion || 1
  }));
}

export async function identifyGitWorktree(cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"], { encoding: "utf8", maxBuffer: 64 * 1024 });
    const [root, common, gitDir] = stdout.trim().split(/\r?\n/);
    return { root: resolve(root), worktree: resolve(root), commonDir: resolve(root, common), gitDir: resolve(root, gitDir), isGit: true };
  } catch { return { root: cwd, worktree: cwd, commonDir: null, gitDir: null, isGit: false }; }
}

async function gitBlobForPath(repo, file) {
  if (!repo.isGit || !file.startsWith(`${repo.root}/`)) return null;
  try {
    const relativePath = relative(repo.root, file);
    const { stdout } = await execFileAsync("git", ["-C", repo.root, "ls-files", "-s", "--", relativePath], { encoding: "utf8", maxBuffer: 16 * 1024 });
    const match = stdout.match(/^\d+\s+([0-9a-f]{40,64})\s+\d+\t/m);
    return match ? `git:${match[1]}` : null;
  } catch { return null; }
}

export { digest as startupCacheHash };
