/** This package's name, as it appears in orc's log and trace records. */
export const PACKAGE = "@orc/sdk";

export {
  canonical,
  ConfigError,
  defineConfig,
  hash,
  role,
  type ConfigInput,
  type FrozenConfig,
  type ResolvedConfig,
  type ResolvedRole,
  type RoleInput,
} from "./config.js";
