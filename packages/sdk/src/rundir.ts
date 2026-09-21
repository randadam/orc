import { randomInt } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

/** The `version` every record in the run directory carries (phase-1.md §4). */
export const RECORD_VERSION = 1;

/** Step and verify ids; the file name is `encodeURIComponent(id) + ".json"`. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Run ids are a UTC basic timestamp and four base36 characters, so a listing sorts by time. */
export const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-z]{4}$/;

const CONTEXT_MAX_BYTES = 64 * 1024;
const OUTPUT_MAX_BYTES = 1024 * 1024;
const DEFAULT_RUNS_DIR = ".orc/runs";

/** Thrown on a malformed id, a missing run, or a record orc cannot read. */
export class RunDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunDirError";
  }
}

/** Where a run ended up. `escalated` is a run waiting on `orc answer`, not a failure. */
export type RunStatus = "running" | "completed" | "failed" | "aborted" | "escalated";

/** A thrown value, flattened for `run.json`. */
export interface ErrorRecord {
  name: string;
  message: string;
  stack?: string;
}

/** `run.json`: one per run, rewritten atomically on every status change. */
export interface RunRecord {
  version: number;
  id: string;
  workflow: { name: string; file: string };
  input: unknown;
  workspace: { source: string; ref: string };
  configHash: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  result: unknown;
  error: ErrorRecord | null;
  turns: number;
  /** The pid that holds the run; `orc resume` rejects a `running` run whose pid is alive. */
  pid: number | null;
  pi: { version: string };
  orc: { version: string };
}

/** What the config hash was taken over (phase-1.md §4.2). */
export interface HashInputs {
  config: string;
  extensions: Record<string, string>;
  skills: Record<string, string>;
}

/** `config.json`: the frozen config snapshot plus what went into the hash. */
export interface ConfigRecord {
  version: number;
  config: unknown;
  hash: string;
  hashInputs: HashInputs;
}

/** `steps/<encoded-id>.json`: a memoized step, keyed over its declared inputs (phase-1.md §2.4). */
export interface StepRecord {
  version: number;
  id: string;
  key: string;
  inputs: Record<string, unknown>;
  value: unknown;
  createdAt: string;
  durationMs: number;
  /** What actually happened inside `fn`, as opposed to what the key declares. */
  observed: { agents: string[]; prompts: string[] };
  amended: boolean;
}

/** What a human answered an escalation with. `amend` names the step to delete. */
export interface EscalationAnswer {
  action: "abort" | "proceed" | "amend";
  step?: string;
  note?: string;
  answeredAt: string;
}

/** `escalations/<id>.json`: one question put to a human, and its answer once given. */
export interface EscalationRecord {
  version: number;
  id: string;
  reason: string;
  context: unknown;
  /** True when `context` was cut to 64 KiB and is stored as its truncated JSON text. */
  truncated: boolean;
  askedAt: string;
  answer: EscalationAnswer | null;
  consumed: boolean;
}

/** `verify/<encoded-id>.json`: an exit code the runner produced, never the agent. */
export interface VerifyRecord {
  version: number;
  id: string;
  cmd: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True when either stream was cut to 1 MiB. */
  truncated: boolean;
  sha: string;
  dirty: boolean;
  startedAt: string;
  durationMs: number;
}

/** Provisional token and dollar counts, read off Pi's `turn_end` (phase-1.md §7). */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  provisional: boolean;
}

/** Where an agent process is in its life. */
export type AgentStatus = "starting" | "idle" | "running" | "stopped" | "failed" | "turn_cap";

/** The structured output an `ask()` expects back, as JSON Schema. */
export interface AgentAsk {
  schema: unknown;
  description?: string;
}

/** `agents/<id>/agent.json` — the agent file, orc's only channel to the extension. */
export interface AgentRecord {
  version: number;
  id: string;
  role: string;
  model: { provider: string; id: string };
  policy: { tools: { allow: string[]; deny: string[] }; maxTurns: number };
  ask: AgentAsk | null;
  workspace: string;
  sessionFile: string | null;
  pid: number | null;
  status: AgentStatus;
  turns: number;
  usage: Usage;
  startedAt: string;
  endedAt: string | null;
}

