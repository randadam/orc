import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PiProcess, piBin } from "../src/pi-process.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * The real invocation, without a model call.
 *
 * `pi --mode rpc` answers `get_state` with no API key (phase 0, spike 00), so this checks the
 * spawn line, the private HOME and the log files against Pi itself and still spends nothing.
 */
describe("PiProcess against the real pi binary", () => {
  it("resolves the CLI bundle off the package entry", () => {
    expect(piBin()).toMatch(/dist[/\\]bundle[/\\]cli\.js$/);
  });

  it("becomes ready on a keyless get_state round-trip", async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-spawn-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "home"), { recursive: true });
    const pi = await PiProcess.start({
      agentDir,
      workspace: root,
      home: join(agentDir, "home"),
      agentFile: join(agentDir, "agent.json"),
      model: "claude-haiku-4-5",
      sessionDir: join(agentDir, "session"),
      env: { ANTHROPIC_API_KEY: "" },
      timeoutMs: 60_000,
    });
    try {
      const state = pi.ofType("response")[0];
      expect(state?.success, pi.diagnostics()).toBe(true);
      const data = state?.data as { model?: { id?: string } } | undefined;
      expect(data?.model?.id).toBe("claude-haiku-4-5");
    } finally {
      await pi.stop();
    }

    const events = readFileSync(join(agentDir, "events.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(events[0] ?? "{}")).toMatchObject({ event: { type: "response" } });
    const commands = readFileSync(join(agentDir, "commands.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(commands[0] ?? "{}")).toMatchObject({ command: { type: "get_state" } });
  }, 60_000);
});
