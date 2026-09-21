import { createHash } from "node:crypto";

/** Every role's model in phase 1; the Haiku split arrives in phase 6. */
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_ROLE_MAX_TURNS = 40;
const DEFAULT_RUN_MAX_TURNS = 200;
const DEFAULT_MAX_AGENTS = 4;

const ROOT_KEYS = ["defaults", "roles", "limits"] as const;
const DEFAULTS_KEYS = ["model", "maxTurns"] as const;
const ROLE_KEYS = ["model", "tools", "maxTurns"] as const;
const TOOLS_KEYS = ["allow", "deny"] as const;
const LIMITS_KEYS = ["maxAgents", "maxTurns"] as const;

/** Thrown when a config is malformed, or names a field orc does not enforce. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A role as an author writes it: everything but `tools` may be left to a default. */
export interface RoleInput {
  model?: string;
  /** Tool names, or a trailing-`*` glob. */
  tools: { allow?: string[]; deny?: string[] };
  maxTurns?: number;
}

/** A config as an author writes it. */
export interface ConfigInput {
  defaults?: { model?: string; maxTurns?: number };
  roles: Record<string, RoleInput>;
  limits?: { maxAgents?: number; maxTurns?: number };
}

/** A role with every default applied. */
export interface ResolvedRole {
  model: string;
  tools: { allow: string[]; deny: string[] };
  maxTurns: number;
}

/** A config with every default applied and `defaults` folded into the roles it governed. */
export interface ResolvedConfig {
  roles: Record<string, ResolvedRole>;
  limits: { maxAgents: number; maxTurns: number };
}

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The value {@link defineConfig} returns: resolved, and frozen all the way down. */
export type FrozenConfig = DeepReadonly<ResolvedConfig>;

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(
        `${path}.${key} is not a field orc enforces; accepted here: ${allowed.join(", ")}. ` +
          `A policy orc cannot enforce is worse than one it cannot express (phase-1.md §2.6).`,
      );
    }
  }
}

