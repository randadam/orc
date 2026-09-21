/** This package's name, as it appears in orc's log and trace records. */
export const PACKAGE = "@orc/cli";

export { parseArgs, runsDirOf, UsageError, type Args, type Io } from "./cli.js";
export { main } from "./main.js";
export { runs } from "./commands/runs.js";
export { resolveRun, show } from "./commands/show.js";
