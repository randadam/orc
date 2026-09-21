import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertId,
  createRun,
  decodeId,
  defaultRunsDir,
  encodeId,
  latestRun,
  listRuns,
  newRunId,
  openRun,
  RunDir,
  RunDirError,
  RUN_ID_PATTERN,
  type CreateRunOptions,
} from "../src/rundir.js";

const LAYOUT = fileURLToPath(new URL("./fixtures/run-dir-layout.txt", import.meta.url));

let root: string;
let runsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orc-rundir-"));
  runsDir = join(root, ".orc", "runs");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function options(id: string, over: Partial<CreateRunOptions> = {}): CreateRunOptions {
  return {
    runsDir,
    id,
    workflow: { name: "loop-and-escape", file: "examples/loop-and-escape/workflow.ts" },
    input: { task: "add a due date to a todo" },
    workspace: { source: "https://github.com/randadam/tudu", ref: "bf25ac6" },
    config: {
      config: { roles: { reviewer: { tools: { allow: ["read"], deny: [] } } } },
      hash: "sha256:1111",
      hashInputs: {
        config: "sha256:2222",
        extensions: { "packages/pi/dist/index.js": "sha256:3333" },
        skills: {},
      },
    },
    versions: { pi: "0.86.1", orc: "0.1.0" },
    pid: 4242,
    startedAt: "2026-09-22T14:03:11.000Z",
    ...over,
  };
}

/** Every path under `dir`, relative and sorted; directories carry a trailing slash so the empty
 * ones `find -type f` cannot show are part of the comparison too. */
