import { listRuns } from "@orc/sdk";

import { runsDirOf, type Args, type Io } from "../cli.js";
import { duration, elapsed, table } from "../format.js";

/**
 * `orc runs` — every run under the runs directory, newest first.
 *
 * @param args the parsed command line; `--json` prints the records instead of a table
 * @param io where to write
 * @returns the process exit code
 */
export function runs(args: Args, io: Io): number {
  const dir = runsDirOf(args, io);
  const summaries = listRuns(dir);
  if (args.flags.get("json") === true) {
    io.out(
      `${JSON.stringify(
        summaries.map((s) => ({ dir: s.dir, ...s.run })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (summaries.length === 0) {
    io.out(`no runs in ${dir}\n`);
    return 0;
  }
  const rows = summaries.map((s) => [
    s.id,
    s.run.status,
    String(s.run.turns),
    duration(elapsed(s.run.startedAt, s.run.endedAt)),
    s.run.workflow.name,
  ]);
  io.out(`${table(["RUN", "STATUS", "TURNS", "ELAPSED", "WORKFLOW"], rows).join("\n")}\n`);
  return 0;
}
