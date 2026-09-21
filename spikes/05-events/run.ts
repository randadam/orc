import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Checks } from "../lib/check.ts";
import { requireKey } from "../lib/env.ts";
import { modelFailureLine, report } from "../lib/finding.ts";
import { Pi, type PiRecord } from "../lib/rpc.ts";
import { cleanupTmp, tmp } from "../lib/tmp.ts";

requireKey("05-events");

const here = dirname(fileURLToPath(import.meta.url));
const LOG = join(here, "events.jsonl");
const FIELDS = ["usage", "model", "provider", "toolName", "toolCallId", "args"] as const;

const pi = new Pi({
  home: tmp("home"),
  cwd: tmp("work"),
  args: ["--no-session", "--provider", "anthropic", "--model", "claude-haiku-4-5"],
  timeoutMs: 120_000,
});

function has(record: PiRecord, field: string): boolean {
  if (record[field] !== undefined) return true;
  const message = record.message as Record<string, unknown> | undefined;
  return message?.[field] !== undefined;
}

const checks = new Checks();
let usageIn = "none";
let usageFields = "";
let identityIn = "none";
let timing = "field";
let modelError: string | undefined;

try {
  await pi.call(
    { type: "prompt", message: "Use bash to print the date, then use bash to print the hostname." },
    30_000,
  );
  await pi.await((r) => r.type === "agent_settled", 120_000);

  modelError = pi.modelErrors()[0];
  checks.ok(`every model call succeeded${modelError ? ` — ${modelError}` : ""}`, modelError === undefined);

  writeFileSync(
    LOG,
    pi.records
      .map((r, i) => `${JSON.stringify({ receivedAt: pi.receivedAt[i], record: r })}\n`)
      .join(""),
  );
  console.log(`  wrote ${pi.records.length} records to ${LOG}`);

  console.log("  event                      " + FIELDS.map((f) => f.padEnd(11)).join(""));
  const types = [...new Set(pi.records.map((r) => r.type))];
  for (const type of types) {
    const of = pi.ofType(type);
    const row = FIELDS.map((f) =>
      (of.some((r) => has(r, f)) ? "yes" : "-").padEnd(11),
    ).join("");
    console.log(`  ${`${type} (${of.length})`.padEnd(27)}${row}`);
  }

  const withUsage = pi.records.find((r) => {
    const usage = r.usage as Record<string, unknown> | undefined;
    return usage?.input !== undefined && usage.output !== undefined && usage.cost !== undefined;
  });
  if (withUsage) {
    usageIn = withUsage.type;
    usageFields = Object.keys(withUsage.usage as object).join(",");
  }
  checks.ok(`usage carries input, output and cost (on ${usageIn})`, usageIn !== "none");

  const identity = pi.records.find((r) => has(r, "model") && has(r, "provider"));
  if (identity) identityIn = identity.type;
  checks.ok(`the assistant message carries model and provider (on ${identityIn})`, identity !== undefined);

  const starts = pi.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.type === "tool_execution_start");
  const durations: string[] = [];
  for (const { r, i } of starts) {
    const endIdx = pi.records.findIndex(
      (e, j) => j > i && e.type === "tool_execution_end" && e.toolCallId === r.toolCallId,
    );
    if (endIdx === -1) continue;
    durations.push(
      `${r.toolName}=${((pi.receivedAt[endIdx]! - pi.receivedAt[i]!) / 1000).toFixed(2)}s`,
    );
  }
  checks.ok(
    `start/end pair by toolCallId, so a duration is computable (${durations.join(" ")})`,
    durations.length >= 2,
  );

  // The finding phase 1 needs: whether the stream carries timing or the runner must clock it.
  const timed = [...starts.map((s) => s.r), ...pi.ofType("tool_execution_end")];
  timing = timed.some((r) => has(r, "durationMs") || has(r, "duration")) ? "field" : "derived";
} catch (err) {
  checks.ok(`the spike ran to completion — ${(err as Error).message.split("\n")[0]}`, false);
} finally {
  await pi.close();
  cleanupTmp();
}

report({
  spike: "05-events",
  pass: checks.passed,
  line: modelError
    ? modelFailureLine("EVENTS", modelError)
    : `EVENTS: usage in ${usageIn}; fields {${usageFields}}; ` +
      `model+provider in ${identityIn}; tool timing: ${timing}`,
  script: "spikes/05-events/run.ts",
});
