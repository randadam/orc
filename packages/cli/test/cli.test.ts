import { createRun, type CreateRunOptions, type RunDir } from "@orc/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseArgs, runsDirOf, UsageError, type Io } from "../src/cli.js";
import { duration, elapsed, fields, table } from "../src/format.js";
import { main } from "../src/main.js";

let root: string;
let runsDir: string;
let io: Io;
/** What every {@link Io} this test builds wrote, whatever cwd or environment it carried. */
let captured: { stdout: string; stderr: string };

/** An {@link Io} writing into {@link captured}; spreading one keeps that, a `this` would not. */
function makeIo(over: Partial<Io> = {}): Io {
  return {
    out: (text) => (captured.stdout += text),
    err: (text) => (captured.stderr += text),
    cwd: root,
    env: {},
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orc-cli-"));
  runsDir = join(root, ".orc", "runs");
  captured = { stdout: "", stderr: "" };
  io = makeIo();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(id: string): CreateRunOptions {
  return {
    runsDir,
    id,
    workflow: { name: "loop-and-escape", file: "examples/loop-and-escape/workflow.ts" },
    input: { task: "add a due date" },
    workspace: { source: "https://github.com/randadam/tudu", ref: "bf25ac6" },
    config: {
      config: { roles: {} },
      hash: "sha256:1111",
      hashInputs: { config: "sha256:2222", extensions: {}, skills: {} },
    },
    versions: { pi: "0.86.1", orc: "0.1.0" },
    pid: 4242,
    startedAt: "2026-09-22T14:03:11.000Z",
  };
}

/** A finished run carrying one of every record `orc show` prints. */
function seedRun(id: string): RunDir {
  const run = createRun(options(id));
  run.writeStep({
    id: "review:1",
    key: "sha256:aaaa",
    inputs: { prompt: "review" },
    value: { approved: true },
    createdAt: "2026-09-22T14:04:00.000Z",
    durationMs: 5300,
    observed: { agents: ["reviewer-01"], prompts: ["sha256:bbbb"] },
    amended: false,
  });
  run.writeEscalation({
    id: "three-review-rounds-without-approval-1",
    reason: "Three review rounds without approval",
    context: { rounds: 3 },
    askedAt: "2026-09-22T14:05:01.000Z",
    answer: { action: "proceed", note: "ship it", answeredAt: "2026-09-22T14:06:00.000Z" },
    consumed: true,
  });
  run.writeVerify({
    id: "tests:2",
    cmd: "pnpm test",
    cwd: "agents/reviewer-01/workspace",
    exitCode: 1,
    signal: null,
    stdout: "1 failed\n",
    stderr: "",
    sha: "bf25ac6",
    dirty: true,
    startedAt: "2026-09-22T14:04:10.000Z",
    durationMs: 8123,
  });
  run.createAgent({
    id: "reviewer-01",
    role: "reviewer",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    policy: { tools: { allow: ["read"], deny: ["bash"] }, maxTurns: 40 },
    startedAt: "2026-09-22T14:03:20.000Z",
  });
  run.updateRun({ status: "completed", endedAt: "2026-09-22T14:04:23.000Z", turns: 7 });
  return run;
}

describe("parseArgs", () => {
  it("splits a command, positionals and flags", () => {
    const args = parseArgs(["show", "20260922T140311Z-k3f9", "--json", "--runs-dir", "/tmp/r"]);
    expect(args.command).toBe("show");
    expect(args.positionals).toEqual(["20260922T140311Z-k3f9"]);
    expect(args.flags.get("json")).toBe(true);
    expect(args.flags.get("runs-dir")).toBe("/tmp/r");
  });

  it("takes --flag=value too", () => {
    expect(parseArgs(["runs", "--runs-dir=/tmp/r"]).flags.get("runs-dir")).toBe("/tmp/r");
  });

  it("refuses a value flag with no value", () => {
    expect(() => parseArgs(["runs", "--runs-dir"])).toThrow(UsageError);
  });
});

describe("runsDirOf", () => {
  it("prefers the flag over the environment", () => {
    const withEnv = makeIo({ env: { ORC_RUNS_DIR: "/env/runs" } });
    expect(runsDirOf(parseArgs(["runs"]), withEnv)).toBe("/env/runs");
    expect(runsDirOf(parseArgs(["runs", "--runs-dir", "/flag"]), withEnv)).toBe("/flag");
    expect(runsDirOf(parseArgs(["runs"]), io)).toBe(join(root, ".orc", "runs"));
  });
});

describe("orc runs", () => {
  it("lists runs newest first", async () => {
    seedRun("20260922T140311Z-aaaa");
    seedRun("20260922T140312Z-bbbb");
    expect(await main(["runs"], io)).toBe(0);
    const lines = captured.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^RUN\s+STATUS\s+TURNS\s+ELAPSED\s+WORKFLOW$/);
    expect(lines[1]).toContain("20260922T140312Z-bbbb");
    expect(lines[2]).toContain("20260922T140311Z-aaaa");
    expect(lines[1]).toContain("completed");
    expect(lines[1]).toContain("loop-and-escape");
  });

  it("says so when there are none", async () => {
    expect(await main(["runs"], io)).toBe(0);
    expect(captured.stdout).toContain("no runs in");
  });

  it("prints the records under --json", async () => {
    seedRun("20260922T140311Z-aaaa");
    expect(await main(["runs", "--json"], io)).toBe(0);
    const parsed = JSON.parse(captured.stdout) as { id: string; turns: number }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("20260922T140311Z-aaaa");
    expect(parsed[0]?.turns).toBe(7);
  });

  it("reads the runs directory the environment names", async () => {
    seedRun("20260922T140311Z-aaaa");
    expect(await main(["runs"], makeIo({ cwd: "/nowhere", env: { ORC_RUNS_DIR: runsDir } }))).toBe(
      0,
    );
    expect(captured.stdout).toContain("20260922T140311Z-aaaa");
  });
});

describe("orc show", () => {
  it("prints every record of a run named by id", async () => {
    seedRun("20260922T140311Z-aaaa");
    expect(await main(["show", "20260922T140311Z-aaaa"], io)).toBe(0);
    expect(captured.stdout).toContain("run        20260922T140311Z-aaaa");
    expect(captured.stdout).toContain("status     completed");
    expect(captured.stdout).toContain("steps (1)");
    expect(captured.stdout).toContain("review:1");
    expect(captured.stdout).toContain("escalations (1)");
    expect(captured.stdout).toContain("proceed (consumed)");
    expect(captured.stdout).toContain("verify (1)");
    expect(captured.stdout).toContain("exit 1");
    expect(captured.stdout).toContain("agents (1)");
    expect(captured.stdout).toContain("reviewer-01  reviewer  starting");
  });

  it("defaults to the most recent run", async () => {
    seedRun("20260922T140311Z-aaaa");
    seedRun("20260922T140312Z-bbbb");
    expect(await main(["show"], io)).toBe(0);
    expect(captured.stdout).toContain("20260922T140312Z-bbbb");
    expect(captured.stdout).not.toContain("20260922T140311Z-aaaa");
  });

  it("takes a path to a run directory", async () => {
    const run = seedRun("20260922T140311Z-aaaa");
    expect(await main(["show", run.dir], makeIo({ cwd: "/nowhere" }))).toBe(0);
    expect(captured.stdout).toContain("20260922T140311Z-aaaa");
  });

  it("prints the records under --json", async () => {
    seedRun("20260922T140311Z-aaaa");
    expect(await main(["show", "--json"], io)).toBe(0);
    const parsed = JSON.parse(captured.stdout) as { steps: { id: string }[]; agents: unknown[] };
    expect(parsed.steps.map((s) => s.id)).toEqual(["review:1"]);
    expect(parsed.agents).toHaveLength(1);
  });

  it("exits 1 on a run that is not there", async () => {
    seedRun("20260922T140311Z-aaaa");
    expect(await main(["show", "20260922T140312Z-bbbb"], io)).toBe(1);
    expect(captured.stderr).toContain("no run 20260922T140312Z-bbbb");
    expect(captured.stdout).toBe("");
  });

  it("exits 1 when there is no run at all", async () => {
    expect(await main(["show"], io)).toBe(1);
    expect(captured.stderr).toContain("no runs in");
  });
});

describe("usage", () => {
  it("prints usage and exits 1 with no command", async () => {
    expect(await main([], io)).toBe(1);
    expect(captured.stdout).toContain("orc runs");
  });

  it("prints usage and exits 0 for --help", async () => {
    expect(await main(["--help"], io)).toBe(0);
    expect(captured.stdout).toContain("orc show");
  });

  it("exits 1 on an unknown command", async () => {
    expect(await main(["frobnicate"], io)).toBe(1);
    expect(captured.stderr).toContain("unknown command");
  });
});

describe("format", () => {
  it("scales a duration to what a person reads", () => {
    expect(duration(null)).toBe("-");
    expect(duration(820)).toBe("820ms");
    expect(duration(4234)).toBe("4.2s");
    expect(duration(72_000)).toBe("1m12s");
    expect(duration(7_380_000)).toBe("2h03m");
  });

  it("measures an unfinished run against now", () => {
    expect(elapsed("2026-09-22T14:03:11.000Z", "2026-09-22T14:04:23.000Z")).toBe(72_000);
    expect(elapsed("not a date", null)).toBeNull();
    expect(elapsed(new Date(Date.now() - 1000).toISOString(), null)).toBeGreaterThan(0);
  });

  it("aligns columns and labels", () => {
    expect(table(["A", "BBB"], [["aaaa", "b"]])).toEqual(["A     BBB", "aaaa  b"]);
    expect(
      fields([
        ["run", "x"],
        ["workflow", "y"],
      ]),
    ).toEqual(["run       x", "workflow  y"]);
  });
});
