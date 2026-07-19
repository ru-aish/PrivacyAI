import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { normalizeSessionMap } from "@privacy-ai/sdk";

import {
  commitProvenancedMutation,
  derivePrivacyPlanFromCommittedMutation,
  rollbackProvenancedMutation,
  stageProvenancedMutation
} from "./mutation-provenance.js";
import {
  identifyGitWorktree,
  startupCacheHash,
  startupFileVerificationKey
} from "./startup-cache.js";

const ABSENT_CONTENT_HASH = opaqueHash("privacyai-file-absent-v1");
const WRITE_TOOLS = new Set(["write", "write_file"]);
const EDIT_TOOLS = new Set(["edit", "replace_in_file"]);
const MULTI_EDIT_TOOLS = new Set(["multiedit", "multi_edit"]);
const PATCH_TOOLS = new Set(["apply_patch"]);

/**
 * Stage a structured file mutation before tool execution. Only operations whose
 * exact result can be derived locally are recorded; opaque shell commands and
 * ambiguous replacements are intentionally ignored.
 */
export async function stageHookFileMutation(event, options = {}) {
  const store = requireStore(options.store);
  const predictions = await predictHookFileMutations(event, options);
  if (predictions.length === 0) {
    return { status: "unsupported", stagedCount: 0 };
  }

  const ownership = await registerOwnership(store, event, options);
  const results = [];
  for (const prediction of predictions) {
    registerContentIdentity(store, prediction.source);
    registerContentIdentity(store, prediction.next);
    results.push(stageProvenancedMutation(store, {
      mutationId: prediction.mutationId,
      worktreeId: ownership.worktreeId,
      pathHash: prediction.pathHash,
      expectedContentHash: prediction.source.contentHash,
      nextContentHash: prediction.next.contentHash,
      operation: prediction.operation
    }));
  }

  return {
    status: results.every(result => result.status === "pending")
      ? "pending"
      : "partial",
    stagedCount: results.filter(result => result.status === "pending").length,
    results
  };
}

/**
 * Commit a previously staged mutation after successful tool execution, verify
 * the resulting file hash, and seed future startup verification only when the
 * complete resulting content is proven safe by construction.
 */
export async function commitHookFileMutation(event, options = {}) {
  const store = requireStore(options.store);
  const targets = mutationTargets(event, options);
  if (targets.length === 0) {
    return { status: "unsupported", committedCount: 0 };
  }

  const results = [];
  for (const target of targets) {
    const mutationId = hookFileMutationId(event, target.path);
    const staged = store.getFileMutation(mutationId);
    if (!staged) {
      results.push({ status: "missing", mutationId });
      continue;
    }

    const actual = await readTextSnapshot(target.path);
    registerContentIdentity(store, actual);
    const result = commitProvenancedMutation(
      store,
      mutationId,
      actual.contentHash,
      {
        success: true,
        committedReference: opaqueHash(
          "hook-commit-v1\0" + eventIdentity(event) + "\0" + actual.contentHash
        )
      }
    );
    results.push(result);

    if (result.status === "committed" && actual.exists) {
      seedCommittedFileCaches(store, staged, actual, options);
    }
  }

  return {
    status: results.every(result => result.status === "committed")
      ? "committed"
      : "partial",
    committedCount: results.filter(result => result.status === "committed").length,
    results
  };
}

/** Roll back pending mutations for a failed or cancelled tool call. */
export function rollbackHookFileMutation(event, options = {}) {
  const store = requireStore(options.store);
  const results = mutationTargets(event, options).map(target =>
    rollbackProvenancedMutation(store, hookFileMutationId(event, target.path))
  );
  return {
    status: results.length === 0
      ? "unsupported"
      : results.every(result => result.status === "rolled_back")
        ? "rolled_back"
        : "partial",
    rolledBackCount: results.filter(result => result.status === "rolled_back").length,
    results
  };
}

/** Determine whether opening the durable ledger could be useful for this event. */
export function isHookFileMutationEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (!new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "ToolError", "ToolFailure"]).has(event.hook_event_name)) {
    return false;
  }
  return supportedToolKind(event.tool_name) !== null;
}

