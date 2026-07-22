#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { one, parseRepeatedArgs } from "./common.mjs";

export function renderSummary(scope, result) {
  const pullNumbers = (scope?.selectedPullRequests || []).map(item => "#" + item.number).join(", ") || "unavailable";
  const failure = result?.failure;
  const lines = [
    "# PrivacyAI live release review",
    "",
    "- Release SHA: `" + (scope?.releaseSha || result?.releaseSha || "unavailable") + "`",
    "- PR reviewed: " + pullNumbers,
    "- Release checkout clean: **" + passFail(result?.trackedCheckoutClean) + "**",
    "- Process/runtime cleanup: **" + passFail(result?.cleanup?.ok) + "**",
    "- Failure phase: `" + inline(failure?.phase || "none") + "`",
    "- Failure code: `" + inline(failure?.code || "none") + "`",
    "- Failure message: " + inline(failure?.message || "none"),
    "",
    "| Provider | Execution | Failure code | Exit | Timeout avoided | Diagnostic codes | Completion marker |",
    "| --- | --- | --- | ---: | --- | --- | --- |"
  ];
  for (const name of ["codex", "agy"]) {
    const provider = result?.providers?.[name];
    lines.push(
      "| " + name +
      " | " + (provider ? passFail(provider.ok) : "not selected") +
      " | " + inline(provider?.failureCode || "—") +
      " | " + (provider?.exitCode ?? "—") +
      " | " + (provider ? passFail(!provider.timedOut) : "—") +
      " | " + inline((provider?.diagnosticCodes || []).join(", ") || "—") +
      " | " + (provider ? passFail(provider.completionMarker) : "—") + " |"
    );
  }

  for (const name of ["codex", "agy"]) {
    const provider = result?.providers?.[name];
    if (!provider || provider.ok || !provider.logTail) continue;
    lines.push(
      "",
      "### " + name + " bounded sanitized log tail",
      "",
      ...renderLogTail(provider.logTail)
    );
  }

  const database = result?.databaseDiagnostics;
  lines.push(
    "",
    "## Local database diagnostics",
    "",
    "- Context database: **" + inline(database?.context?.status || "unavailable") + "**, schema `" + inline(database?.context?.schemaVersion ?? "unknown") + "`",
    "- Lineage database: **" + inline(database?.lineage?.status || "unavailable") + "**, events `" + (database?.lineage?.eventCount ?? 0) + "`",
    "- Recorded diagnostic codes: " + inline(renderDiagnosticCounts(database?.lineage?.diagnosticCounts))
  );

  const recentEvents = (database?.lineage?.recentEvents || []).slice(0, 10);
  if (recentEvents.length > 0) {
    lines.push(
      "",
      "| Recent lineage event | Provider | Phase | Reason | Diagnostic |",
      "| --- | --- | --- | --- | --- |"
    );
    for (const event of recentEvents) {
      lines.push(
        "| " + inline(event.eventType) +
        " | " + inline(event.provider || "—") +
        " | " + inline(event.phase || "—") +
        " | " + inline(event.reasonCode || "—") +
        " | " + inline(event.diagnosticCode || "—") + " |"
      );
    }
  }

  lines.push(
    "",
    "## Release gate: " + (result?.eligible ? "ELIGIBLE FOR HUMAN APPROVAL" : "NOT ELIGIBLE"),
    "",
    "Download the sanitized evidence artifact for provider-output tails, complete bounded transcripts, and database-diagnostics.json. Credentials, request payloads, session maps, vault values, and raw database metadata are excluded.",
    ""
  );
  return lines.join("\n");
}

function renderLogTail(value) {
  const text = String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(-2000);
  return text.split(/\r?\n/).map(line => "    " + line);
}

function renderDiagnosticCounts(items) {
  const values = (items || []).filter(item => item?.diagnosticCode && item.diagnosticCode !== "none");
  return values.length
    ? values.map(item => item.diagnosticCode + " (" + item.count + ")").join(", ")
    : "none";
}

function inline(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
    .slice(0, 500);
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
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
