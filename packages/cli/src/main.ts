import { RunDirError } from "@orc/sdk";

import { parseArgs, UsageError, type Io } from "./cli.js";
import { runs } from "./commands/runs.js";
import { show } from "./commands/show.js";

const USAGE = `orc — agent orchestration

usage:
  orc runs [--runs-dir <dir>] [--json]
  orc show [<run-id>|<run-dir>] [--runs-dir <dir>] [--json]

options:
  --runs-dir <dir>  where run directories live; defaults to $ORC_RUNS_DIR, else .orc/runs
  --json            print the records rather than a summary
  --help            this text
`;

/**
 * Run one `orc` invocation.
 *
 * @param argv everything after the binary name
 * @param io where to write, and the cwd and environment to resolve defaults against
 * @returns the process exit code: 0 on success, 1 on a usage error or an unreadable run
 */
export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.flags.get("help") === true || args.command === "help" || args.command === "") {
      io.out(USAGE);
      return args.command === "" && args.flags.get("help") !== true ? 1 : 0;
    }
    switch (args.command) {
      case "runs":
        return runs(args, io);
      case "show":
        return show(args, io);
      default:
        throw new UsageError(`unknown command ${JSON.stringify(args.command)}`);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof RunDirError) {
      io.err(`orc: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
