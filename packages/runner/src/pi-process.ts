import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonlDecoder } from "./framing.js";

/**
 * The Pi CLI entry point.
 *
 * The package exports only ESM conditions and no "./package.json", so `require.resolve` cannot
 * find it; the CLI is located off the main entry instead. Resolution is lazy so that tests
 * driving the fake never need Pi installed.
 *
 * @returns an absolute path to the CLI bundle, to be run with `node`
 */
export function piBin(): string {
  return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(
    /dist[/\\]index\.js$/,
    "dist/bundle/cli.js",
  );
}

/** One record off Pi's RPC stdout: an event, or a `response` correlated to a command by `id`. */
export type PiRecord = { type: string; [key: string]: unknown };

/** A command written to Pi's RPC stdin. `id` is assigned by {@link PiProcess.send} when absent. */
export type PiCommand = { type: string; [key: string]: unknown };

/** Rejection from {@link PiProcess.awaitEvent} and {@link PiProcess.call} when nothing matched in time. */
export class PiTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiTimeoutError";
  }
}

/** Rejection when the process ended before the awaited record arrived. */
export class PiExitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiExitError";
  }
}

export interface PiProcessOptions {
  /** `agents/<id>/`: `events.jsonl`, `commands.jsonl` and `pi.stderr.log` are written here. */
  agentDir: string;
  /** Pi's cwd — the agent's clone. */
  workspace: string;
  /** Pi's HOME, private to this agent (phase-1.md §2.8). */
  home: string;
  /** Absolute path to `agent.json`, passed through as `ORC_AGENT_FILE`. */
  agentFile: string;
  model: string;
  provider?: string;
  /** Absolute path to the `@orc/pi` entry, passed as `-e`. */
  extension?: string;
  /** Pi's `--session-dir`; Pi names the file inside it. */
  sessionDir?: string;
  /** Appended after the options above. */
  extraArgs?: string[];
  /** Merged over the inherited environment, after HOME and ORC_AGENT_FILE. */
  env?: NodeJS.ProcessEnv;
  /** Default deadline for `awaitEvent`, `call` and `abort`. */
  timeoutMs?: number;
  /** The script `node` runs. Defaults to {@link piBin}; the test double substitutes here. */
  bin?: string;
}

/**
 * A Pi subprocess in `--mode rpc`, driven over LF-delimited JSONL.
 *
 * Every record Pi writes — events and the `response` to each command alike — is appended to
 * `events.jsonl` with its receive time before any handler sees it, and every command to
 * `commands.jsonl`, so the two files together are the raw material `orc trace` and phase 3's
 * replay read (phase-1.md §4.4).
 */
export class PiProcess {
  readonly records: PiRecord[] = [];
  /** `receivedAt[i]` is when `records[i]` was decoded — the only clock tool durations have. */
  readonly receivedAt: number[] = [];

  private readonly child: ChildProcess;
  private readonly decoder = new JsonlDecoder();
  private readonly handlers = new Set<(record: PiRecord) => void>();
  private readonly waiters = new Set<(record: PiRecord | undefined) => void>();
  private readonly timeoutMs: number;
  private readonly eventsFd: number;
  private readonly commandsFd: number;
  private readonly stderrFd: number;
  private readonly exit: Promise<void>;
  private logsOpen = true;
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private stderrTail = "";
  private seq = 0;

  private constructor(opts: PiProcessOptions) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    mkdirSync(opts.agentDir, { recursive: true });
    this.eventsFd = openSync(join(opts.agentDir, "events.jsonl"), "a");
    this.commandsFd = openSync(join(opts.agentDir, "commands.jsonl"), "a");
    this.stderrFd = openSync(join(opts.agentDir, "pi.stderr.log"), "a");

