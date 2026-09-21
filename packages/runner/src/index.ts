/** This package's name, as it appears in orc's log and trace records. */
export const PACKAGE = "@orc/runner";

export { JsonlDecoder } from "./framing.js";
export {
  piBin,
  PiExitError,
  PiProcess,
  PiTimeoutError,
  type PiCommand,
  type PiProcessOptions,
  type PiRecord,
} from "./pi-process.js";