/** Stable opaque mutation identity shared by separate pre/post hook processes. */
export function hookFileMutationId(event, path) {
  return opaqueHash(
    "hook-file-mutation-v1\0" + eventIdentity(event) + "\0" + resolve(path)
  );
}

async function predictHookFileMutations(event, options) {
  const input = options.toolInput || event?.tool_input;
  const kind = supportedToolKind(event?.tool_name);
  if (!kind || !input || typeof input !== "object" || Array.isArray(input)) return [];
  const cwd = resolve(event.cwd || options.cwd || process.cwd());
  const sessionMap = normalizeSessionMap(options.sessionMap);
  if (kind === "apply_patch") {
    return predictApplyPatch(event, input, cwd, sessionMap);
  }

  const path = filePathFromInput(input, cwd);
  if (!path) return [];
  const source = await readTextSnapshot(path);
  let prediction;
  if (kind === "write") {
    prediction = predictWrite(source, input, sessionMap);
  } else if (kind === "edit") {
    prediction = predictEdit(source, input, sessionMap);
  } else {
    prediction = predictMultiEdit(source, input, sessionMap);
  }
  if (!prediction || prediction.next.contentHash === source.contentHash) return [];

  return [{
    ...prediction,
    source,
    path,
    pathHash: filePathHash(path),
    mutationId: hookFileMutationId(event, path)
  }];
}

function mutationTargets(event, options) {
  const input = options.toolInput || event?.tool_input;
  if (!supportedToolKind(event?.tool_name) || !input || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }
  const cwd = resolve(event.cwd || options.cwd || process.cwd());
  if (supportedToolKind(event?.tool_name) === "apply_patch") {
    const parsed = parseApplyPatch(patchTextFromInput(input));
    return parsed ? parsed.map(section => ({ path: resolve(cwd, section.path) })) : [];
  }
  const path = filePathFromInput(input, cwd);
  return path ? [{ path }] : [];
}

function predictWrite(source, input, sessionMap) {
  if (typeof input.content !== "string") return null;
  const next = textSnapshot(input.content);
  return {
    next,
    operation: {
      type: "write_file",
      sourceLength: source.text?.length || 0,
      nextLength: input.content.length,
      knownInsertions: privateSpansInText(input.content, sessionMap).map(span => ({
        offset: span.start,
        length: span.end - span.start,
        classification: span.classification,
        reference: span.reference
      }))
    }
  };
}

function predictEdit(source, input, sessionMap) {
  if (!source.exists || source.text == null) return null;
  const oldString = stringField(input, ["old_string", "oldString", "old_text", "oldText"]);
  const newString = stringField(input, ["new_string", "newString", "new_text", "newText"]);
  if (oldString == null || newString == null || oldString.length === 0) return null;

  const occurrences = occurrenceOffsets(source.text, oldString);
  const replaceAll = input.replace_all === true || input.replaceAll === true;
  if (occurrences.length === 0 || (!replaceAll && occurrences.length !== 1)) return null;
  const selected = replaceAll ? occurrences : occurrences.slice(0, 1);
  const edits = selected.map(start => ({
    start,
    end: start + oldString.length,
    insertedLength: newString.length,
    knownInsertions: privateSpansInText(newString, sessionMap).map(span => ({
      offset: span.start,
      length: span.end - span.start,
      classification: span.classification,
      reference: span.reference
    }))
  }));
  const nextText = applyOrderedEdits(source.text, edits, newString);
  return {
    next: textSnapshot(nextText),
    operation: {
      type: "replace_in_file",
      sourceLength: source.text.length,
      nextLength: nextText.length,
      edits
    }
  };
}

