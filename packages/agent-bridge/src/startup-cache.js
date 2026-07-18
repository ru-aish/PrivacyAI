import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import { rebaseSessionAdditions } from "@privacy-ai/sdk";

const execFileAsync = promisify(execFile);
const CACHE_VERSION = 1;
const PLAN_VERIFICATION_TYPE = "startup_static_file_plan";

const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const pathHash = value => digest(`path\0${resolve(value)}`);

/**
 * Resolve startup files through the cache ledger. Metadata hits never read a
 * file: the content identity and per-file sanitizer result are reused.
 */
export async function resolveStartupFileManifest(paths, options = {}) {
  const store = options.verificationStore;
  const cwd = resolve(options.cwd || process.cwd());
  const maxFiles = startupLimit(options.maxFiles, Number.POSITIVE_INFINITY, "maxFiles");
  const maxBytes = startupLimit(options.maxBytes, Number.POSITIVE_INFINITY, "maxBytes");
  const readStableFile = options.readStableFile || readStableStartupText;
  const repo = await identifyGitWorktree(cwd);
  const worktreeId = digest(`worktree\0${repo.worktree || cwd}`);
  // Linked worktrees share one common Git directory and repository identity.
  const repositoryId = digest(`repository\0${repo.commonDir || repo.root || cwd}`);
  const counters = {
    lstat: 0,
    reads: 0,
    gitChecks: 0,
    metadataHits: 0,
    contentReuses: 0,
    gitBlobReuses: 0,
    misses: 0
  };

  if (store) {
    store.registerRepository({ repositoryId, rootRef: digest(repo.root || cwd) });
    store.registerWorktree({
      worktreeId,
      repositoryId,
      pathHash: pathHash(repo.worktree || cwd),
      metadataRef: digest(JSON.stringify(repo))
    });
  }

  const records = [];
  let totalBytes = 0;
  for (const candidate of [...new Set(paths.map(path => resolve(path)))].sort()) {
    let stat;
    try {
      stat = await lstat(candidate, { bigint: true });
      counters.lstat += 1;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;

    if (
      stat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      records.length >= maxFiles ||
      totalBytes + Number(stat.size) > maxBytes
    ) {
      throw startupManifestLimitError();
    }
    totalBytes += Number(stat.size);

    const metadata = {
      size: Number(stat.size),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      mode: Number(stat.mode)
    };
    const filePathHash = pathHash(candidate);
    const versionHash = digest(JSON.stringify(metadata));
    const version = store?.getFileVersion(worktreeId, filePathHash, versionHash);
    let contentHash = version?.contentHash;
    let gitBlobHash = version?.gitBlobHash || null;

    if (contentHash) counters.metadataHits += 1;
    if (!contentHash) {
      gitBlobHash = await gitBlobForCleanPath(repo, candidate, counters);
      if (gitBlobHash) {
        const prior = store?.findContentByGitBlob(gitBlobHash);
        if (prior) {
          contentHash = prior.contentHash;
          counters.gitBlobReuses += 1;
        }
      }
    }

    let content;
    if (!contentHash) {
      content = await readStableFile({ path: candidate, metadata }, {
        maxBytes: metadata.size
      });
      counters.reads += 1;
      counters.misses += 1;
      contentHash = digest(content);
      store?.putContentIdentity({
        contentHash,
        byteLength: Buffer.byteLength(content),
        kind: "startup-text",
        gitBlobHash,
        repositoryId
      });
    } else {
      counters.contentReuses += 1;
    }

    store?.putFileMetadata({
      worktreeId,
      pathHash: filePathHash,
      contentHash,
      byteLength: metadata.size,
      mode: metadata.mode,
      metadataRef: digest(JSON.stringify(metadata)),
      versionHash,
      gitBlobHash,
      versionRef: versionHash
    });
    records.push({
      path: candidate,
      pathHash: filePathHash,
      contentHash,
      gitBlobHash,
      mode: metadata.mode,
      content,
      metadata
    });
  }

  const entries = records
    .map(({ pathHash: entryPathHash, contentHash, gitBlobHash, mode }) => ({
      pathHash: entryPathHash,
      contentHash,
      gitBlobHash,
      mode
    }))
    .sort((left, right) => left.pathHash.localeCompare(right.pathHash));
  const manifestHash = digest(JSON.stringify(entries));
  store?.putManifest({
    manifestHash,
    worktreeId,
    metadataRef: digest(JSON.stringify({
      version: CACHE_VERSION,
      repo,
      paths: records.map(record => record.pathHash)
    })),
    entries
  });
  return { records, manifestHash, repositoryId, worktreeId, repo, counters };
}

export async function sanitizeStartupFiles(manifest, options = {}) {
  const { verificationStore: store, policyFingerprint, sanitizer } = options;
  const readStableFile = options.readStableFile || readStableStartupText;
  const completeMap = {};
  const additions = {};
  let sanitizerCalls = 0;

  for (const record of manifest.records) {
    const cacheKey = startupFileVerificationKey(
      record.contentHash,
      policyFingerprint
    );
    const cached = store?.getVerification(cacheKey, policyFingerprint);
    let sessionMapAdditions;
    if (cached?.artifactType === PLAN_VERIFICATION_TYPE) {
      const plan = store?.getPrivacyPlan(record.contentHash, policyFingerprint);
      const text = plan
        ? record.content ?? await readStableFile(record, {
            maxBytes: record.metadata.size,
            contentHash: record.contentHash
          })
        : null;
      sessionMapAdditions = text == null ? null : sessionMapFromPrivacyPlan(text, plan);
    } else if (cached) {
      sessionMapAdditions = cached.sessionMapAdditions || {};
    }

    if (sessionMapAdditions == null) {
      // A content identity recovered through Git can still need first-time
      // sanitization; read it only in that exceptional path.
      const text = record.content ?? await readStableFile(record, {
        maxBytes: record.metadata.size,
        contentHash: record.contentHash
      });
      sanitizerCalls += 1;
      const result = await sanitizer(JSON.stringify({ path: record.pathHash, content: text }));
      sessionMapAdditions = result?.sessionMap || {};
      const spans = privacySpansForMappings(text, sessionMapAdditions);
      store?.putPrivacyPlan({
        contentHash: record.contentHash,
        policyFingerprint,
        spans,
        editPlan: spans.map(span => ({ ...span }))
      });
      store?.putVerification({
        cacheKey,
        contentHash: record.contentHash,
        artifactType: "startup_static_file",
        policyFingerprint,
        sessionMapAdditions
      });
    }
    mergeSessionMappings(completeMap, additions, sessionMapAdditions);
  }
  return { sessionMapAdditions: additions, sanitizerCalls };
}

export function startupFileVerificationKey(contentHash, policyFingerprint) {
  return digest(
    "startup-static-file-v" + CACHE_VERSION + "\0" +
    String(policyFingerprint) + "\0" +
    String(contentHash)
  );
}

export function renderedStartupFingerprint(input) {
  return digest(JSON.stringify({
    version: CACHE_VERSION,
    manifestHash: input.manifestHash,
    policyFingerprint: input.policyFingerprint,
    protectedArgs: input.protectedArgs || [],
    config: input.config || {},
    cwd: resolve(input.cwd),
    repositoryId: input.repositoryId,
    worktreeId: input.worktreeId,
    executable: input.executable || {},
    renderContractVersion: input.renderContractVersion || 1
  }));
}

export async function identifyGitWorktree(cwd) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir"],
      { encoding: "utf8", maxBuffer: 64 * 1024 }
    );
    const [root, common, gitDir] = stdout.trim().split(/\r?\n/);
    return {
      root: resolve(root),
      worktree: resolve(root),
      commonDir: resolve(root, common),
      gitDir: resolve(root, gitDir),
      isGit: true
    };
  } catch {
    const root = resolve(cwd);
    return { root, worktree: root, commonDir: null, gitDir: null, isGit: false };
  }
}

