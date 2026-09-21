import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireKey } from "../lib/env.ts";
import { modelFailureLine, report } from "../lib/finding.ts";
import { PI_BIN, Pi } from "../lib/rpc.ts";
import { cleanupTmp, tmp } from "../lib/tmp.ts";

requireKey("04-attach");

const spikesDir = dirname(dirname(fileURLToPath(import.meta.url)));
const home = tmp("home");
const work = tmp("work");
const sessionDir = tmp("sessions");
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, answers: string[]): Promise<string> {
  for (;;) {
    const got = (await rl.question(`\n${question} [${answers.join("/")}] `)).trim().toLowerCase();
    if (answers.includes(got)) return got;
    console.log(`  answer one of: ${answers.join(", ")}`);
  }
}

async function pause(message: string): Promise<void> {
  await rl.question(`\n${message} `);
}

/** Session entries that parse, so a truncated or interleaved file is detectable. */
function entries(path: string): { count: number; intact: boolean } {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) JSON.parse(line);
    return { count: lines.length, intact: true };
  } catch {
    return { count: -1, intact: false };
  }
}

const pi = new Pi({
  home,
  cwd: work,
  args: ["--session-dir", sessionDir, "--provider", "anthropic", "--model", "claude-haiku-4-5"],
  timeoutMs: 120_000,
});

let observed = false;
let modelError: string | undefined;
let verdict = "forked";
let sawPriorTurn = "n";
let rpcSawInput = "n";
let filesAfter = 0;

try {
  console.log("Seeding one turn so the attaching TUI has something to show...");
  await pi.call({ type: "prompt", message: "Reply with exactly: attach spike seed turn." }, 30_000);
  await pi.await((r) => r.type === "agent_settled", 120_000);

  modelError = pi.modelErrors()[0];
  if (modelError) throw new Error(`the seed turn failed: ${modelError}`);

  const before = ((await pi.call({ type: "get_state" }, 30_000)).data ?? {}) as {
    sessionFile?: string;
    messageCount?: number;
  };
  const sessionFile = before.sessionFile;
  if (!sessionFile) throw new Error("get_state carried no sessionFile");
  const seeded = entries(sessionFile);

  const attachScript = join(work, "attach.sh");
  writeFileSync(
    attachScript,
    `#!/usr/bin/env bash\nset -euo pipefail\n` +
      // Sourced rather than copied, so the key never lands in a temp file or the scrollback.
      `if [ -f "${spikesDir}/.env" ]; then set -a; . "${spikesDir}/.env"; set +a; fi\n` +
      `export ANTHROPIC_API_KEY="\${ANTHROPIC_API_KEY:-\${ANTHROPIC_KEY:-}}"\n` +
      `export HOME="${home}"\n` +
      `cd "${work}"\n` +
      `exec node "${PI_BIN}" --session "${sessionFile}" --session-dir "${sessionDir}" ` +
      `--provider anthropic --model claude-haiku-4-5\n`,
    { mode: 0o700 },
  );

  console.log(`\n  session file : ${sessionFile} (${seeded.count} entries)`);
  console.log(`  session dir  : ${sessionDir}`);
  console.log(`\n  In ANOTHER terminal, run:\n\n    bash ${attachScript}\n`);
  console.log("  This RPC process stays up and tails its events below. Watch them while you type");
  console.log("  in the TUI — anything appearing there is the RPC process seeing the TUI.\n");

  pi.onRecord((r) => console.log(`  [rpc event] ${r.type}`));

  sawPriorTurn = await ask(
    "(a) Did the TUI open the session and show the prior turn?",
    ["y", "n", "locked"],
  );
  await pause("(b) Now send a message in the TUI. Press enter here once it has replied.");
  rpcSawInput = await ask("(b) Did any event appear in the tail above while the TUI ran?", ["y", "n"]);

  const after = ((await pi.call({ type: "get_state" }, 30_000)).data ?? {}) as {
    messageCount?: number;
  };
  const grew = (after.messageCount ?? 0) > (before.messageCount ?? 0);
  console.log(
    `\n  (c) RPC messageCount ${before.messageCount ?? 0} → ${after.messageCount ?? 0}` +
      ` — the RPC process ${grew ? "DOES" : "does not"} see the TUI's message.`,
  );

  await pause("(d) Quit the TUI, then press enter here.");
  const files = readdirSync(sessionDir, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".jsonl"),
  );
  filesAfter = files.length;
  const original = entries(sessionFile);
  console.log(`\n  (d) ${filesAfter} session file(s): ${files.join(", ")}`);
  console.log(
    `      original: ${original.intact ? "parses" : "DOES NOT PARSE"}, ` +
      `${seeded.count} entries before, ${original.count} after`,
  );

  if (!original.intact) verdict = "corrupt";
  else if (rpcSawInput === "y" || grew) verdict = "shared";
  else if (sawPriorTurn === "locked") verdict = "locked";
  else verdict = "forked";

  observed = true;
  console.log(`\n  verdict: ${verdict}`);
  if (verdict !== "shared") {
    console.log("  Per phase-0.md §3.4: update D4's mechanism in docs/plan.md §8 and phases.md §3.");
  }
} catch (err) {
  console.log(`  the spike did not reach an observation: ${(err as Error).message.split("\n")[0]}`);
} finally {
  rl.close();
  await pi.close();
  cleanupTmp();
}

report({
  spike: "04-attach",
  // Observational: it records what happened. Only a failure to observe is a failure.
  pass: observed,
  line: modelError
    ? modelFailureLine("ATTACH", modelError)
    : observed
      ? `ATTACH: ${verdict} — TUI sees prior turn: ${sawPriorTurn === "y" ? "y" : "n"}; ` +
        `RPC sees TUI input: ${rpcSawInput}; files after: ${filesAfter}`
      : "ATTACH: fail — no verdict: the spike did not reach an observation",
  script: "spikes/04-attach/run.ts",
});