function predictMultiEdit(source, input, sessionMap) {
  if (!source.exists || source.text == null || !Array.isArray(input.edits)) return null;
  let current = source.text;
  for (const edit of input.edits) {
    if (!edit || typeof edit !== "object") return null;
    const oldString = stringField(edit, ["old_string", "oldString", "old_text", "oldText"]);
    const newString = stringField(edit, ["new_string", "newString", "new_text", "newText"]);
    if (oldString == null || newString == null || oldString.length === 0) return null;
    const occurrences = occurrenceOffsets(current, oldString);
    const replaceAll = edit.replace_all === true || edit.replaceAll === true;
    if (occurrences.length === 0 || (!replaceAll && occurrences.length !== 1)) return null;
    current = replaceAll
      ? current.split(oldString).join(newString)
      : current.slice(0, occurrences[0]) + newString + current.slice(occurrences[0] + oldString.length);
  }

  const compact = minimalReplacement(source.text, current);
  if (!compact) return null;
  return {
    next: textSnapshot(current),
    operation: {
      type: "replace_in_file",
      sourceLength: source.text.length,
      nextLength: current.length,
      edits: [{
        start: compact.start,
        end: compact.end,
        insertedLength: compact.inserted.length,
        knownInsertions: privateSpansInText(compact.inserted, sessionMap).map(span => ({
          offset: span.start,
          length: span.end - span.start,
          classification: span.classification,
          reference: span.reference
        }))
      }]
    }
  };
}

async function predictApplyPatch(event, input, cwd, sessionMap) {
  const sections = parseApplyPatch(patchTextFromInput(input));
  if (!sections) return [];
  const predictions = [];

  for (const section of sections) {
    const path = resolve(cwd, section.path);
    const source = await readTextSnapshot(path);
    const nextText = applyPatchSection(source, section);
    if (nextText === undefined) return [];
    const next = nextText === null
      ? { exists: false, text: null, byteLength: 0, contentHash: ABSENT_CONTENT_HASH }
      : textSnapshot(nextText);
    if (next.contentHash === source.contentHash) continue;

    const operation = patchOperation(source, next, sessionMap);
    predictions.push({
      source,
      next,
      operation,
      path,
      pathHash: filePathHash(path),
      mutationId: hookFileMutationId(event, path)
    });
  }
  return predictions;
}

function parseApplyPatch(text) {
  if (typeof text !== "string") return null;
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") return null;
  const sections = [];
  const seenPaths = new Set();
  let index = 1;

  while (index < lines.length) {
    if (lines[index] === "*** End Patch") {
      const trailing = lines.slice(index + 1);
      return sections.length > 0 && trailing.every(line => line === "")
        ? sections
        : null;
    }
    const header = lines[index].match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (!header) return null;
    const type = header[1].toLocaleLowerCase("en-US");
    const path = header[2];
    if (!safePatchPath(path) || seenPaths.has(path)) return null;
    seenPaths.add(path);
    index += 1;
    const body = [];
    while (index < lines.length && !lines[index].startsWith("*** ")) {
      body.push(lines[index]);
      index += 1;
    }
    sections.push({ type, path, body });
  }
  return null;
}

function applyPatchSection(source, section) {
  if (section.type === "add") {
    if (source.exists || section.body.some(line => !line.startsWith("+"))) return undefined;
    return patchBodyText(section.body.map(line => line.slice(1)));
  }
  if (section.type === "delete") {
    return source.exists ? null : undefined;
  }
  if (!source.exists || source.text == null) return undefined;

  let current = source.text;
  const hunks = splitPatchHunks(section.body);
  if (!hunks || hunks.length === 0) return undefined;
  for (const hunk of hunks) {
    const oldLines = [];
    const newLines = [];
    for (const line of hunk) {
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      } else if (line.startsWith("-")) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else if (line === "\\ No newline at end of file") {
        continue;
      } else {
        return undefined;
      }
    }
    const oldChunk = patchBodyText(oldLines);
    const newChunk = patchBodyText(newLines);
    const offsets = occurrenceOffsets(current, oldChunk);
    if (offsets.length !== 1) return undefined;
    current = current.slice(0, offsets[0]) + newChunk + current.slice(offsets[0] + oldChunk.length);
  }
  return current;
}

function splitPatchHunks(lines) {
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) hunks.push(current);
      current = [];
      continue;
    }
    if (!current) return null;
    current.push(line);
  }
  if (current) hunks.push(current);
  return hunks;
}

