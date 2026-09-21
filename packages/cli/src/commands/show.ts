import { latestRun, openRun, type RunDir } from "@orc/sdk";
import { existsSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import { runsDirOf, UsageError, type Args, type Io } from "../cli.js";
import { duration, elapsed, fields } from "../format.js";

/**
 * Resolve a run reference: a run id under the runs directory, a path to a run directory, or
 * nothing at all, which means the most recent run.
 *
 * @param ref the positional argument, if any
 * @param args the parsed command line
 * @param io the invocation's cwd and environment
 * @returns the run directory
 * @throws UsageError when the reference names no run
 */
export function resolveRun(ref: string | undefined, args: Args, io: Io): RunDir {
  const runsDir = runsDirOf(args, io);
  if (ref === undefined) {
    const latest = latestRun(runsDir);
    if (latest === null) throw new UsageError(`no runs in ${runsDir}`);
    return openRun(latest.dir);
  }
  const candidates = [join(runsDir, ref)];
  if (ref.includes(sep) || ref.includes("/") || isAbsolute(ref)) {
    candidates.unshift(isAbsolute(ref) ? ref : join(io.cwd, ref));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "run.json"))) return openRun(candidate);
  }
  throw new UsageError(`no run ${ref} in ${runsDir}`);
}

/**
 * `orc show [<run>]` — the run's outcome and every record under it.
 *
 * @param args the parsed command line; `--json` prints the records instead of a summary
 * @param io where to write
 * @returns the process exit code
 */
export function show(args: Args, io: Io): number {
  const dir = resolveRun(args.positionals[0], args, io);
  const report = dir.report();
  if (args.flags.get("json") === true) {
    io.out(`${JSON.stringify({ dir: dir.dir, ...report }, null, 2)}\n`);
    return 0;
  }

  const { run } = report;
  const lines = fields([
    ["run", run.id],
    ["workflow", `${run.workflow.name}  (${run.workflow.file})`],
    ["status", run.status],
    ["started", run.startedAt],
    ["elapsed", duration(elapsed(run.startedAt, run.endedAt))],
    ["turns", String(run.turns)],
    ["config", run.configHash],
    ["workspace", `${run.workspace.source} @ ${run.workspace.ref}`],
    ["dir", dir.dir],
  ]);

  if (run.error !== null) lines.push("", `error  ${run.error.name}: ${run.error.message}`);

  lines.push("", `steps (${report.steps.length})`);
  for (const step of report.steps) {
    const agents = step.observed.agents.join(", ") || "-";
    lines.push(
      `  ${step.id}  ${duration(step.durationMs)}  agents: ${agents}` +
        `  prompts: ${step.observed.prompts.length}${step.amended ? "  amended" : ""}`,
    );
  }

  lines.push("", `escalations (${report.escalations.length})`);
  for (const e of report.escalations) {
    const answer =
      e.answer === null
        ? "unanswered"
        : `${e.answer.action}${e.answer.step === undefined ? "" : ` ${e.answer.step}`}` +
          `${e.consumed ? " (consumed)" : ""}`;
    lines.push(`  ${e.id}  ${answer}`);
    lines.push(`    ${e.reason}`);
  }

  lines.push("", `verify (${report.verifies.length})`);
  for (const v of report.verifies) {
    lines.push(
      `  ${v.id}  exit ${v.exitCode ?? v.signal ?? "?"}  ${duration(v.durationMs)}  ` +
        `${v.cmd}  @ ${v.sha}${v.dirty ? " (dirty)" : ""}`,
    );
  }

  lines.push("", `agents (${report.agents.length})`);
  for (const a of report.agents) {
    lines.push(
      `  ${a.id}  ${a.role}  ${a.status}  ${a.turns} turns  ${a.model.id}  ` +
        `$${a.usage.cost.toFixed(4)}${a.usage.provisional ? " (provisional)" : ""}`,
    );
  }

  io.out(`${lines.join("\n")}\n`);
  return 0;
}
