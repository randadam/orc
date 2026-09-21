import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PiProcess, PiTimeoutError, type PiRecord } from "../src/pi-process.js";
import { fakePiEnv, fakePiPath, type FakeScenario } from "./fake-pi.js";

const started: PiProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const pi of started.splice(0)) await pi.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(scenario: FakeScenario, timeoutMs = 5_000): Promise<PiProcess> {
  const root = mkdtempSync(join(tmpdir(), "orc-pi-"));
  roots.push(root);
  const pi = await PiProcess.start({
    agentDir: join(root, "agent"),
    workspace: root,
    home: join(root, "home"),
    agentFile: join(root, "agent.json"),
    model: "claude-haiku-4-5",
    bin: fakePiPath(),
    env: fakePiEnv(join(root, "fake"), scenario),
    timeoutMs,
  });
  started.push(pi);
  return pi;
}

describe("PiProcess", () => {
  it("is ready only after a get_state round-trip", async () => {
    const pi = await start({ state: { sessionId: "s-1", messageCount: 0 } });
    const state = pi.ofType("response")[0];
    expect(state?.success).toBe(true);
    expect((state?.data as { sessionId?: string }).sessionId).toBe("s-1");
  });

  it("drives a prompt through to agent_end", async () => {
    const pi = await start({
      prompts: [
        [
          { emit: { type: "turn_start", turnIndex: 0 } },
          { afterMs: 5, emit: { type: "turn_end", turnIndex: 0 } },
          { emit: { type: "agent_end" } },
        ],
      ],
    });
    const from = pi.mark();
    const response = await pi.call({ type: "prompt", message: "hello" });
    expect(response.success).toBe(true);
    await pi.awaitEvent("agent_end", undefined, 5_000, from);
    expect(pi.ofType("turn_start")).toHaveLength(1);
  });

  it("keeps CRLF framing and U+2028 inside a string", async () => {
    const pi = await start({
      prompts: [[{ raw: `{"type":"note","text":"a\u2028b"}\r\n`, emit: { type: "agent_end" } }]],
    });
    const from = pi.mark();
    await pi.call({ type: "prompt", message: "hello" });
    const note = await pi.awaitEvent("note", undefined, 5_000, from);
    expect(note.text).toBe("a\u2028b");
    await pi.awaitEvent("agent_end", undefined, 5_000, from);
  });

  it("cuts a turn short on abort", async () => {
    const pi = await start({
      prompts: [
        [
          { emit: { type: "turn_start", turnIndex: 0 } },
          { afterMs: 30_000, emit: { type: "tool_execution_end" } },
          { emit: { type: "agent_end" } },
        ],
      ],
      onAbort: [{ type: "agent_end" }],
    });
    const from = pi.mark();
    await pi.call({ type: "prompt", message: "sleep" });
    await pi.awaitEvent("turn_start", undefined, 5_000, from);

    const t0 = Date.now();
    await pi.abort();
    await pi.awaitEvent("agent_end", undefined, 5_000, from);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(pi.ofType("tool_execution_end")).toHaveLength(0);
  });

  it("returns from an abort on a settled session without any event", async () => {
    const pi = await start({ prompts: [[{ emit: { type: "agent_end" } }]] });
    const from = pi.mark();
    await pi.call({ type: "prompt", message: "hello" });
    await pi.awaitEvent("agent_end", undefined, 5_000, from);

    const before = pi.records.filter((r) => r.type !== "response").length;
    await pi.abort();
    expect(pi.records.filter((r) => r.type !== "response").length).toBe(before);
  });

  it("rejects when the awaited event does not arrive in time", async () => {
    const pi = await start({ prompts: [[{ emit: { type: "agent_end" } }]] });
    const from = pi.mark();
    await pi.call({ type: "prompt", message: "hello" });
    await expect(pi.awaitEvent("agent_settled", undefined, 100, from)).rejects.toBeInstanceOf(
      PiTimeoutError,
    );
  });

  it("does not match an event received before the mark", async () => {
    const pi = await start({ prompts: [[{ emit: { type: "agent_end" } }]] });
    await pi.call({ type: "prompt", message: "first" });
    await pi.awaitEvent("agent_end", undefined, 5_000, 0);
    const from = pi.mark();
    await expect(pi.awaitEvent("agent_end", undefined, 100, from)).rejects.toBeInstanceOf(
      PiTimeoutError,
    );
  });

  it("delivers records to subscribers in arrival order", async () => {
    const pi = await start({
      prompts: [
        [
          { emit: { type: "turn_start", turnIndex: 0 } },
          { emit: { type: "turn_end", turnIndex: 0 } },
          { emit: { type: "agent_end" } },
        ],
      ],
    });
    const seen: string[] = [];
    const off = pi.on("*", (record) => seen.push(record.type));
    const from = pi.mark();
    await pi.call({ type: "prompt", message: "hello" });
    await pi.awaitEvent("agent_end", undefined, 5_000, from);
    off();
    expect(seen).toEqual(["response", "turn_start", "turn_end", "agent_end"]);
  });

  it("writes files into the workspace the turn touched", async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-pi-"));
    roots.push(root);
    const pi = await PiProcess.start({
      agentDir: join(root, "agent"),
      workspace: root,
      home: join(root, "home"),
      agentFile: join(root, "agent.json"),
      model: "claude-haiku-4-5",
      bin: fakePiPath(),
      env: fakePiEnv(join(root, "fake"), {
        prompts: [
          [
            { write: { path: "src/added.txt", content: "made\n" } },
            { emit: { type: "agent_end" } },
          ],
        ],
      }),
      timeoutMs: 5_000,
    });
    started.push(pi);
    const from = pi.mark();
    await pi.call({ type: "prompt", message: "write it" });
    await pi.awaitEvent("agent_end", undefined, 5_000, from);
    expect(readFileSync(join(root, "src/added.txt"), "utf8")).toBe("made\n");
  });

  it("logs every record and every command, in order, with receive times", async () => {
    const root = mkdtempSync(join(tmpdir(), "orc-pi-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const pi = await PiProcess.start({
      agentDir,
      workspace: root,
      home: join(root, "home"),
      agentFile: join(root, "agent.json"),
      model: "claude-haiku-4-5",
      bin: fakePiPath(),
      env: fakePiEnv(join(root, "fake"), {
        prompts: [
          [{ emit: { type: "turn_start", turnIndex: 0 } }, { emit: { type: "agent_end" } }],
        ],
      }),
      timeoutMs: 5_000,
    });
    started.push(pi);
    const from = pi.mark();
    await pi.call({ type: "prompt", message: "hello" });
    await pi.awaitEvent("agent_end", undefined, 5_000, from);
    await pi.stop();

    const events = readJsonl(join(agentDir, "events.jsonl"));
    expect(events.map((line) => (line.event as PiRecord).type)).toEqual(
      pi.records.map((record) => record.type),
    );
    expect(events.every((line) => typeof line.t === "number")).toBe(true);

    const commands = readJsonl(join(agentDir, "commands.jsonl"));
    expect(commands.map((line) => (line.command as PiRecord).type)).toEqual([
      "get_state",
      "prompt",
      "abort",
    ]);
    expect(commands.every((line) => typeof (line.command as PiRecord).id === "string")).toBe(true);
  });

  it("stops a process that is mid-turn", async () => {
    const pi = await start({
      prompts: [[{ afterMs: 30_000, emit: { type: "agent_end" } }]],
    });
    await pi.call({ type: "prompt", message: "sleep" });
    await pi.stop();
    expect(pi.done).toBe(true);
  });
});

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