function layout(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      const isDir = statSync(full).isDirectory();
      out.push(relative(dir, full).replaceAll("\\", "/") + (isDir ? "/" : ""));
      if (isDir) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** Write a raw record, bypassing the writers, so a reader can be shown one it should refuse. */
function writeRecord(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

/** The scripted writer: one run directory carrying one of every record in phase-1.md §4. */
function scriptedRun(): RunDir {
  const run = createRun(options("20260922T140311Z-k3f9"));
  run.writeStep({
    id: "review:1",
    key: "sha256:aaaa",
    inputs: { prompt: "review the diff", diff: "diff --git a/x b/x" },
    value: { approved: false, comments: ["name the variable"] },
    createdAt: "2026-09-22T14:04:00.000Z",
    durationMs: 5300,
    observed: { agents: ["reviewer-01"], prompts: ["sha256:bbbb"] },
    amended: false,
  });
  run.writeStep({
    id: "arbitrate:3",
    key: "sha256:cccc",
    inputs: { round: 3 },
    value: "escalate",
    createdAt: "2026-09-22T14:05:00.000Z",
    durationMs: 120,
    observed: { agents: [], prompts: [] },
    amended: true,
  });
  run.writeEscalation({
    id: "three-review-rounds-without-approval-1",
    reason: "Three review rounds without approval",
    context: { rounds: 3, lastComment: "still not addressed" },
    askedAt: "2026-09-22T14:05:01.000Z",
  });
  run.writeVerify({
    id: "tests:2",
    cmd: "pnpm test",
    cwd: "agents/reviewer-01/workspace",
    exitCode: 1,
    signal: null,
    stdout: "46 tests, 1 failed\n",
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
    policy: { tools: { allow: ["read", "grep", "find", "ls"], deny: [] }, maxTurns: 40 },
    startedAt: "2026-09-22T14:03:20.000Z",
  });
  run.appendLog({ t: "2026-09-22T14:03:12.000Z", level: "info", msg: "run started", turns: 0 });
  run.appendTrace({ resource: { "service.name": "orc", "orc.run.id": run.id } });
  run.updateRun({ status: "escalated", endedAt: "2026-09-22T14:05:02.000Z", turns: 7 });
  return run;
}

describe("ids", () => {
  it("encodes a colon and round-trips", () => {
    expect(encodeId("arbitrate:3")).toBe("arbitrate%3A3");
    expect(decodeId("arbitrate%3A3.json")).toBe("arbitrate:3");
    for (const id of ["a", "review:1", "tests.unit-2", "A_b.c:d-9"]) {
      expect(decodeId(`${encodeId(id)}.json`)).toBe(id);
    }
  });

  it("leaves an id needing no encoding alone", () => {
    expect(encodeId("review-1")).toBe("review-1");
    expect(encodeId("a".repeat(128))).toBe("a".repeat(128));
  });

  it("rejects anything that could name another file", () => {
    for (const bad of ["", "-lead", ".hidden", "..", "a/b", "a b", "a%2F", "a".repeat(129), "é"]) {
      expect(() => assertId(bad, "step id")).toThrow(RunDirError);
    }
  });
});

describe("newRunId", () => {
  it("is a UTC basic timestamp and four base36 characters", () => {
    const id = newRunId(new Date("2026-09-22T14:03:11.000Z"));
    expect(id).toMatch(RUN_ID_PATTERN);
    expect(id.slice(0, 16)).toBe("20260922T140311Z");
  });

  it("sorts by time", () => {
    const early = newRunId(new Date("2026-09-22T14:03:11.000Z"));
    const late = newRunId(new Date("2026-09-22T14:03:12.000Z"));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("is distinct within the same second", () => {
    const at = new Date("2026-09-22T14:03:11.000Z");
    const ids = new Set(Array.from({ length: 64 }, () => newRunId(at)));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe("defaultRunsDir", () => {
  it("prefers the flag, then the environment, then .orc/runs", () => {
    expect(defaultRunsDir("/tmp/a", "/work", {})).toBe("/tmp/a");
    expect(defaultRunsDir("rel", "/work", { ORC_RUNS_DIR: "/env" })).toBe("/work/rel");
    expect(defaultRunsDir(undefined, "/work", { ORC_RUNS_DIR: "/env" })).toBe("/env");
    expect(defaultRunsDir(undefined, "/work", {})).toBe("/work/.orc/runs");
  });
});

describe("the run directory layout", () => {
  it("matches the checked-in listing", () => {
    const run = scriptedRun();
    const expected = readFileSync(LAYOUT, "utf8").trim().split("\n");
    expect(layout(run.dir)).toEqual(expected);
  });

  it("leaves no temporary file behind", () => {
    const run = scriptedRun();
    expect(layout(run.dir).filter((p) => p.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a second run on the same id", () => {
    createRun(options("20260922T140311Z-k3f9"));
    expect(() => createRun(options("20260922T140311Z-k3f9"))).toThrow(RunDirError);
  });

  it("refuses a run id that is not a run id", () => {
    expect(() => createRun(options("not-a-run-id"))).toThrow(RunDirError);
  });
});

describe("records", () => {
  it("round-trips the run through its reader", () => {
    const run = createRun(options("20260922T140311Z-k3f9"));
    expect(run.readRun()).toEqual({
      version: 1,
      id: "20260922T140311Z-k3f9",
      workflow: { name: "loop-and-escape", file: "examples/loop-and-escape/workflow.ts" },
      input: { task: "add a due date to a todo" },
      workspace: { source: "https://github.com/randadam/tudu", ref: "bf25ac6" },
      configHash: "sha256:1111",
      status: "running",
      startedAt: "2026-09-22T14:03:11.000Z",
      endedAt: null,
      result: null,
      error: null,
      turns: 0,
      pid: 4242,
      pi: { version: "0.86.1" },
      orc: { version: "0.1.0" },
    });
  });

  it("round-trips the config, with the hash the run points at", () => {
    const run = createRun(options("20260922T140311Z-k3f9"));
    const config = run.readConfig();
    expect(config?.hash).toBe(run.readRun().configHash);
    expect(config?.hashInputs.extensions).toEqual({
      "packages/pi/dist/index.js": "sha256:3333",
    });
  });

  it("round-trips every step, escalation, verify and agent", () => {
    const run = scriptedRun();
    const reopened = openRun(run.dir);

    expect(reopened.readStep("review:1")?.value).toEqual({
      approved: false,
      comments: ["name the variable"],
    });
    expect(reopened.readStep("arbitrate:3")?.amended).toBe(true);
    expect(reopened.readStep("never-ran")).toBeNull();
    expect(reopened.listSteps().map((s) => s.id)).toEqual(["arbitrate:3", "review:1"]);

    const escalation = reopened.readEscalation("three-review-rounds-without-approval-1");
    expect(escalation).toEqual({
      version: 1,
      id: "three-review-rounds-without-approval-1",
      reason: "Three review rounds without approval",
      context: { rounds: 3, lastComment: "still not addressed" },
      truncated: false,
      askedAt: "2026-09-22T14:05:01.000Z",
      answer: null,
      consumed: false,
    });
    expect(reopened.listEscalations()).toEqual([escalation]);

    const verify = reopened.readVerify("tests:2");
    expect(verify?.exitCode).toBe(1);
    expect(verify?.truncated).toBe(false);
    expect(verify?.cmd).toBe("pnpm test");
    expect(reopened.listVerifies().map((v) => v.id)).toEqual(["tests:2"]);

    const agent = reopened.readAgent("reviewer-01");
    expect(agent).toEqual({
      version: 1,
      id: "reviewer-01",
      role: "reviewer",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      policy: { tools: { allow: ["read", "grep", "find", "ls"], deny: [] }, maxTurns: 40 },
      ask: null,
      workspace: "agents/reviewer-01/workspace",
      sessionFile: null,
      pid: null,
      status: "starting",
      turns: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, provisional: true },
      startedAt: "2026-09-22T14:03:20.000Z",
      endedAt: null,
    });
    expect(reopened.listAgents()).toEqual([agent]);

    expect(reopened.readLog()).toEqual([
      { t: "2026-09-22T14:03:12.000Z", level: "info", msg: "run started", turns: 0 },
    ]);
    expect(reopened.readTrace()).toEqual([
      { resource: { "service.name": "orc", "orc.run.id": "20260922T140311Z-k3f9" } },
    ]);
    expect(reopened.report().run.status).toBe("escalated");
  });

  it("updates the run in place", () => {
    const run = createRun(options("20260922T140311Z-k3f9"));
    const updated = run.updateRun({ status: "completed", result: { ok: true }, turns: 9 });
    expect(updated.status).toBe("completed");
    expect(run.readRun()).toEqual(updated);
    expect(run.readRun().startedAt).toBe("2026-09-22T14:03:11.000Z");
  });

  it("updates an agent in place and refuses one that does not exist", () => {
    const run = scriptedRun();
    const updated = run.updateAgent("reviewer-01", { status: "stopped", turns: 3 });
    expect(updated.turns).toBe(3);
    expect(run.readAgent("reviewer-01")?.status).toBe("stopped");
    expect(() => run.updateAgent("ghost-09", { turns: 1 })).toThrow(RunDirError);
  });

  it("overwrites a step and deletes it on amend", () => {
    const run = scriptedRun();
    run.writeStep({
      id: "review:1",
      key: "sha256:dddd",
      inputs: {},
      value: { approved: true, comments: [] },
      createdAt: "2026-09-22T14:06:00.000Z",
      durationMs: 1,
      observed: { agents: [], prompts: [] },
      amended: false,
    });
    expect(run.readStep("review:1")?.key).toBe("sha256:dddd");
    expect(run.deleteStep("review:1")).toBe(true);
    expect(run.readStep("review:1")).toBeNull();
    expect(run.deleteStep("review:1")).toBe(false);
  });

  it("reads the wire logs an agent's process writes", () => {
    const run = scriptedRun();
    const paths = run.agentPaths("reviewer-01");
    expect(existsSync(paths.stderr)).toBe(true);
    expect(run.readAgentEvents("reviewer-01")).toEqual([]);
    expect(run.readAgentCommands("reviewer-01")).toEqual([]);
  });

  it("refuses a record from a version it does not read", () => {
    const run = createRun(options("20260922T140311Z-k3f9"));
    const bad = new RunDir(run.dir);
    rmSync(bad.runFile);
    expect(() => bad.readRun()).toThrow(RunDirError);
    writeRecord(bad.runFile, { version: 2, id: bad.id });
    expect(() => bad.readRun()).toThrow(/version 2/);
  });
});

describe("truncation", () => {
  it("cuts an escalation context to 64 KiB and says so", () => {
    const run = createRun(options("20260922T140311Z-k3f9"));
    const record = run.writeEscalation({
      id: "too-much-context-1",
      reason: "too much context",
      context: { blob: "x".repeat(200_000) },
      askedAt: "2026-09-22T14:05:01.000Z",
    });
    expect(record.truncated).toBe(true);
    expect(typeof record.context).toBe("string");
    expect(Buffer.byteLength(record.context as string, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(run.readEscalation("too-much-context-1")?.truncated).toBe(true);
  });

  it("cuts a verify stream to 1 MiB and says so", () => {
    const run = createRun(options("20260922T140311Z-k3f9"));
    const record = run.writeVerify({
      id: "tests:1",
      cmd: "pnpm test",
      cwd: ".",
      exitCode: 0,
      signal: null,
      stdout: "y".repeat(1024 * 1024 + 10),
      stderr: "",
      sha: "bf25ac6",
      dirty: false,
      startedAt: "2026-09-22T14:04:10.000Z",
      durationMs: 10,
    });
    expect(record.truncated).toBe(true);
    expect(Buffer.byteLength(record.stdout, "utf8")).toBe(1024 * 1024);
    expect(record.stderr).toBe("");
  });

  it("never cuts a multi-byte character in half", () => {
    const run = createRun(options("20260922T140311Z-k3f9"));
    const record = run.writeVerify({
      id: "tests:1",
      cmd: "pnpm test",
      cwd: ".",
      exitCode: 0,
      signal: null,
      // Three bytes each, so the 1 MiB boundary lands mid-character.
      stdout: "√".repeat(400_000),
      stderr: "",
      sha: "bf25ac6",
      dirty: false,
      startedAt: "2026-09-22T14:04:10.000Z",
      durationMs: 10,
    });
    expect(record.stdout).toMatch(/^√+$/);
    expect(Buffer.byteLength(record.stdout, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(run.readVerify("tests:1")?.stdout).toBe(record.stdout);
  });
});

describe("listRuns", () => {
  it("is newest first and skips what is not a run", () => {
    createRun(options("20260922T140311Z-aaaa"));
    createRun(options("20260922T140312Z-bbbb"));
    mkdtempSync(join(runsDir, "junk-"));
    expect(listRuns(runsDir).map((s) => s.id)).toEqual([
      "20260922T140312Z-bbbb",
      "20260922T140311Z-aaaa",
    ]);
    expect(latestRun(runsDir)?.id).toBe("20260922T140312Z-bbbb");
  });

  it("is empty when the runs directory does not exist", () => {
    expect(listRuns(join(root, "nothing"))).toEqual([]);
    expect(latestRun(join(root, "nothing"))).toBeNull();
  });
});
