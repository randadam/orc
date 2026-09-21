import { defaultRunsDir } from "@orc/sdk";

/** Where a command writes, and what it reads its defaults from. Injected so tests need no pipes. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A parsed command line: the command, its positional arguments, and its flags. */
export interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Thrown for anything the user can fix by retyping the command. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Flags that take a value; everything else is a boolean. */
const VALUE_FLAGS = new Set(["runs-dir"]);

/**
 * Split an argv tail into a command, positionals and flags.
 *
 * @param argv everything after the binary name
 * @returns the parsed form
 * @throws UsageError on an unknown flag shape or a value flag with no value
 */
export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    if (body === "") throw new UsageError("`--` is not an option");
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (eq !== -1) {
      flags.set(name, body.slice(eq + 1));
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      flags.set(name, true);
    }
  }
  return { command: positionals.shift() ?? "", positionals, flags };
}

/**
 * The runs directory a command should read: `--runs-dir`, else `ORC_RUNS_DIR`, else `.orc/runs`.
 *
 * @param args the parsed command line
 * @param io the invocation's cwd and environment
 * @returns an absolute path
 */
export function runsDirOf(args: Args, io: Io): string {
  const flag = args.flags.get("runs-dir");
  if (flag === true) throw new UsageError("--runs-dir needs a value");
  return defaultRunsDir(flag, io.cwd, io.env);
}