function asPositiveInt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${path} must be a positive integer`);
  }
  return value;
}

function asNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ConfigError(`${path} must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array of strings`);
  return value.map((item, i) => asNonEmptyString(item, `${path}[${i}]`));
}

// Freezing only throws on write under strict mode; every module here is ESM, which always is.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Identity, with types. Exists so a config reads the way plugin-api.md shows it.
 *
 * @param r a role definition
 * @returns the same object
 */
export function role(r: RoleInput): RoleInput {
  return r;
}

/**
 * Validate a config, apply every default, and freeze the result.
 *
 * `defaults` is folded into the roles it governed, so two configs that describe the same
 * configuration by different routes resolve — and therefore {@link hash} — identically.
 *
 * @param input the config as written
 * @returns the resolved config, frozen all the way down
 * @throws ConfigError on an unknown key, a missing `roles`, or a field of the wrong type
 */
export function defineConfig(input: ConfigInput): FrozenConfig {
  const root = asObject(input, "config");
  rejectUnknownKeys(root, ROOT_KEYS, "config");

  const defaults = root.defaults === undefined ? {} : asObject(root.defaults, "config.defaults");
  rejectUnknownKeys(defaults, DEFAULTS_KEYS, "config.defaults");
  const defaultModel =
    defaults.model === undefined
      ? DEFAULT_MODEL
      : asNonEmptyString(defaults.model, "config.defaults.model");
  const defaultMaxTurns =
    defaults.maxTurns === undefined
      ? DEFAULT_ROLE_MAX_TURNS
      : asPositiveInt(defaults.maxTurns, "config.defaults.maxTurns");

  if (root.roles === undefined) throw new ConfigError("config.roles is required");
  const rolesInput = asObject(root.roles, "config.roles");
  if (Object.keys(rolesInput).length === 0) {
    throw new ConfigError("config.roles must name at least one role");
  }

  const roles: Record<string, ResolvedRole> = {};
  for (const name of Object.keys(rolesInput)) {
    const at = `config.roles.${name}`;
    const roleInput = asObject(rolesInput[name], at);
    rejectUnknownKeys(roleInput, ROLE_KEYS, at);
    if (roleInput.tools === undefined) {
      throw new ConfigError(`${at}.tools is required; a role states its tool policy explicitly`);
    }
    const tools = asObject(roleInput.tools, `${at}.tools`);
    rejectUnknownKeys(tools, TOOLS_KEYS, `${at}.tools`);
    roles[name] = {
      model:
        roleInput.model === undefined
          ? defaultModel
          : asNonEmptyString(roleInput.model, `${at}.model`),
      tools: {
        allow: tools.allow === undefined ? [] : asStringArray(tools.allow, `${at}.tools.allow`),
        deny: tools.deny === undefined ? [] : asStringArray(tools.deny, `${at}.tools.deny`),
      },
      maxTurns:
        roleInput.maxTurns === undefined
          ? defaultMaxTurns
          : asPositiveInt(roleInput.maxTurns, `${at}.maxTurns`),
    };
  }

  const limits = root.limits === undefined ? {} : asObject(root.limits, "config.limits");
  rejectUnknownKeys(limits, LIMITS_KEYS, "config.limits");

  const resolved: ResolvedConfig = {
    roles,
    limits: {
      maxAgents:
        limits.maxAgents === undefined
          ? DEFAULT_MAX_AGENTS
          : asPositiveInt(limits.maxAgents, "config.limits.maxAgents"),
      maxTurns:
        limits.maxTurns === undefined
          ? DEFAULT_RUN_MAX_TURNS
          : asPositiveInt(limits.maxTurns, "config.limits.maxTurns"),
    },
  };
  return deepFreeze(resolved) as FrozenConfig;
}

function writeCanonical(value: unknown, out: string[], path: string): void {
  let v = value;
  if (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { toJSON?: unknown }).toJSON === "function"
  ) {
    v = (v as { toJSON: () => unknown }).toJSON();
  }

  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(v)) {
        throw new ConfigError(`${path} is ${String(v)}, which JSON cannot represent`);
      }
      out.push(JSON.stringify(v));
      return;
    case "string":
      out.push(JSON.stringify(v));
      return;
    case "object":
      break;
    default:
      throw new ConfigError(`${path} is a ${typeof v}, which has no canonical JSON form`);
  }

  if (Array.isArray(v)) {
    out.push("[");
    (v as unknown[]).forEach((item, i) => {
      if (i > 0) out.push(",");
      // JSON renders a hole or an undefined element as null; match it so indices stay meaningful.
      if (item === undefined) out.push("null");
      else writeCanonical(item, out, `${path}[${i}]`);
    });
    out.push("]");
    return;
  }

  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  out.push("{");
  keys.forEach((k, i) => {
    if (i > 0) out.push(",");
    out.push(JSON.stringify(k), ":");
    writeCanonical(obj[k], out, `${path}.${k}`);
  });
  out.push("}");
}

/**
 * Serialize a value to canonical JSON: object keys sorted, no whitespace, numbers shortest
 * round-trip, strings JSON-escaped. Object properties whose value is `undefined` are omitted;
 * `undefined` inside an array becomes `null`, as JSON does.
 *
 * This is the one implementation every hash in phase 1 uses.
 *
 * @param value any JSON-representable value; `toJSON()` is honoured if present
 * @returns the canonical encoding
 * @throws ConfigError on a non-finite number, a function, a symbol or a bigint
 */
export function canonical(value: unknown): string {
  const out: string[] = [];
  writeCanonical(value, out, "value");
  return out.join("");
}

/**
 * The sha256 of a value's canonical JSON.
 *
 * @param value any value {@link canonical} accepts
 * @returns `sha256:` followed by lowercase hex
 */
export function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}
