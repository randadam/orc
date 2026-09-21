import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { anthropicKey } from "./env.ts";
import { JsonlDecoder } from "./framing.ts";

/**
 * The Pi CLI entry point.
 *
 * The package exports only ESM conditions and no "./package.json", so require.resolve cannot
 * find it; the CLI is located off the main entry instead.
 */
export const PI_BIN = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(
  /dist[/\\]index\.js$/,
  "dist/bundle/cli.js",
);

/** One record off Pi's RPC stdout: an event, or a `response` to a command. */
export type PiRecord = { type: string; [key: string]: unknown };

export interface PiOptions {
  /** Throwaway HOME. Spikes never touch the real `~/.pi/agent/`. */
  home: string;
  cwd?: string;
  args?: string[];
  timeoutMs?: number;
}

/** A Pi subprocess in `--mode rpc`, driven over LF-delimited JSONL. */
export class Pi {
  readonly records: PiRecord[] = [];
  /** `receivedAt[i]` is when `records[i]` was decoded — the only clock tool durations have. */
  readonly receivedAt: number[] = [];
  private readonly child: ChildProcess;
  private readonly decoder = new JsonlDecoder();
  private readonly waiters = new Set<(r: PiRecord) => void>();
  private readonly timeoutMs: number;
  private stderr = "";
  private exited?: { code: number | null; signal: NodeJS.Signals | null };
  private seq = 0;

  constructor(opts: PiOptions) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    const key = anthropicKey();
    this.child = spawn(process.execPath, [PI_BIN, "--mode", "rpc", ...(opts.args ?? [])], {
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        // PI_OFFLINE suppresses update checks and telemetry only; model calls still go out.
        PI_OFFLINE: "1",
        ...(key ? { ANTHROPIC_API_KEY: key } : {}),
        HOME: opts.home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      for (const record of this.decoder.push(chunk)) {
        const r = record as PiRecord;
        this.records.push(r);
        this.receivedAt.push(Date.now());
        for (const w of [...this.waiters]) w(r);
      }
    });
    this.child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", (code, signal) => {
      this.exited = { code, signal };
      for (const w of [...this.waiters]) w({ type: "__exit__" });
    });
  }

  /** Send one command. Returns the `id` it was tagged with. */
  send(command: Record<string, unknown>): string {
    const id = (command.id as string) ?? `req-${++this.seq}`;
    this.child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
    return id;
  }

  /** The current end of the record log, to pass as `from` so an earlier match is not reused. */
  mark(): number {
    return this.records.length;
  }

  /** Resolve with the first record at or after `from` matching `match`; reject on timeout or exit. */
  await(match: (r: PiRecord) => boolean, timeoutMs = this.timeoutMs, from = 0): Promise<PiRecord> {
    for (let i = from; i < this.records.length; i++) {
      if (match(this.records[i]!)) return Promise.resolve(this.records[i]!);
    }
    // A process that already exited will never emit again; waiting out the timeout only hides why.
    if (this.exited) {
      return Promise.reject(new Error(`pi already exited\n${this.diagnostics()}`));
    }
    return new Promise((resolve, reject) => {
      const done = (err?: Error, r?: PiRecord) => {
        this.waiters.delete(waiter);
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(r!);
      };
      const timer = setTimeout(
        () => done(new Error(`timed out after ${timeoutMs}ms\n${this.diagnostics()}`)),
        timeoutMs,
      );
      const waiter = (r: PiRecord) => {
        if (match(r)) done(undefined, r);
        else if (r.type === "__exit__") done(new Error(`pi exited early\n${this.diagnostics()}`));
      };
      this.waiters.add(waiter);
    });
  }

  /** Call `fn` for every record from now on. Returns an unsubscribe function. */
  onRecord(fn: (record: PiRecord) => void): () => void {
    const waiter = (r: PiRecord) => {
      if (r.type !== "__exit__") fn(r);
    };
    this.waiters.add(waiter);
    return () => this.waiters.delete(waiter);
  }

  /** Send a command and wait for its correlated `response` record. */
  async call(command: Record<string, unknown>, timeoutMs?: number): Promise<PiRecord> {
    const id = this.send(command);
    return this.await((r) => r.type === "response" && r.id === id, timeoutMs);
  }

  /**
   * Errors from assistant messages that never completed — an unusable key looks exactly like a
   * model that declined, so every model-backed spike checks this before reading a verdict.
   */
  modelErrors(): string[] {
    const errors: string[] = [];
    for (const r of this.ofType("message_end")) {
      const m = r.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
      if (m?.role === "assistant" && m.stopReason === "error") {
        errors.push(m.errorMessage ?? "assistant message ended with stopReason error");
      }
    }
    return errors;
  }

  /** Every record of one type, in arrival order. */
  ofType(type: string): PiRecord[] {
    return this.records.filter((r) => r.type === type);
  }

  /** Wait until at least `n` records of `type` have arrived. Returns how many there are. */
  async awaitCount(type: string, n: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.ofType(type).length < n && !this.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.ofType(type).length;
  }

  diagnostics(): string {
    const types = this.records.map((r) => r.type).join(", ");
    return `exit=${JSON.stringify(this.exited)}\nrecords: [${types}]\nstderr: ${this.stderr.trim()}`;
  }

  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin!.end();
    this.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 50));
    this.child.kill("SIGKILL");
  }
}
