import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Checks } from "../lib/check.ts";
import { requireKey } from "../lib/env.ts";
import { modelFailureLine, report } from "../lib/finding.ts";
import { Pi } from "../lib/rpc.ts";
import { cleanupTmp, tmp } from "../lib/tmp.ts";
import { VETO_REASON } from "./ext.ts";

requireKey("01-veto");

const here = dirname(fileURLToPath(import.meta.url));
const work = tmp("work");
const marker = join(work, "veto-ran");

const pi = new Pi({
  home: tmp("home"),
  cwd: work,
  args: [
    "--no-session",
    "--provider",
    "anthropic",
    "--model",
    "claude-haiku-4-5",
    "-e",
    join(here, "ext.ts"),
  ],
  timeoutMs: 120_000,
});

/** Prompt once and wait for the run to settle. `agent_end` can be followed by a retry. */
async function turn(message: string): Promise<void> {
  const from = pi.mark();
  const res = await pi.call({ type: "prompt", message }, 30_000);
  if (res.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(res)}`);
  await pi.await((r) => r.type === "agent_settled", 120_000, from);
}

function bashAttempted(): boolean {
  return pi.records.some((r) => r.type === "tool_execution_start" && r.toolName === "bash");
}

function textOf(content: unknown): string {
  const blocks = (content ?? []) as Array<{ type?: string; text?: string }>;
  return blocks.map((b) => b.text ?? "").join("\n");
}

/** Everything the model was shown as the result of a bash call. */
function bashResultText(): string {
  const parts: string[] = [];
  for (const r of pi.records) {
    if (r.type === "tool_execution_end" && r.toolName === "bash") {
      parts.push(textOf((r.result as { content?: unknown })?.content));
    }
    if (r.type === "turn_end") {
      const results = (r.toolResults ?? []) as Array<{ toolName?: string; content?: unknown }>;
      for (const tr of results) {
        if (tr.toolName === "bash") parts.push(textOf(tr.content));
      }
    }
  }
  return parts.join("\n");
}

const checks = new Checks();
let reasonReached = false;
let modelError: string | undefined;

try {
  await turn(`Run exactly this and nothing else: \`touch ${marker}\``);
  modelError = pi.modelErrors()[0];
  if (!modelError && !bashAttempted()) {
    console.log("  (no bash call yet — re-prompting once, more forcefully)");
    await turn(
      `Call the bash tool now with the command: touch ${marker}\n` +
        `Do not explain, do not ask, do not use any other tool. Just make the bash tool call.`,
    );
  }

  modelError = pi.modelErrors()[0];
  checks.ok(
    `every model call succeeded${modelError ? ` — ${modelError}` : ""}`,
    modelError === undefined,
  );

  const attempted = checks.ok("the model attempted a bash tool call", bashAttempted());
  checks.ok("the side effect never happened (no veto-ran file)", !existsSync(marker));
  reasonReached = checks.ok(
    "the veto reason reached the model in the tool result",
    bashResultText().includes(VETO_REASON),
  );
  if (!attempted) console.log("  (the veto was never exercised — the model declined to call bash)");
  console.log(`  tool result seen by the model: ${JSON.stringify(bashResultText().slice(0, 200))}`);
} catch (err) {
  checks.ok(`the spike ran to completion — ${(err as Error).message.split("\n")[0]}`, false);
} finally {
  await pi.close();
  cleanupTmp();
}

report({
  spike: "01-veto",
  pass: checks.passed,
  line: modelError
    ? modelFailureLine("VETO", modelError)
    : `VETO: ${checks.passed ? "pass" : "fail"} — {block:true} from tool_call prevents execution; ` +
      `reason reaches model: ${reasonReached ? "yes" : "no"}`,
  script: "spikes/01-veto/run.ts",
});
