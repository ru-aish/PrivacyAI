import { estimatePrivacyTokens, normalizeTokenBudget } from "@privacy-ai/sdk";

export function packUncachedArtifactEntries(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError("Artifact entries must be an array.");
  const maxChars = normalizePositiveInteger(options.maxContextChars, 200000, "maxContextChars");
  const maxTokens = normalizeTokenBudget(options.maxContextTokens, Math.max(2048, Math.floor(maxChars / 2)));
  const tokenCounter = options.tokenCounter;
  const artifacts = groupOriginalArtifacts(entries, tokenCounter);
  const packs = [];

  for (const artifact of artifacts) {
    let pack = packs[packs.length - 1];
    if (
      !pack ||
      (pack.entries.length > 0 && (
        pack.estimatedChars + artifact.estimatedChars > maxChars ||
        pack.estimatedTokens + artifact.estimatedTokens > maxTokens
      ))
    ) {
      pack = {
        packIndex: packs.length,
        artifactKey: `packed/${packs.length}`,
        artifactType: "packed_uncached",
        artifacts: [],
        entries: [],
        estimatedChars: 0,
        estimatedTokens: 0
      };
      packs.push(pack);
    }
    pack.artifacts.push(artifact);
    pack.entries.push(...artifact.entries);
    pack.estimatedChars += artifact.estimatedChars;
    pack.estimatedTokens += artifact.estimatedTokens;
  }

  return packs;
}

function groupOriginalArtifacts(entries, tokenCounter) {
  const groups = [];
  const byIdentity = new Map();
  for (const entry of entries) {
    const identity = `${entry.artifactType}\0${entry.artifactKey}`;
    let artifact = byIdentity.get(identity);
    if (!artifact) {
      artifact = {
        artifactIndex: groups.length,
        artifactKey: entry.artifactKey,
        artifactType: entry.artifactType,
        entries: [],
        estimatedChars: 0,
        estimatedTokens: 0
      };
      byIdentity.set(identity, artifact);
      groups.push(artifact);
    }
    artifact.entries.push(entry);
  }

  for (const artifact of groups) {
    const encoded = JSON.stringify(artifact.entries.map(entry => entry.value));
    artifact.estimatedChars = encoded.length + 64;
    artifact.estimatedTokens = estimatePrivacyTokens(encoded, tokenCounter) + 24;
  }
  return groups;
}

function normalizePositiveInteger(value, fallback, name) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return number;
}