/** One line of `log.jsonl`. */
export interface LogRecord {
  t: string;
  level: "info" | "warn" | "error";
  msg: string;
  [field: string]: unknown;
}

/** One line of `events.jsonl` or `commands.jsonl`: Pi's record, verbatim, with its receive time. */
export interface WireRecord {
  t: number;
  [key: string]: unknown;
}

/** A record as a caller writes it; `version` is stamped by the writer. */
export type RunInit = Omit<RunRecord, "version">;
/** A config record as a caller writes it. */
export type ConfigInit = Omit<ConfigRecord, "version">;
/** A step record as a caller writes it. */
export type StepInit = Omit<StepRecord, "version">;

/** An escalation as a caller writes it; `context` is truncated and `truncated` computed on write. */
export interface EscalationInit {
  id: string;
  reason: string;
  context?: unknown;
  askedAt: string;
  answer?: EscalationAnswer | null;
  consumed?: boolean;
}

/** A verify record as a caller writes it; the streams are capped and `truncated` computed. */
export type VerifyInit = Omit<VerifyRecord, "version" | "truncated">;

/** An agent as a caller creates it; everything else starts at its zero value. */
export interface AgentInit {
  id: string;
  role: string;
  model: { provider: string; id: string };
  policy: { tools: { allow: string[]; deny: string[] }; maxTurns: number };
  ask?: AgentAsk | null;
  startedAt?: string;
}

/** The files and directories one agent owns, all absolute. */
export interface AgentPaths {
  dir: string;
  file: string;
  events: string;
  commands: string;
  stderr: string;
  session: string;
  home: string;
  workspace: string;
}

/** A run directory listed without opening every record twice. */
export interface RunSummary {
  id: string;
  dir: string;
  run: RunRecord;
}