    const args = [opts.bin ?? piBin(), ...piArgs(opts)];
    this.child = spawn(process.execPath, args, {
      cwd: opts.workspace,
      env: {
        ...process.env,
        // PI_OFFLINE suppresses update checks and telemetry only; model calls still go out.
        PI_OFFLINE: "1",
        HOME: opts.home,
        ORC_AGENT_FILE: opts.agentFile,
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    // A child that dies mid-write makes stdin emit EPIPE; unhandled, that takes the runner down.
    this.child.stdin?.on("error", (err) => {
      this.stderrTail = `${this.stderrTail}\nstdin error: ${err.message}`;
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (this.logsOpen) writeSync(this.stderrFd, chunk);
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4000);
    });
    this.exit = new Promise<void>((resolve) => {
      this.child.on("exit", (code, signal) => {
        this.exited = { code, signal };
        for (const waiter of [...this.waiters]) waiter(undefined);
        resolve();
      });
      this.child.on("error", (err) => {
        this.stderrTail = `${this.stderrTail}\nspawn error: ${err.message}`;
        this.exited ??= { code: null, signal: null };
        for (const waiter of [...this.waiters]) waiter(undefined);
        resolve();
      });
    });
  }

  /**
   * Spawn Pi and wait until it answers, so a caller never sends a prompt into a process that is
   * still starting.
   *
   * @returns the process, after one `get_state` round-trip
   */
  static async start(opts: PiProcessOptions): Promise<PiProcess> {
    const pi = new PiProcess(opts);
    try {
      await pi.call({ type: "get_state" }, opts.timeoutMs ?? 60_000);
    } catch (err) {
      await pi.stop();
      throw err;
    }
    return pi;
  }

  /** Whether the process has exited. */
  get done(): boolean {
    return this.exited !== undefined;
  }

  /** The end of the record log, to pass as `from` so an earlier match is not reused. */
  mark(): number {
    return this.records.length;
  }

  /**
   * Write one command to Pi's stdin and log it.
   *
   * @returns the `id` the command was tagged with, which its `response` carries back
   */
  send(command: PiCommand): string {
    if (this.exited) throw new PiExitError(`pi has exited; cannot send ${command.type}`);
    const id = typeof command.id === "string" ? command.id : `orc-${++this.seq}`;
    const tagged = { ...command, id };
    if (this.logsOpen) {
      writeSync(this.commandsFd, `${JSON.stringify({ t: Date.now(), command: tagged })}\n`);
    }
    this.child.stdin?.write(`${JSON.stringify(tagged)}\n`);
    return id;
  }

  /** Send a command and resolve with its correlated `response` record. */
  async call(command: PiCommand, timeoutMs?: number): Promise<PiRecord> {
    const from = this.mark();
    const id = this.send(command);
    return this.awaitRecord(
      (r) => r.type === "response" && r.id === id,
      `response to ${command.type}`,
      timeoutMs ?? this.timeoutMs,
      from,
    );
  }

  /**
   * Resolve with the first event of `type` matching `predicate`.
   *
   * @param from a {@link mark} taken before the command that should produce it; defaults to 0,
   *   which will match an event already received
   */
  async awaitEvent(
    type: string,
    predicate?: (event: PiRecord) => boolean,
    timeoutMs?: number,
    from = 0,
  ): Promise<PiRecord> {
    return this.awaitRecord(
      (r) => r.type === type && (predicate?.(r) ?? true),
      type,
      timeoutMs ?? this.timeoutMs,
      from,
    );
  }

  /**
   * Subscribe to records as they arrive.
   *
   * @param type an event type, or `"*"` for every record
   * @returns an unsubscribe function
   */
  on(type: string, handler: (record: PiRecord) => void): () => void {
    const wrapped = (record: PiRecord) => {
      if (type === "*" || record.type === type) handler(record);
    };
    this.handlers.add(wrapped);
    return () => this.handlers.delete(wrapped);
  }

  /** Every record of one type, in arrival order. */
  ofType(type: string): PiRecord[] {
    return this.records.filter((r) => r.type === type);
  }

  /**
   * Cut the current turn short.
   *
   * Waits on the command response, not on `agent_end`: an abort on an already-settled session
   * emits no events at all (spikes/FINDINGS.md, carry-forward 2).
   */
  async abort(timeoutMs?: number): Promise<void> {
    if (this.exited) return;
    await this.call({ type: "abort" }, timeoutMs ?? this.timeoutMs);
  }

  /** Abort, then SIGTERM, then SIGKILL after 5s. Closes the log files. */
  async stop(): Promise<void> {
    if (!this.exited) {
      try {
        await this.abort(5_000);
      } catch {
        // A process that will not answer an abort is killed below.
      }
      this.child.stdin?.end();
      this.child.kill("SIGTERM");
      await this.waitExit(5_000);
      if (!this.exited) {
        this.child.kill("SIGKILL");
        await this.waitExit(5_000);
      }
    }
    if (this.logsOpen) {
      this.logsOpen = false;
      closeSync(this.eventsFd);
      closeSync(this.commandsFd);
      closeSync(this.stderrFd);
    }
  }

  /** Exit status, received record types and the tail of stderr, for an error message. */
  diagnostics(): string {
    const types = this.records.map((r) => r.type).join(", ");
    return [
      `exit=${JSON.stringify(this.exited ?? null)}`,
      `records: [${types}]`,
      `stderr: ${this.stderrTail.trim()}`,
    ].join("\n");
  }

  private onStdout(chunk: Buffer): void {
    for (const decoded of this.decoder.push(chunk)) {
      const record = decoded as PiRecord;
      const t = Date.now();
      // Logged before dispatch so the file is complete even if a handler throws.
      if (this.logsOpen) writeSync(this.eventsFd, `${JSON.stringify({ t, event: record })}\n`);
      this.records.push(record);
      this.receivedAt.push(t);
      for (const waiter of [...this.waiters]) waiter(record);
      for (const handler of [...this.handlers]) handler(record);
    }
  }

  private awaitRecord(
    match: (record: PiRecord) => boolean,
    what: string,
    timeoutMs: number,
    from: number,
  ): Promise<PiRecord> {
    for (let i = from; i < this.records.length; i++) {
      const record = this.records[i];
      if (record && match(record)) return Promise.resolve(record);
    }
    if (this.exited) {
      return Promise.reject(
        new PiExitError(`pi already exited waiting for ${what}\n${this.diagnostics()}`),
      );
    }
    return new Promise((resolve, reject) => {
      const settle = (err?: Error, record?: PiRecord) => {
        this.waiters.delete(waiter);
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(record as PiRecord);
      };
      const timer = setTimeout(
        () =>
          settle(
            new PiTimeoutError(
              `timed out after ${timeoutMs}ms waiting for ${what}\n${this.diagnostics()}`,
            ),
          ),
        timeoutMs,
      );
      const waiter = (record: PiRecord | undefined) => {
        if (record === undefined) {
          settle(new PiExitError(`pi exited waiting for ${what}\n${this.diagnostics()}`));
        } else if (match(record)) {
          settle(undefined, record);
        }
      };
      this.waiters.add(waiter);
    });
  }

  private async waitExit(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exit,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

/** The RPC invocation of phase-1.md §6.1, in the order the doc gives it. */
function piArgs(opts: PiProcessOptions): string[] {
  const args = ["--mode", "rpc", "--provider", opts.provider ?? "anthropic", "--model", opts.model];
  if (opts.sessionDir) args.push("--session-dir", opts.sessionDir);
  if (opts.extension) args.push("-e", opts.extension);
  return [...args, ...(opts.extraArgs ?? [])];
}