function patchOperation(source, next, sessionMap) {
  if (!source.exists || !next.exists) {
    const inserted = next.text || "";
    return {
      type: "write_file",
      sourceLength: source.text?.length || 0,
      nextLength: inserted.length,
      knownInsertions: privateSpansInText(inserted, sessionMap).map(span => ({
        offset: span.start,
        length: span.end - span.start,
        classification: span.classification,
        reference: span.reference
      }))
    };
  }
  const compact = minimalReplacement(source.text, next.text);
  return {
    type: "apply_patch",
    sourceLength: source.text.length,
    nextLength: next.text.length,
    edits: [{
      start: compact.start,
      end: compact.end,
      insertedLength: compact.inserted.length,
      knownInsertions: privateSpansInText(compact.inserted, sessionMap).map(span => ({
        offset: span.start,
        length: span.end - span.start,
        classification: span.classification,
        reference: span.reference
      }))
    }]
  };
}

function patchTextFromInput(input) {
  for (const name of ["patch", "input", "patch_text", "patchText"]) {
    if (typeof input?.[name] === "string") return input[name];
  }
  return null;
}

function patchBodyText(lines) {
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

function safePatchPath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(path)
  ) {
    return false;
  }
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function seedCommittedFileCaches(store, mutation, actual, options) {
  const policyFingerprint = String(options.policyFingerprint || "");
  if (!policyFingerprint || actual.text == null) return;

  const previousVerification = store.getVerification(
    startupFileVerificationKey(mutation.expectedContentHash, policyFingerprint),
    policyFingerprint
  );
  const completeByConstruction = mutation.operationType === "write_file" || Boolean(previousVerification);
  const knownMap = normalizeSessionMap({
    ...(previousVerification?.sessionMapAdditions || {}),
    ...(options.sessionMap || {})
  });
  const previousPlan = store.getPrivacyPlan(
    mutation.expectedContentHash,
    policyFingerprint
  );
  const derived = derivePrivacyPlanFromCommittedMutation(
    mutation,
    previousPlan,
    { sourceLength: mutation.sourceLength }
  );
  const spans = mergePrivacySpans(
    derived.status === "derived" ? derived.spans : [],
    privateSpansInText(actual.text, knownMap)
  );

  store.putPrivacyPlan({
    contentHash: actual.contentHash,
    policyFingerprint,
    spans,
    editPlan: spans.map(span => ({ ...span }))
  });

  if (!completeByConstruction) return;
  // The completion marker contains no originals. Future startup scans rebuild
  // fresh placeholder mappings from the verified file bytes and opaque spans.
  store.putVerification({
    cacheKey: startupFileVerificationKey(actual.contentHash, policyFingerprint),
    contentHash: actual.contentHash,
    artifactType: "startup_static_file_plan",
    policyFingerprint,
    sessionMapAdditions: {}
  });
}

async function registerOwnership(store, event, options) {
  const cwd = resolve(event.cwd || options.cwd || process.cwd());
  const repo = await identifyGitWorktree(cwd);
  const repositoryId = startupCacheHash(
    "repository\0" + (repo.commonDir || repo.root || cwd)
  );
  const worktreeId = startupCacheHash(
    "worktree\0" + (repo.worktree || cwd)
  );
  store.registerRepository({
    repositoryId,
    rootRef: startupCacheHash(repo.root || cwd)
  });
  store.registerWorktree({
    worktreeId,
    repositoryId,
    pathHash: filePathHash(repo.worktree || cwd),
    metadataRef: startupCacheHash(JSON.stringify(repo))
  });
  return { repositoryId, worktreeId };
}

async function readTextSnapshot(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return {
        exists: false,
        text: null,
        byteLength: 0,
        contentHash: ABSENT_CONTENT_HASH
      };
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    const error = new Error("PrivacyAI mutation provenance supports regular non-symlink files only.");
    error.code = "PRIVACYAI_MUTATION_UNSUPPORTED_FILE";
    throw error;
  }
  const bytes = await readFile(path);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const error = new Error("PrivacyAI mutation provenance supports valid UTF-8 text files only.");
    error.code = "PRIVACYAI_MUTATION_UNSUPPORTED_ENCODING";
    throw error;
  }
  return {
    exists: true,
    text,
    byteLength: bytes.length,
    contentHash: opaqueHash(bytes)
  };
}

function textSnapshot(text) {
  return {
    exists: true,
    text,
    byteLength: Buffer.byteLength(text),
    contentHash: opaqueHash(Buffer.from(text))
  };
}

