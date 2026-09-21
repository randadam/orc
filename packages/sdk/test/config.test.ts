import { describe, expect, it } from "vitest";

import {
  canonical,
  ConfigError,
  defineConfig,
  hash,
  role,
  type ConfigInput,
  type ResolvedConfig,
} from "../src/config.js";

/** The fixture the golden hash is taken over. Changing it changes {@link GOLDEN}. */
const FIXTURE: ConfigInput = {
  defaults: { model: "claude-sonnet-5", maxTurns: 40 },
  roles: {
    reviewer: role({ tools: { allow: ["read", "grep"], deny: ["write"] } }),
    implementer: role({ tools: { allow: ["read", "write", "edit", "bash"] }, maxTurns: 25 }),
  },
  limits: { maxAgents: 4, maxTurns: 200 },
};

const GOLDEN = "sha256:a973f7368f07ec83589a8b0e522a6d6c20dc515a3eea44cb9bd4bee606db1bb0";

/** A frozen config, typed mutable, so a test can attempt the write that should throw. */
function mutable(c: unknown): ResolvedConfig {
  return c as ResolvedConfig;
}

function reviewerOf(c: ResolvedConfig) {
  const r = c.roles.reviewer;
  if (r === undefined) throw new Error("fixture has no reviewer role");
  return r;
}

describe("defineConfig", () => {
  it("applies every default", () => {
    const c = defineConfig({ roles: { solo: { tools: { allow: ["read"] } } } });
    expect(c).toEqual({
      roles: {
        solo: { model: "claude-sonnet-5", tools: { allow: ["read"], deny: [] }, maxTurns: 40 },
      },
      limits: { maxAgents: 4, maxTurns: 200 },
    });
  });

  it("folds defaults into the roles they governed", () => {
    const viaDefaults = defineConfig({
      defaults: { model: "some-model", maxTurns: 7 },
      roles: { a: { tools: {} } },
    });
    const viaRole = defineConfig({
      roles: { a: { model: "some-model", maxTurns: 7, tools: {} } },
    });
    expect(viaDefaults).toEqual(viaRole);
  });

  it("freezes the result all the way down", () => {
    const c = defineConfig(FIXTURE);
    expect(Object.isFrozen(c)).toBe(true);
    expect(() => (mutable(c).limits.maxAgents = 9)).toThrow(TypeError);
    expect(() => (reviewerOf(mutable(c)).model = "other")).toThrow(TypeError);
    expect(() => reviewerOf(mutable(c)).tools.allow.push("bash")).toThrow(TypeError);
    expect(() => (mutable(c).roles.added = reviewerOf(mutable(c)))).toThrow(TypeError);
  });

  it("rejects a role field orc does not enforce", () => {
    const withEgress = {
      roles: { a: { tools: { allow: ["read"] }, egress: ["github.com"] } },
    } as unknown as ConfigInput;
    expect(() => defineConfig(withEgress)).toThrow(ConfigError);
    expect(() => defineConfig(withEgress)).toThrow(/config\.roles\.a\.egress is not a field/);
  });

  it("rejects unknown keys at every level", () => {
    const cases: Array<[string, unknown]> = [
      ["config.secrets", { secrets: {}, roles: { a: { tools: {} } } }],
      ["config.defaults.effort", { defaults: { effort: "low" }, roles: { a: { tools: {} } } }],
      ["config.roles.a.tools.require", { roles: { a: { tools: { require: [] } } } }],
      ["config.limits.usdBudget", { roles: { a: { tools: {} } }, limits: { usdBudget: 25 } }],
    ];
    for (const [expected, input] of cases) {
      expect(() => defineConfig(input as ConfigInput), expected).toThrow(expected);
    }
  });

  it("requires roles, and a tool policy on each", () => {
    expect(() => defineConfig({} as unknown as ConfigInput)).toThrow(/config\.roles is required/);
    expect(() => defineConfig({ roles: {} })).toThrow(/at least one role/);
    expect(() => defineConfig({ roles: { a: {} } as unknown as ConfigInput["roles"] })).toThrow(
      /config\.roles\.a\.tools is required/,
    );
  });

  it("rejects fields of the wrong type", () => {
    const bad: Array<[string, unknown]> = [
      ["config.roles must be an object", { roles: [] }],
      [
        "config.roles.a.maxTurns must be a positive integer",
        { roles: { a: { tools: {}, maxTurns: 0 } } },
      ],
      [
        "config.roles.a.maxTurns must be a positive integer",
        { roles: { a: { tools: {}, maxTurns: 1.5 } } },
      ],
      [
        "config.roles.a.model must be a non-empty string",
        { roles: { a: { tools: {}, model: "" } } },
      ],
      [
        "config.roles.a.tools.allow must be an array",
        { roles: { a: { tools: { allow: "read" } } } },
      ],
      [
        "config.roles.a.tools.allow[0] must be a non-empty string",
        { roles: { a: { tools: { allow: [1] } } } },
      ],
    ];
    for (const [expected, input] of bad) {
      expect(() => defineConfig(input as ConfigInput), expected).toThrow(expected);
    }
  });
});