export async function readStableStartupText(record, options = {}) {
  const expected = record?.metadata;
  if (
    typeof record?.path !== "string" ||
    !expected ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0
  ) {
    throw new TypeError("stable startup reads require a path and validated metadata.");
  }
  const maxBytes = nonNegativeStartupLimit(options.maxBytes, expected.size, "maxBytes");
  if (expected.size > maxBytes) throw startupManifestLimitError();

  const noFollow = Number(constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await open(record.path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ELOOP") throw startupFileChangedError();
    throw error;
  }

  try {
    const before = await handle.stat({ bigint: true });
    assertStableStartupStat(before, expected, maxBytes);

    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }

    const extra = Buffer.allocUnsafe(1);
    const extraRead = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat({ bigint: true });
    if (
      offset !== size ||
      extraRead.bytesRead !== 0 ||
      !sameStartupStat(before, after) ||
      !matchesStartupMetadata(after, expected)
    ) {
      throw startupFileChangedError();
    }

    const text = bytes.toString("utf8", 0, offset);
    if (options.contentHash && digest(text) !== options.contentHash) {
      throw startupFileChangedError();
    }
    return text;
  } finally {
    await handle.close();
  }
}

function assertStableStartupStat(stat, expected, maxBytes) {
  if (
    !stat.isFile() ||
    stat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
    Number(stat.size) > maxBytes ||
    !matchesStartupMetadata(stat, expected)
  ) {
    throw startupFileChangedError();
  }
}

function matchesStartupMetadata(stat, expected) {
  return (
    Number(stat.size) === expected.size &&
    stat.mtimeNs.toString() === expected.mtimeNs &&
    stat.ctimeNs.toString() === expected.ctimeNs &&
    stat.dev.toString() === expected.dev &&
    stat.ino.toString() === expected.ino &&
    Number(stat.mode) === expected.mode
  );
}

