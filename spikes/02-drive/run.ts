import { readFileSync } from "node:fs";
import { Checks } from "../lib/check.ts";
import { requireKey } from "../lib/env.ts";
import { modelFailureLine, report } from "../lib/finding.ts";
import { Pi } from "../lib/rpc.ts";
import { cleanupTmp, tmp } from "../lib/tmp.ts";

requireKey("02-drive");

const home = tmp("home");
const work = tmp("work");
const sessionDir = tmp("sessions");
const MODEL = ["--provider", "anthropic", "--model", "claude-haiku-4-5"];

function start(extraArgs: string[]): Pi {
  return new Pi({
    home,
    cwd: work,
    args: ["--session-dir", sessionDir, ...MODEL, ...extraArgs],
    timeoutMs: 120_000,
  });
}

interface State {
  sessionFile?: string;
  sessionId?: string;
  messageCount?: number;
}

async function state(pi: Pi): Promise<State> {
  const res = await pi.call({ type: "get_state" }, 30_000);
  return (res.data ?? {}) as State;
}

/** Assistant entries in a session file — the evidence that the aborted turn was persisted. */
function assistantEntries(path: string): number {
  let count = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
    if (entry.type === "message" && entry.message?.role === "assistant") count++;
  }
  return count;
}

/** Wait for the nth tool call, or for the turn to end first — which would leave nothing to abort. */
async function abortable(n: number, timeoutMs: number): Promise<{ starts: number; ended: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const starts = pi.ofType("tool_execution_start").length;
    const ended = pi.ofType("agent_end").length > 0;
    if (starts >= n || ended || Date.now() > deadline) return { starts, ended };
    await new Promise((r) => setTimeout(r, 25));
  }
}

const checks = new Checks();
let abortMs = -1;
let resumeVia = "neither";
let contextSurvives = false;
let modelError: string | undefined;
let pi = start([]);

try {
  await pi.call(
    {
      type: "prompt",
      message:
        "Using the bash tool, run `sleep 2` ten separate times — ten separate bash tool " +
        "calls, one sleep each, reporting after each. Do not combine them into one command.",
    },
    30_000,
  );

  await pi.awaitCount("message_end", 3, 60_000);
  modelError = pi.modelErrors()[0];
  checks.ok(`every model call succeeded${modelError ? ` — ${modelError}` : ""}`, modelError === undefined);
  if (modelError) throw new Error(modelError);

  const { starts, ended } = await abortable(2, 60_000);
  checks.ok(`the agent got at least one tool call away (${starts} started)`, starts >= 1);
  checks.ok("the turn was still running when the abort was sent", !ended);
  if (ended) {
    throw new Error(
      `the turn finished after ${starts} tool call(s) before it could be aborted — ` +
        "there was nothing to abort, so this run says nothing about abort",
    );
  }

  const from = pi.mark();
  const t0 = Date.now();
  await pi.call({ type: "abort" }, 60_000);
  await pi.await((r) => r.type === "agent_end", 30_000, from);
  abortMs = Date.now() - t0;

  const total = pi.ofType("tool_execution_start").length;
  checks.ok(`agent_end within 10s of abort (${(abortMs / 1000).toFixed(1)}s)`, abortMs <= 10_000);
  checks.ok(`the abort cut the run short (${total} of 10 sleeps started)`, total < 10);

  const before = await state(pi);
  const sessionFile = before.sessionFile;
  if (!sessionFile) throw new Error(`get_state carried no sessionFile: ${JSON.stringify(before)}`);
  checks.ok(
    "the session file holds at least one assistant entry",
    assistantEntries(sessionFile) >= 1,
  );
  await pi.close();

  // Step 4: the flag first, because whether --session is honoured under --mode rpc is the question.
  pi = start(["--session", sessionFile]);
  let after = await state(pi);
  if (after.sessionId === before.sessionId && (after.messageCount ?? 0) > 0) {
    resumeVia = "startup flag";
  } else {
    await pi.close();
    pi = start([]);
    const switched = await pi.call({ type: "switch_session", sessionPath: sessionFile }, 30_000);
    const cancelled = (switched.data as { cancelled?: boolean } | undefined)?.cancelled;
    after = await state(pi);
    if (cancelled !== true && (after.messageCount ?? 0) > 0) resumeVia = "switch_session";
  }
  console.log(`  resumed via: ${resumeVia} (messageCount ${after.messageCount ?? 0})`);
  checks.ok("the session reopened with its prior messages", resumeVia !== "neither");

  const followUpFrom = pi.mark();
  await pi.call(
    {
      type: "prompt",
      message: "How many sleeps had completed before you were interrupted?",
    },
    30_000,
  );
  await pi.await((r) => r.type === "agent_settled", 120_000, followUpFrom);
  const last = await pi.call({ type: "get_last_assistant_text" }, 30_000);
  const text = ((last.data ?? {}) as { text?: string | null }).text ?? "";
  contextSurvives = checks.ok("the follow-up turn produced a non-empty answer", text.length > 0);
  console.log(`  answer (check by eye that it refers to the interrupted work):\n    ${text.trim()}`);
} catch (err) {
  console.log(`\n${(err as Error).message}\n`);
  checks.ok(`the spike ran to completion — ${(err as Error).message.split("\n")[0]}`, false);
} finally {
  await pi.close();
  cleanupTmp();
}

report({
  spike: "02-drive",
  pass: checks.passed,
  line: modelError
    ? modelFailureLine("DRIVE", modelError)
    : `DRIVE: ${checks.passed ? "pass" : "fail"} — abort→agent_end in ${(abortMs / 1000).toFixed(1)}s; ` +
      `resume via ${resumeVia}; context survives: ${contextSurvives ? "yes" : "no"}`,
  script: "spikes/02-drive/run.ts",
});
