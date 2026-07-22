#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { one, parseRepeatedArgs } from "./common.mjs";

export function renderSummary(scope, result) {
  const pullNumbers = (scope?.selectedPullRequests || []).map(item => `#${item.number}`).join(", ") || "unavailable";
  const lines = [
    "# PrivacyAI live release review",
    "",
    `- Release SHA: \`${scope?.releaseSha || "unavailable"}\``,
    `- PRs reviewed: ${pullNumbers}`,
    `- Release checkout clean: **${passFail(result?.trackedCheckoutClean)}**`,
    `- Process/runtime cleanup: **${passFail(result?.cleanup?.ok)}**`,
    "",
    "| Provider | Execution | Model result | Completion marker |",
    "| --- | --- | --- | --- |"
  ];
  for (const name of ["codex", "agy"]) {
    const provider = result?.providers?.[name];
    lines.push(
      `| ${name} | ${provider ? passFail(provider.ok) : "not selected"} | ${provider?.result || "—"} | ${provider ? passFail(provider.completionMarker) : "—"} |`
    );
  }
  lines.push(
    "",
    `## Release gate: ${result?.eligible ? "ELIGIBLE FOR HUMAN APPROVAL" : "NOT ELIGIBLE"}`,
    "",
    "Provider responses and credentials are not included in this summary. Download the sanitized evidence artifact for bounded diagnostics.",
    ""
  );
  return lines.join("\n");
}

function passFail(value) {
  return value ? "PASS" : "FAIL";
}

async function main() {
  const values = parseRepeatedArgs(process.argv.slice(2));
  const scopePath = one(values, "--scope", { required: true });
  const resultPath = one(values, "--result", { required: true });
  const outputPath = one(values, "--output", { required: true });
  let scope = null;
  let result = null;
  try { scope = JSON.parse(await readFile(scopePath, "utf8")); } catch {}
  try { result = JSON.parse(await readFile(resultPath, "utf8")); } catch {}
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderSummary(scope, result));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