function sameStartupStat(left, right) {
  return (
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

async function gitBlobForCleanPath(repo, file, counters) {
  if (!repo.isGit || !file.startsWith(`${repo.root}/`)) return null;
  const relativePath = relative(repo.root, file);
  try {
    counters.gitChecks += 1;
    // The index blob is reusable only when worktree bytes match the index.
    await execFileAsync(
      "git",
      ["-C", repo.root, "diff-files", "--quiet", "--", relativePath],
      { maxBuffer: 16 * 1024 }
    );
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo.root, "ls-files", "-s", "--", relativePath],
      { encoding: "utf8", maxBuffer: 16 * 1024 }
    );
    const match = stdout.match(/^\d+\s+([0-9a-f]{40,64})\s+\d+\t/m);
    return match ? `git:${match[1]}` : null;
  } catch {
    return null;
  }
}

function sessionMapFromPrivacyPlan(text, plan) {
  if (typeof text !== "string" || !Array.isArray(plan?.spans)) return null;
  const sessionMap = {};
  const placeholdersByReference = new Map();
  const counts = new Map();
  let previousEnd = 0;

  for (const span of plan.spans) {
    if (
      !Number.isSafeInteger(span?.start) ||
      !Number.isSafeInteger(span?.end) ||
      span.start < previousEnd ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > text.length ||
      typeof span.reference !== "string"
    ) {
      return null;
    }
    previousEnd = span.end;
    const original = text.slice(span.start, span.end);
    if (digest(original) !== span.reference) return null;

    let placeholder = placeholdersByReference.get(span.reference);
    if (!placeholder) {
      const classification = placeholderClassification(span.classification);
      const index = (counts.get(classification) || 0) + 1;
      counts.set(classification, index);
      placeholder = `[${classification}_${index}]`;
      placeholdersByReference.set(span.reference, placeholder);
      sessionMap[placeholder] = original;
    } else if (sessionMap[placeholder] !== original) {
      return null;
    }
  }
  return sessionMap;
}

function placeholderClassification(value) {
  const normalized = String(value || "private_value")
    .toLocaleUpperCase("en-US")
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[A-Z][A-Z0-9_]*$/.test(normalized) ? normalized : "PRIVATE_VALUE";
}

function privacySpansForMappings(text, sessionMap) {
  if (typeof text !== "string" || !sessionMap || typeof sessionMap !== "object") return [];
  const candidates = Object.entries(sessionMap)
    .filter(([placeholder, original]) =>
      typeof placeholder === "string" &&
      typeof original === "string" &&
      original.length > 0
    )
    .map(([placeholder, original]) => ({
      placeholder,
      original,
      folded: original.toLocaleLowerCase("en-US")
    }))
    .sort((left, right) => right.original.length - left.original.length);
  if (candidates.length === 0) return [];

  const byOriginal = new Map(candidates.map(candidate => [candidate.folded, candidate]));
  const pattern = new RegExp(
    candidates.map(candidate => escapeRegExp(candidate.original)).join("|"),
    "gi"
  );
  const spans = [];
  for (const match of text.matchAll(pattern)) {
    const candidate = byOriginal.get(match[0].toLocaleLowerCase("en-US"));
    if (!candidate || match.index == null) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      classification: startupClassification(candidate.placeholder),
      reference: digest(candidate.original)
    });
  }
  return spans;
}

function startupClassification(placeholder) {
  const match = String(placeholder).match(/^\[([A-Z][A-Z0-9_]*?)(?:_\d+)?\]$/i);
  return match ? match[1].toLocaleLowerCase("en-US") : "private_value";
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function mergeSessionMappings(completeMap, additions, candidate) {
  const entries = Object.fromEntries(Object.entries(candidate || {}).filter(
    ([placeholder, original]) =>
      typeof placeholder === "string" && placeholder.length > 0 &&
      typeof original === "string" && original.length > 0 &&
      placeholder !== original
  ));
  if (Object.keys(entries).length === 0) return;
  const rebased = rebaseSessionAdditions(
    JSON.stringify(Object.keys(entries)),
    entries,
    completeMap
  );
  Object.assign(completeMap, rebased.sessionMap);
  Object.assign(additions, rebased.sessionMap);
}

function startupLimit(value, fallback, label) {
  if (value == null) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new TypeError(label + " must be a positive safe integer.");
  }
  return normalized;
}

function nonNegativeStartupLimit(value, fallback, label) {
  if (value == null) return fallback;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new TypeError(label + " must be a non-negative safe integer.");
  }
  return normalized;
}

function startupFileChangedError() {
  const error = new Error(
    "PrivacyAI stopped startup because an implicit context file changed while it was being verified."
  );
  error.code = "PRIVACYAI_STARTUP_FILE_CHANGED";
  return error;
}

function startupManifestLimitError() {
  const error = new Error(
    "PrivacyAI blocked startup because implicit project context was too large to classify atomically."
  );
  error.code = "PRIVACYAI_STARTUP_CONTEXT_TOO_LARGE";
  return error;
}

export { digest as startupCacheHash };
