import { Checks } from "../lib/check.ts";
import { JsonlDecoder } from "../lib/framing.ts";
import { Pi } from "../lib/rpc.ts";
import { report } from "../lib/finding.ts";
import { cleanupTmp, tmp } from "../lib/tmp.ts";

const checks = new Checks();
const check = (name: string, ok: boolean) => checks.ok(name, ok);

function framing(): void {
  console.log("framing:");

  const split = new JsonlDecoder();
  check("splits on LF", split.push(Buffer.from('{"a":1}\n{"a":2}\n')).length === 2);

  const crlf = new JsonlDecoder();
  const [rec] = crlf.push(Buffer.from('{"a":1}\r\n')) as Array<{ a: number }>;
  check("strips a trailing CR", rec?.a === 1);

  // The reason a generic line reader cannot be used: these are legal inside JSON strings.
  const sep = new JsonlDecoder();
  const withSeps = sep.push(Buffer.from('{"t":"a b c"}\n')) as Array<{ t: string }>;
  check("does not split on U+2028/U+2029", withSeps.length === 1 && withSeps[0]!.t.length === 5);

  const partial = new JsonlDecoder();
  const first = partial.push(Buffer.from('{"a":'));
  const second = partial.push(Buffer.from('1}\n'));
  check("holds a record split across chunks", first.length === 0 && second.length === 1);

  const utf8 = new JsonlDecoder();
  const bytes = Buffer.from('{"t":"é☃"}\n', "utf8");
  const a = utf8.push(bytes.subarray(0, 9));
  const b = utf8.push(bytes.subarray(9)) as Array<{ t: string }>;
  check("holds a multi-byte char split across chunks", a.length === 0 && b[0]?.t === "é☃");

  const blank = new JsonlDecoder();
  check("ignores blank records", blank.push(Buffer.from('\n{"a":1}\n')).length === 1);
}

async function roundTrip(): Promise<void> {
  console.log("rpc round-trip (no model call):");
  const pi = new Pi({
    home: tmp("home"),
    cwd: tmp("cwd"),
    args: ["--no-session", "--provider", "anthropic", "--model", "claude-haiku-4-5"],
    timeoutMs: 60_000,
  });
  try {
    const state = await pi.call({ type: "get_state" });
    check("get_state responds", state.success === true);
    const data = state.data as { model?: { id?: string }; sessionId?: string } | undefined;
    check("state carries the pinned model", data?.model?.id === "claude-haiku-4-5");
    check("state carries a sessionId", typeof data?.sessionId === "string");
  } finally {
    await pi.close();
  }
}

try {
  framing();
  await roundTrip();
} finally {
  cleanupTmp();
}

report({
  spike: "00-harness",
  pass: checks.passed,
  line:
    checks.passed
      ? "HARNESS: pass — LF-only framing holds across chunk, CRLF and U+2028/9 cases; pi --mode rpc answers get_state with no API key"
      : `HARNESS: fail — ${checks.failed.join("; ")}`,
  script: "spikes/00-harness/run.ts",
});