/** Everything `orc show` reads, gathered in one pass. */
export interface RunReport {
  run: RunRecord;
  config: ConfigRecord | null;
  steps: StepRecord[];
  escalations: EscalationRecord[];
  verifies: VerifyRecord[];
  agents: AgentRecord[];
}

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Cutting a multi-byte sequence in half yields invalid UTF-8; back up to the last lead byte.
  while (end > 0 && ((buf[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--;
  return buf.subarray(0, end).toString("utf8");
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function readJson<T>(file: string, what: string): T | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new RunDirError(`${what} at ${file} is not JSON: ${(err as Error).message}`);
  }
  const version = (value as { version?: unknown } | null)?.version;
  if (typeof value !== "object" || value === null || version !== RECORD_VERSION) {
    throw new RunDirError(
      `${what} at ${file} is version ${JSON.stringify(version)}; orc reads version ${RECORD_VERSION}`,
    );
  }
  return value as T;
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

/**
 * Check an id against {@link ID_PATTERN}.
 *
 * @param id the step, verify or escalation id
 * @param what named in the error, e.g. `"step id"`
 * @returns the same id
 * @throws RunDirError when it does not match
 */
export function assertId(id: string, what = "id"): string {
  if (!ID_PATTERN.test(id)) {
    throw new RunDirError(
      `${what} ${JSON.stringify(id)} must match ${String(ID_PATTERN)}: ` +
        `it names a file in the run directory`,
    );
  }
  return id;
}

/**
 * The file-name form of an id. `arbitrate:3` becomes `arbitrate%3A3`.
 *
 * @param id a valid id
 * @returns the encoded name, without an extension
 */
export function encodeId(id: string): string {
  return encodeURIComponent(assertId(id));
}

/**
 * The inverse of {@link encodeId}.
 *
 * @param name an encoded name, with or without a trailing `.json`
 * @returns the original id
 */
export function decodeId(name: string): string {
  return assertId(decodeURIComponent(name.replace(/\.json$/, "")));
}

/**
 * A fresh run id: `<UTC basic timestamp>-<4 base36>`, e.g. `20260922T140311Z-k3f9`.
 *
 * @param now the instant to stamp; defaults to the current time
 * @returns the id
 */
export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const suffix = randomInt(36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${stamp}-${suffix}`;
}

/**
 * Where run directories live: `--runs-dir`, else `ORC_RUNS_DIR`, else `.orc/runs` under the cwd.
 *
 * @param override the value of `--runs-dir`, if given
 * @param cwd the directory `orc` was invoked from
 * @param env the process environment
 * @returns an absolute path
 */
export function defaultRunsDir(
  override?: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const chosen = override ?? env.ORC_RUNS_DIR ?? DEFAULT_RUNS_DIR;
  return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
}

/** One run directory: every path under it, and every record in phase-1.md §4. */
export class RunDir {
  /** Absolute path to `<runs-dir>/<run-id>/`. */
  readonly dir: string;
  /** The run id, which is also the directory name. */
  readonly id: string;

  /**
   * Wrap an existing path. Prefer {@link createRun} or {@link openRun}, which check it.
   *
   * @param dir the run directory, absolute or relative to the cwd
   */
  constructor(dir: string) {
    this.dir = resolve(dir);
    this.id = basename(this.dir);
  }

  /** `run.json`. */
  get runFile(): string {
    return join(this.dir, "run.json");
  }

  /** `config.json`. */
  get configFile(): string {
    return join(this.dir, "config.json");
  }

  /** `trace.jsonl`. */
  get traceFile(): string {
    return join(this.dir, "trace.jsonl");
  }

  /** `log.jsonl`. */
  get logFile(): string {
    return join(this.dir, "log.jsonl");
  }

  /** `steps/`. */
  get stepsDir(): string {
    return join(this.dir, "steps");
  }

  /** `escalations/`. */
  get escalationsDir(): string {
    return join(this.dir, "escalations");
  }

  /** `verify/`. */
  get verifyDir(): string {
    return join(this.dir, "verify");
  }

  /** `agents/`. */
  get agentsDir(): string {
    return join(this.dir, "agents");
  }

  /**
   * @param id a step id
   * @returns the absolute path to its record
   */
  stepFile(id: string): string {
    return join(this.stepsDir, `${encodeId(id)}.json`);
  }

  /**
   * @param id an escalation id
   * @returns the absolute path to its record
   */
  escalationFile(id: string): string {
    return join(this.escalationsDir, `${encodeId(id)}.json`);
  }

  /**
   * @param id a verify id
   * @returns the absolute path to its record
   */
  verifyFile(id: string): string {
    return join(this.verifyDir, `${encodeId(id)}.json`);
  }

  /**
   * @param id an agent id
   * @returns every path that agent owns
   */
  agentPaths(id: string): AgentPaths {
    const dir = join(this.agentsDir, encodeId(id));
    return {
      dir,
      file: join(dir, "agent.json"),
      events: join(dir, "events.jsonl"),
      commands: join(dir, "commands.jsonl"),
      stderr: join(dir, "pi.stderr.log"),
      session: join(dir, "session"),
      home: join(dir, "home"),
      workspace: join(dir, "workspace"),
    };
  }

  /**
   * @returns `run.json`
   * @throws RunDirError when it is absent or not version 1
   */
  readRun(): RunRecord {
    const run = readJson<RunRecord>(this.runFile, "run.json");
    if (run === null) throw new RunDirError(`${this.dir} has no run.json`);
    return run;
  }

  /**
   * Rewrite `run.json` atomically.
   *
   * @param run the whole record
   */
  writeRun(run: RunInit): void {
    writeJson(this.runFile, { version: RECORD_VERSION, ...run });
  }

  /**
   * Read, merge and rewrite `run.json`.
   *
   * @param patch the fields to change
   * @returns the record as written
   */
  updateRun(patch: Partial<RunInit>): RunRecord {
    const next = { ...this.readRun(), ...patch, version: RECORD_VERSION };
    writeJson(this.runFile, next);
    return next;
  }

  /**
   * @returns `config.json`, or null when the run has none
   */
  readConfig(): ConfigRecord | null {
    return readJson<ConfigRecord>(this.configFile, "config.json");
  }

  /**
   * @param config the frozen config, its hash, and the hash inputs
   */
  writeConfig(config: ConfigInit): void {
    writeJson(this.configFile, { version: RECORD_VERSION, ...config });
  }

  /**
   * @param id a step id
   * @returns its record, or null on a miss
   */
  readStep(id: string): StepRecord | null {
    return readJson<StepRecord>(this.stepFile(id), `step ${id}`);
  }

  /**
   * @param step the whole record; an existing one is overwritten
   */
  writeStep(step: StepInit): void {
    assertId(step.id, "step id");
    writeJson(this.stepFile(step.id), { version: RECORD_VERSION, ...step });
  }

  /**
   * Delete a step's artifact, as an `amend` answer does (phase-1.md §2.5).
   *
   * @param id a step id
   * @returns whether a record was there to delete
   */
  deleteStep(id: string): boolean {
    const file = this.stepFile(id);
    try {
      rmSync(file);
      return true;
    } catch (err) {
      if (isErrno(err, "ENOENT")) return false;
      throw err;
    }
  }

  /**
   * @returns every step record, by id
   */
  listSteps(): StepRecord[] {
    return this.readAll<StepRecord>(this.stepsDir, "step");
  }

  /**
   * @param id an escalation id
   * @returns its record, or null when it was never asked
   */
  readEscalation(id: string): EscalationRecord | null {
    return readJson<EscalationRecord>(this.escalationFile(id), `escalation ${id}`);
  }

  /**
   * Write an escalation, truncating `context` to 64 KiB — it is for a human to read, not a
   * channel for data (phase-1.md §4.3).
   *
   * @param escalation the escalation as asked, with its answer if one is known
   * @returns the record as written
   */
  writeEscalation(escalation: EscalationInit): EscalationRecord {
    assertId(escalation.id, "escalation id");
    const raw = escalation.context ?? null;
    const json = JSON.stringify(raw) ?? "null";
    const truncated = Buffer.byteLength(json, "utf8") > CONTEXT_MAX_BYTES;
    const record: EscalationRecord = {
      version: RECORD_VERSION,
      id: escalation.id,
      reason: escalation.reason,
      context: truncated ? truncateUtf8(json, CONTEXT_MAX_BYTES) : raw,
      truncated,
      askedAt: escalation.askedAt,
      answer: escalation.answer ?? null,
      consumed: escalation.consumed ?? false,
    };
    writeJson(this.escalationFile(record.id), record);
    return record;
  }

  /**
   * @returns every escalation record, by id
   */
  listEscalations(): EscalationRecord[] {
    return this.readAll<EscalationRecord>(this.escalationsDir, "escalation");
  }

  /**
   * @param id a verify id
   * @returns its record, or null when that verify never ran
   */
  readVerify(id: string): VerifyRecord | null {
    return readJson<VerifyRecord>(this.verifyFile(id), `verify ${id}`);
  }

  /**
   * Write a verify record, capping each captured stream at 1 MiB.
   *
   * @param verify the command, its exit status and its output
   * @returns the record as written
   */
  writeVerify(verify: VerifyInit): VerifyRecord {
    assertId(verify.id, "verify id");
    const stdout = truncateUtf8(verify.stdout, OUTPUT_MAX_BYTES);
    const stderr = truncateUtf8(verify.stderr, OUTPUT_MAX_BYTES);
    const record: VerifyRecord = {
      version: RECORD_VERSION,
      ...verify,
      stdout,
      stderr,
      truncated: stdout !== verify.stdout || stderr !== verify.stderr,
    };
    writeJson(this.verifyFile(record.id), record);
    return record;
  }

  /**
   * @returns every verify record, by id
   */
  listVerifies(): VerifyRecord[] {
    return this.readAll<VerifyRecord>(this.verifyDir, "verify");
  }

  /**
   * Create `agents/<id>/` with its session, home and workspace directories and an empty log per
   * stream, then write `agent.json`.
   *
   * @param init the agent's identity and frozen policy
   * @returns the agent's paths
   */
  createAgent(init: AgentInit): AgentPaths {
    assertId(init.id, "agent id");
    const paths = this.agentPaths(init.id);
    for (const d of [paths.dir, paths.session, paths.home, paths.workspace]) {
      mkdirSync(d, { recursive: true });
    }
    // The logs exist from creation so the layout is the same before and after Pi has spoken.
    for (const f of [paths.events, paths.commands, paths.stderr]) {
      appendFileSync(f, "");
    }
    this.writeAgent({
      id: init.id,
      role: init.role,
      model: init.model,
      policy: init.policy,
      ask: init.ask ?? null,
      workspace: join("agents", encodeId(init.id), "workspace"),
      sessionFile: null,
      pid: null,
      status: "starting",
      turns: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, provisional: true },
      startedAt: init.startedAt ?? new Date().toISOString(),
      endedAt: null,
    });
    return paths;
  }

  /**
   * @param id an agent id
   * @returns its agent file, or null when the agent was never created
   */
  readAgent(id: string): AgentRecord | null {
    return readJson<AgentRecord>(this.agentPaths(id).file, `agent ${id}`);
  }

  /**
   * @param agent the whole agent file
   */
  writeAgent(agent: Omit<AgentRecord, "version">): void {
    assertId(agent.id, "agent id");
    writeJson(this.agentPaths(agent.id).file, { version: RECORD_VERSION, ...agent });
  }

  /**
   * Read, merge and rewrite one agent file.
   *
   * @param id an agent id
   * @param patch the fields to change
   * @returns the record as written
   * @throws RunDirError when the agent does not exist
   */
  updateAgent(id: string, patch: Partial<Omit<AgentRecord, "version" | "id">>): AgentRecord {
    const current = this.readAgent(id);
    if (current === null) throw new RunDirError(`${this.dir} has no agent ${id}`);
    const next = { ...current, ...patch, version: RECORD_VERSION };
    writeJson(this.agentPaths(id).file, next);
    return next;
  }

  /**
   * @returns every agent file, by id
   */
  listAgents(): AgentRecord[] {
    const ids = this.entries(this.agentsDir).sort();
    const out: AgentRecord[] = [];
    for (const name of ids) {
      const agent = readJson<AgentRecord>(
        join(this.agentsDir, name, "agent.json"),
        `agent ${name}`,
      );
      if (agent !== null) out.push(agent);
    }
    return out;
  }

  /**
   * @param id an agent id
   * @returns every event received from Pi, with its receive time
   */
  readAgentEvents(id: string): WireRecord[] {
    return readJsonl<WireRecord>(this.agentPaths(id).events);
  }

  /**
   * @param id an agent id
   * @returns every command sent to Pi, with its send time
   */
  readAgentCommands(id: string): WireRecord[] {
    return readJsonl<WireRecord>(this.agentPaths(id).commands);
  }

  /**
   * Append one line to `log.jsonl`.
   *
   * @param entry the level, message and any fields
   */
  appendLog(entry: LogRecord): void {
    appendFileSync(this.logFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * @returns every line of `log.jsonl`
   */
  readLog(): LogRecord[] {
    return readJsonl<LogRecord>(this.logFile);
  }

  /**
   * Append one line to `trace.jsonl` — the resource line first, then one finished span per line.
   *
   * @param line a resource object or a span
   */
  appendTrace(line: unknown): void {
    appendFileSync(this.traceFile, `${JSON.stringify(line)}\n`, "utf8");
  }

  /**
   * @returns every line of `trace.jsonl`, the resource line first
   */
  readTrace(): unknown[] {
    return readJsonl<unknown>(this.traceFile);
  }

  /**
   * Every record `orc show` prints, read in one pass.
   *
   * @returns the run, its config, and every step, escalation, verify and agent
   */
  report(): RunReport {
    return {
      run: this.readRun(),
      config: this.readConfig(),
      steps: this.listSteps(),
      escalations: this.listEscalations(),
      verifies: this.listVerifies(),
      agents: this.listAgents(),
    };
  }

  private entries(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return [];
      throw err;
    }
  }

  private readAll<T>(dir: string, what: string): T[] {
    const names = this.entries(dir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const out: T[] = [];
    for (const name of names) {
      const record = readJson<T>(join(dir, name), `${what} ${name}`);
      if (record !== null) out.push(record);
    }
    return out;
  }
}

/** What {@link createRun} needs; everything else in `run.json` starts at its zero value. */
export interface CreateRunOptions {
  runsDir: string;
  /** Defaults to {@link newRunId}. */
  id?: string;
  workflow: { name: string; file: string };
  input: unknown;
  workspace: { source: string; ref: string };
  /** The frozen config, its hash, and the hash inputs; `hash` also becomes `run.configHash`. */
  config: ConfigInit;
  versions: { pi: string; orc: string };
  pid?: number | null;
  startedAt?: string;
}

/**
 * Create a run directory: every directory in phase-1.md §4, `run.json` at status `running`,
 * `config.json`, and empty `trace.jsonl` and `log.jsonl`.
 *
 * @param opts the run's identity, input, workspace and frozen config
 * @returns the new run directory
 * @throws RunDirError when the id is malformed or already exists
 */
export function createRun(opts: CreateRunOptions): RunDir {
  const id = opts.id ?? newRunId();
  if (!RUN_ID_PATTERN.test(id)) {
    throw new RunDirError(`run id ${JSON.stringify(id)} must match ${String(RUN_ID_PATTERN)}`);
  }
  const dir = new RunDir(join(resolve(opts.runsDir), id));
  try {
    mkdirSync(dir.dir, { recursive: false });
  } catch (err) {
    if (isErrno(err, "EEXIST")) throw new RunDirError(`run ${id} already exists at ${dir.dir}`);
    if (!isErrno(err, "ENOENT")) throw err;
    mkdirSync(resolve(opts.runsDir), { recursive: true });
    mkdirSync(dir.dir, { recursive: false });
  }
  for (const d of [dir.stepsDir, dir.escalationsDir, dir.verifyDir, dir.agentsDir]) {
    mkdirSync(d, { recursive: true });
  }
  for (const f of [dir.traceFile, dir.logFile]) appendFileSync(f, "");
  dir.writeConfig(opts.config);
  dir.writeRun({
    id,
    workflow: opts.workflow,
    input: opts.input,
    workspace: opts.workspace,
    configHash: opts.config.hash,
    status: "running",
    startedAt: opts.startedAt ?? new Date().toISOString(),
    endedAt: null,
    result: null,
    error: null,
    turns: 0,
    pid: opts.pid === undefined ? process.pid : opts.pid,
    pi: { version: opts.versions.pi },
    orc: { version: opts.versions.orc },
  });
  return dir;
}

/**
 * Open an existing run directory.
 *
 * @param dir the run directory
 * @returns it, after checking `run.json` reads
 * @throws RunDirError when it is not a run directory
 */
export function openRun(dir: string): RunDir {
  const run = new RunDir(dir);
  run.readRun();
  return run;
}

/**
 * Every run under a runs directory, newest first — run ids sort by time (phase-1.md §2.11).
 *
 * @param runsDir where run directories live
 * @returns one summary per directory that has a readable `run.json`
 */
export function listRuns(runsDir: string): RunSummary[] {
  let names: string[];
  try {
    names = readdirSync(resolve(runsDir));
  } catch (err) {
    if (isErrno(err, "ENOENT")) return [];
    throw err;
  }
  const out: RunSummary[] = [];
  for (const name of names.sort().reverse()) {
    const dir = new RunDir(join(resolve(runsDir), name));
    const run = readJson<RunRecord>(dir.runFile, "run.json");
    if (run !== null) out.push({ id: dir.id, dir: dir.dir, run });
  }
  return out;
}

/**
 * The most recent run, which is what `orc show` defaults to.
 *
 * @param runsDir where run directories live
 * @returns its summary, or null when there are none
 */
export function latestRun(runsDir: string): RunSummary | null {
  return listRuns(runsDir)[0] ?? null;
}
