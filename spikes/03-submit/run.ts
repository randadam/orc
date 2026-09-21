import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { Checks } from "../lib/check.ts";
import { requireKey } from "../lib/env.ts";
import { modelFailureLine, report } from "../lib/finding.ts";
import { Pi } from "../lib/rpc.ts";
import { cleanupTmp, tmp } from "../lib/tmp.ts";
import { submitSchema } from "./ext.ts";

requireKey("03-submit");

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = 5;
const PROMPT =
  "Assess the risk of deleting `/tmp`. Call `submit_result` with your assessment; " +
  "do not reply in prose.";

interface Attempt {
  valid: boolean;
  /** Whether a fresh assistant message started between the tool result and the end of the run. */
  followUp: boolean;
  ms: number;
  note: string;
  /** Set when the provider, not the model, is what failed. */
  error?: string;
}

function start(extraArgs: string[]): Pi {
  return new Pi({
    home: tmp("home"),
    cwd: tmp("work"),
    args: ["--no-session", "--provider", "anthropic", "--model", "claude-haiku-4-5", ...extraArgs],
    timeoutMs: 120_000,
  });
}

async function attempt(): Promise<Attempt> {
  const pi = start(["-e", join(here, "ext.ts")]);
  const t0 = Date.now();
  try {
    await pi.call({ type: "prompt", message: PROMPT }, 30_000);
    await pi.await((r) => r.type === "agent_settled", 120_000);
    const ms = Date.now() - t0;

    const error = pi.modelErrors()[0];
    if (error) return { valid: false, followUp: false, ms, note: error, error };

    const calls = pi.records
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.type === "tool_execution_end" && r.toolName === "submit_result");
    if (calls.length !== 1) {
      return { valid: false, followUp: false, ms, note: `${calls.length} submit_result calls` };
    }

    const args = pi.records.find(
      (r) => r.type === "tool_execution_start" && r.toolName === "submit_result",
    )?.args;
    const valid = Value.Check(submitSchema, args);

    const rest = pi.records.slice(calls[0]!.i + 1);
    const end = rest.findIndex((r) => r.type === "agent_end");
    const between = end === -1 ? rest : rest.slice(0, end);
    const followUp = between.some((r) => r.type === "message_start");

    return {
      valid,
      followUp,
      ms,
      note: valid ? "ok" : `args failed the schema: ${JSON.stringify(args)}`,
    };
  } finally {
    await pi.close();
  }
}

/** §3.3's fallback: ask for JSON in the final message and parse it, when the tool does not hold. */
async function fallback(): Promise<number> {
  let valid = 0;
  for (let i = 0; i < RUNS; i++) {
    const pi = start([]);
    try {
      await pi.call(
        {
          type: "prompt",
          message:
            "Assess the risk of deleting `/tmp`. Reply with only a JSON object matching " +
            `this schema and nothing else: ${JSON.stringify(submitSchema)}`,
        },
        30_000,
      );
      await pi.await((r) => r.type === "agent_settled", 120_000);
      const res = await pi.call({ type: "get_last_assistant_text" }, 30_000);
      const text = ((res.data ?? {}) as { text?: string | null }).text ?? "";
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      if (Value.Check(submitSchema, JSON.parse(json))) valid++;
    } catch {
      // A parse or transport failure is simply not a valid run.
    } finally {
      await pi.close();
    }
  }
  return valid;
}

const checks = new Checks();
const attempts: Attempt[] = [];
let median = 0;
let modelError: string | undefined;

try {
  for (let i = 0; i < RUNS; i++) {
    const a = await attempt();
    attempts.push(a);
    console.log(
      `  run ${i + 1}/${RUNS}: ${a.valid ? "valid" : "INVALID"}, ` +
        `follow-up ${a.followUp ? "yes" : "no"}, ${(a.ms / 1000).toFixed(1)}s — ${a.note}`,
    );
    // A provider failure will not fix itself over four more runs.
    if (a.error) break;
  }

  modelError = attempts.find((a) => a.error)?.error;
  checks.ok(`every model call succeeded${modelError ? ` — ${modelError}` : ""}`, modelError === undefined);

  const valid = attempts.filter((a) => a.valid).length;
  const sorted = attempts.map((a) => a.ms).sort((a, b) => a - b);
  median = sorted[Math.floor(sorted.length / 2)] ?? 0;

  checks.ok(`${valid}/${RUNS} runs made one schema-valid submit_result call`, valid === RUNS);
  checks.ok(
    "terminate:true skipped the follow-up assistant message",
    attempts.every((a) => !a.followUp),
  );

  if (valid < RUNS && modelError === undefined) {
    console.log("  not 5/5 — running the JSON-in-the-final-message fallback:");
    console.log(`  fallback: ${await fallback()}/${RUNS} parsed and validated`);
  }
} catch (err) {
  checks.ok(`the spike ran to completion — ${(err as Error).message.split("\n")[0]}`, false);
} finally {
  cleanupTmp();
}

const valid = attempts.filter((a) => a.valid).length;
report({
  spike: "03-submit",
  pass: checks.passed,
  line: modelError
    ? modelFailureLine("SUBMIT", modelError)
    : `SUBMIT: ${checks.passed ? "pass" : "fail"} — ${valid}/${RUNS} valid; ` +
      `terminate skips follow-up: ${attempts.length > 0 && attempts.every((a) => !a.followUp) ? "yes" : "no"}; ` +
      `median ${(median / 1000).toFixed(1)}s`,
  script: "spikes/03-submit/run.ts",
});
