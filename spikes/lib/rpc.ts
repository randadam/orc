import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JsonlDecoder } from "./framing.ts";

// The package exports only ESM conditions and no "./package.json", so require.resolve cannot
// find it; the CLI is located off the main entry instead.
const PI_BIN = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(
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
  private readonly child: ChildProcess;
  private readonly decoder = new JsonlDecoder();
  private readonly waiters = new Set<(r: PiRecord) => void>();
  private readonly timeoutMs: number;
  private stderr = "";
  private exited?: { code: number | null; signal: NodeJS.Signals | null };
  private seq = 0;

  constructor(opts: PiOptions) {
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.child = spawn(process.execPath, [PI_BIN, "--mode", "rpc", ...(opts.args ?? [])], {
      cwd: opts.cwd ?? process.cwd(),
      // PI_OFFLINE suppresses update checks and telemetry only; model calls still go out.
      env: { ...process.env, HOME: opts.home, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout!.on("data", (chunk: Buffer) => {
      for (const record of this.decoder.push(chunk)) {
        const r = record as PiRecord;
        this.records.push(r);
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

  /** Resolve with the first record matching `match`, or reject on timeout or early exit. */
  await(match: (r: PiRecord) => boolean, timeoutMs = this.timeoutMs): Promise<PiRecord> {
    const seen = this.records.find(match);
    if (seen) return Promise.resolve(seen);
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

  /** Send a command and wait for its correlated `response` record. */
  async call(command: Record<string, unknown>, timeoutMs?: number): Promise<PiRecord> {
    const id = this.send(command);
    return this.await((r) => r.type === "response" && r.id === id, timeoutMs);
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
