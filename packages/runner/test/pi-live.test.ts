import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PiProcess } from "../src/pi-process.js";

/** Live checks run only under `ORC_LIVE=1`; CI never sets it, so `pnpm check` spends nothing. */
const live = process.env.ORC_LIVE === "1";

describe.skipIf(!live)("PiProcess against pi", () => {
  it("drives one Haiku turn to agent_settled", async () => {
    // Under ORC_LIVE a missing key is a failure, not a skip: the run was asked for.
    expect(process.env.ANTHROPIC_API_KEY ?? "").not.toBe("");

    const root = mkdtempSync(join(tmpdir(), "orc-live-"));
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "home"), { recursive: true });
    const pi = await PiProcess.start({
      agentDir,
      workspace: root,
      home: join(agentDir, "home"),
      agentFile: join(agentDir, "agent.json"),
      model: "claude-haiku-4-5",
      sessionDir: join(agentDir, "session"),
      timeoutMs: 120_000,
    });
    try {
      const from = pi.mark();
      await pi.call({ type: "prompt", message: "Reply with the single word: ready" }, 60_000);
      // agent_settled, not agent_end: agent_end is one low-level run and may be followed by a
      // retry, a compaction or a queued continuation (spikes/FINDINGS.md, carry-forward 1).
      await pi.awaitEvent("agent_settled", undefined, 120_000, from);

      const errors = pi
        .ofType("message_end")
        .map((record) => record.message as { role?: string; stopReason?: string } | undefined)
        .filter((message) => message?.role === "assistant" && message.stopReason === "error");
      expect(errors, pi.diagnostics()).toHaveLength(0);

      const last = await pi.call({ type: "get_last_assistant_text" }, 30_000);
      const text = ((last.data ?? {}) as { text?: string | null }).text ?? "";
      expect(text.length, pi.diagnostics()).toBeGreaterThan(0);
      expect(pi.ofType("turn_start").length).toBeGreaterThanOrEqual(1);
    } finally {
      await pi.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