function registerContentIdentity(store, snapshot) {
  if (!snapshot.exists) return;
  store.putContentIdentity({
    contentHash: snapshot.contentHash,
    byteLength: snapshot.byteLength,
    kind: "file-text"
  });
}

function supportedToolKind(toolName) {
  const normalized = String(toolName || "")
    .split(/[.:/]/)
    .at(-1)
    ?.toLocaleLowerCase("en-US");
  if (WRITE_TOOLS.has(normalized)) return "write";
  if (EDIT_TOOLS.has(normalized)) return "edit";
  if (MULTI_EDIT_TOOLS.has(normalized)) return "multi_edit";
  if (PATCH_TOOLS.has(normalized)) return "apply_patch";
  return null;
}

function filePathFromInput(input, cwd) {
  const value = input.file_path ?? input.filePath ?? input.path;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
  return resolve(cwd, value);
}

function stringField(value, names) {
  for (const name of names) {
    if (typeof value?.[name] === "string") return value[name];
  }
  return null;
}

function eventIdentity(event) {
  const sessionId = String(event?.session_id || "");
  const callId = String(
    event?.tool_use_id || event?.tool_call_id || event?.call_id || ""
  );
  if (!sessionId || !callId) {
    const error = new TypeError(
      "File mutation provenance requires session_id and tool_use_id/tool_call_id."
    );
    error.code = "PRIVACYAI_MUTATION_IDENTITY_MISSING";
    throw error;
  }
  return sessionId + "\0" + callId;
}

function occurrenceOffsets(text, search) {
  const offsets = [];
  let cursor = 0;
  while (cursor <= text.length - search.length) {
    const index = text.indexOf(search, cursor);
    if (index === -1) break;
    offsets.push(index);
    cursor = index + search.length;
  }
  return offsets;
}

function applyOrderedEdits(source, edits, insertedText) {
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    output += source.slice(cursor, edit.start);
    output += insertedText;
    cursor = edit.end;
  }
  return output + source.slice(cursor);
}

function minimalReplacement(source, next) {
  if (source === next) return null;
  let start = 0;
  while (start < source.length && start < next.length && source[start] === next[start]) {
    start += 1;
  }
  let sourceEnd = source.length;
  let nextEnd = next.length;
  while (
    sourceEnd > start &&
    nextEnd > start &&
    source[sourceEnd - 1] === next[nextEnd - 1]
  ) {
    sourceEnd -= 1;
    nextEnd -= 1;
  }
  return { start, end: sourceEnd, inserted: next.slice(start, nextEnd) };
}

function privateSpansInText(text, sessionMap) {
  const normalized = normalizeSessionMap(sessionMap);
  const candidates = Object.entries(normalized)
    .map(([placeholder, original]) => ({
      placeholder,
      original,
      folded: original.toLocaleLowerCase("en-US")
    }))
    .sort((left, right) => right.original.length - left.original.length);
  if (candidates.length === 0 || text.length === 0) return [];

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
      classification: classificationForPlaceholder(candidate.placeholder),
      reference: opaqueHash(candidate.original)
    });
  }
  return spans;
}

function mergePrivacySpans(...collections) {
  const unique = new Map();
  for (const spans of collections) {
    for (const span of spans || []) {
      const key = [span.start, span.end, span.classification, span.reference].join("\0");
      unique.set(key, span);
    }
  }
  return [...unique.values()].sort((left, right) =>
    left.start - right.start ||
    left.end - right.end ||
    left.classification.localeCompare(right.classification) ||
    left.reference.localeCompare(right.reference)
  );
}

function classificationForPlaceholder(placeholder) {
  const match = String(placeholder).match(/^\[([A-Z][A-Z0-9_]*?)(?:_\d+)?\]$/i);
  return match ? match[1].toLocaleLowerCase("en-US") : "private_value";
}

function filePathHash(path) {
  return startupCacheHash("path\0" + resolve(path));
}

function opaqueHash(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function requireStore(store) {
  if (!store || typeof store.stageFileMutation !== "function") {
    throw new TypeError("Hook file mutation tracking requires a cache ledger store.");
  }
  return store;
}
