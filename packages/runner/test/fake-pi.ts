import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One record the fake writes to stdout. Shapes are Pi's; nothing here is invented. */
export type FakeRecord = { type: string; [key: string]: unknown };

export interface FakeStep {
  /** Delay before this step, in milliseconds. */
  afterMs?: number;
  /** A record to emit, framed as one JSONL line. */
  emit?: FakeRecord;
  /** Bytes written to stdout verbatim, for framing cases a JSON record cannot express. */
  raw?: string;
  /** A file written into the fake's cwd, so `diff()` has something to read. */
  write?: { path: string; content: string };
}

export interface FakeScenario {
  /** The `data` of every `get_state` response. */
  state?: Record<string, unknown>;
  /** One script per `prompt` received, in order; the last repeats for any further prompts. */
  prompts?: FakeStep[][];
  /** Emitted when an `abort` arrives with a prompt in flight. Defaults to one `agent_end`. */
  onAbort?: FakeRecord[];
}

/** Absolute path to this file, to pass as {@link PiProcessOptions.bin}. */
export function fakePiPath(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * Write a scenario where `PiProcess` can spawn against it.
 *
 * @returns the env to merge into the spawn, naming the scenario file
 */
export function fakePiEnv(dir: string, scenario: FakeScenario): NodeJS.ProcessEnv {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "scenario.json");
  writeFileSync(path, JSON.stringify(scenario), "utf8");
  return { ORC_FAKE_PI_SCENARIO: path };
}

const DEFAULT_ABORT: FakeRecord[] = [{ type: "agent_end" }];

function write(line: string): void {
  process.stdout.write(line);
}

function emit(record: FakeRecord): void {
  write(`${JSON.stringify(record)}\n`);
}

/** Wakes the in-flight `sleep` early, so an abort does not wait out the scripted delay. */
let wake: (() => void) | undefined;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = undefined;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
  });
}

async function main(): Promise<void> {
  const scenarioPath = process.env.ORC_FAKE_PI_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write("fake-pi: ORC_FAKE_PI_SCENARIO is not set\n");
    process.exit(2);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as FakeScenario;
  const prompts = scenario.prompts ?? [];

  let promptIndex = 0;
  let inFlight = false;
  let aborted = false;

  async function runPrompt(): Promise<void> {
    const steps = prompts[Math.min(promptIndex, prompts.length - 1)] ?? [];
    promptIndex += 1;
    inFlight = true;
    aborted = false;
    for (const step of steps) {
      if (step.afterMs) await sleep(step.afterMs);
      if (aborted) break;
      if (step.write) {
        const target = resolve(process.cwd(), step.write.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, step.write.content, "utf8");
      }
      if (step.raw !== undefined) write(step.raw);
      if (step.emit) emit(step.emit);
    }
    if (aborted) for (const record of scenario.onAbort ?? DEFAULT_ABORT) emit(record);
    inFlight = false;
  }

  function handle(command: { type?: string; id?: string }): void {
    const id = command.id;
    switch (command.type) {
      case "get_state":
        emit({ type: "response", id, success: true, data: scenario.state ?? {} });
        return;
      case "prompt":
        emit({ type: "response", id, success: true });
        void runPrompt();
        return;
      case "abort":
        // An abort on a settled session emits nothing at all — only the response comes back.
        if (inFlight) {
          aborted = true;
          wake?.();
        }
        emit({ type: "response", id, success: true });
        return;
      default:
        emit({ type: "response", id, success: false, error: `unknown command: ${command.type}` });
    }
  }

  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const lf = buf.indexOf("\n");
      if (lf === -1) break;
      const line = buf.slice(0, lf).replace(/\r$/, "");
      buf = buf.slice(lf + 1);
      if (line.length > 0) handle(JSON.parse(line) as { type?: string; id?: string });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