describe("canonical", () => {
  it("sorts object keys at every depth", () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    expect(canonical({ xs: ["b", "a", "c"] })).toBe('{"xs":["b","a","c"]}');
  });

  it("omits undefined properties and nulls undefined array elements", () => {
    expect(canonical({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonical([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("emits no whitespace", () => {
    expect(canonical({ a: [1, 2], b: "x" })).not.toMatch(/\s/);
  });

  it("escapes strings as JSON does", () => {
    expect(canonical('a"b\n')).toBe('"a\\"b\\n"');
    expect(canonical({ ключ: "значение" })).toBe('{"ключ":"значение"}');
  });

  it("honours toJSON", () => {
    expect(canonical({ at: new Date(0) })).toBe('{"at":"1970-01-01T00:00:00.000Z"}');
  });

  it("rejects what JSON cannot represent", () => {
    expect(() => canonical(Number.NaN)).toThrow(ConfigError);
    expect(() => canonical({ a: Number.POSITIVE_INFINITY })).toThrow(/value\.a is Infinity/);
    expect(() => canonical({ f: () => 1 })).toThrow(/value\.f is a function/);
    expect(() => canonical({ n: 1n })).toThrow(/value\.n is a bigint/);
  });
});

describe("hash", () => {
  it("is identical under key reordering", () => {
    const a = defineConfig(FIXTURE);
    const reordered = defineConfig({
      limits: { maxTurns: 200, maxAgents: 4 },
      roles: {
        implementer: role({ maxTurns: 25, tools: { allow: ["read", "write", "edit", "bash"] } }),
        reviewer: role({ tools: { deny: ["write"], allow: ["read", "grep"] } }),
      },
      defaults: { maxTurns: 40, model: "claude-sonnet-5" },
    });
    expect(hash(reordered)).toBe(hash(a));
  });

  it("matches the golden hash for the fixture config", () => {
    expect(hash(defineConfig(FIXTURE))).toBe(GOLDEN);
  });

  it("changes when a value changes", () => {
    const tighter = defineConfig({
      ...FIXTURE,
      limits: { maxAgents: 2, maxTurns: 200 },
    });
    expect(hash(tighter)).not.toBe(GOLDEN);
  });

  it("changes when array order changes", () => {
    const swapped = defineConfig({
      roles: { a: { tools: { allow: ["read", "grep"] } } },
    });
    const other = defineConfig({
      roles: { a: { tools: { allow: ["grep", "read"] } } },
    });
    expect(hash(swapped)).not.toBe(hash(other));
  });

  it("is sha256 of the canonical encoding", () => {
    expect(hash({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("role", () => {
  it("returns its argument", () => {
    const r = { tools: { allow: ["read"] } };
    expect(role(r)).toBe(r);
  });
});
