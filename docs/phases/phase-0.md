# Phase 0 — spikes: is Pi the harness we think it is?

Detailed plan for [phases.md](../phases.md) §3. This is the execution authority for phase 0;
phases.md remains the order authority and [poc.md](../poc.md) the scope authority.

**Nothing from this phase is kept as code.** Six throwaway scripts, six one-line findings, one
kill criterion. If spike 1 fails, stop and redesign the tool-policy model before any package exists.

---

## 1. Assumptions (pending answers to [phases.md](../phases.md) §15)

| Question | Assumed here | If the answer differs |
| --- | --- | --- |
| Q5 — Pi version | **`@earendil-works/pi-coding-agent@0.85.1`**, latest on npm as of 2026-09-18. Pinned exactly; every later phase pins the same. | Re-run all six spikes against the chosen version. They take under an hour. |
| Q6 — environment | Node 22 (22.22 verified here), pnpm, `tsx`. **No Docker needed** — phase 0 drives Pi as a bare subprocess. | Nothing in this phase changes. |
| Q7 — credential | `ANTHROPIC_API_KEY` in the environment, direct API. Model `claude-haiku-4-5` — it is a spike; cost is the point. | A different provider changes only `--provider`/`--model` flags. |
| Q9 — who executes | Acceptance is **executable** regardless: every spike exits 0/1 and prints one finding line. Costs nothing extra and serves both readings of Q9. | — |

Spikes **never touch the real `~/.pi/agent/`**. Every script runs with `HOME` pointed at a fresh
temp directory. This is hygiene now and a preview of phase 2, where a sandbox never sees the host's
Pi config either.

Every spike has a **hard timeout (120s)** and fails on it. Spike 6 in particular can hang if Pi waits
on a trust prompt no terminal will answer — that hang *is* a finding, and the timeout is how it gets
recorded instead of stalling the run.

---

## 2. Layout

```
spikes/
  package.json            pi-coding-agent@0.85.1, tsx, typebox — nothing else
  lib/rpc.ts              ≤60 lines: spawn pi, LF-delimited JSONL in/out, awaitEvent(type), timeout
  01-veto/      ext.ts run.ts
  02-drive/     run.ts
  03-submit/    ext.ts run.ts
  04-attach/    run.ts                 (observational — see §3.4)
  05-events/    run.ts
  06-trust/     ext.ts run.ts
  FINDINGS.md             one line per spike + the script that proves it
  run-all.sh              runs 1,2,3,5,6 in order; prints the table; exits non-zero on any failure
```

`lib/rpc.ts` is deliberately too small to be worth keeping. Phase 1's runner rewrites it with
tests. Two framing rules from Pi's RPC doc it must follow even so: **LF is the only record
delimiter** (strip a trailing CR, accept nothing else), and **never use a generic line reader** that
splits on U+2028/U+2029 — those are legal inside JSON strings.

Common invocation, all spikes:

```
HOME=<tmp> pi --mode rpc --no-session --provider anthropic --model claude-haiku-4-5 [-e <ext.ts>]
```

Spike 2 and spike 4 drop `--no-session` and pass `--session-dir <tmp>/sessions` instead, because
they are about the session file.

---

## 3. The spikes

Each has: the question, the procedure, an executable pass condition, the finding line format, and
what changes if it fails.

### 3.1 Veto — **the kill criterion**

**Question.** Can a `tool_call` handler stop a tool from executing?

**Procedure.** `ext.ts` registers:

```ts
pi.on("tool_call", async (event) => {
  if (event.toolName === "bash") return { block: true, reason: "blocked by spike" };
});
```

`run.ts` starts Pi with `-e ./ext.ts`, prompts: *"Run exactly this and nothing else:
`touch <tmp>/veto-ran`"*, waits for `agent_end`.

**Pass, all three:**
1. `<tmp>/veto-ran` **does not exist** after `agent_end`. This is the demonstrable "never executes"
   — a side effect that did not happen, not an event that says it did not.
2. The event stream shows the bash `tool_call` was attempted (a tool execution or result event for
   `bash` is present) — otherwise the model simply declined and the veto was never exercised. If the
   model refuses to call bash, re-prompt once more forcefully; the spike is about the hook, not the
   model's mood.
3. The reason string reaches the model: it appears in the tool result the model receives.

**Finding.** `VETO: pass|fail — {block:true} from tool_call prevents execution; reason reaches model: yes|no`

**If it fails.** Stop. [plan.md](../plan.md) §4's tool-policy model assumes an in-process veto.
The fallback is enforcement *outside* Pi — the runner intercepting at the RPC layer, or the sandbox
denying at the OS level — and that is a design change to make before phase 1, not a package to
write around.

### 3.2 Drive — prompt, abort, resume

**Question.** Can a script prompt a turn, abort it mid-flight, and resume the session from its JSONL?

**Procedure.**
1. Start Pi with `--session-dir`. Send `{"type":"prompt","message":"Using bash, run `sleep 2`
   ten separate times, reporting after each."}`.
2. On the **second** `tool_execution_start`, send `{"type":"abort"}`. Await `agent_end`.
3. Locate the session `.jsonl` under the session dir. Kill the process.
4. Start a **new** Pi process **with `--session <that file>`** on the command line — the flag
   exists (`--session <path|id>`), but the docs do not say whether RPC mode honours it. Send
   `{"type":"get_state"}`. If the prior messages are absent, start again without the flag and send
   `{"type":"switch_session","sessionPath":"<that file>"}` instead, then `get_state`.
5. Send a follow-up prompt: *"How many sleeps had completed before you were interrupted?"* Await
   `agent_end`.

**Pass, all four:**
1. `agent_end` arrives within 10s of `abort` (it did not run all ten sleeps — check wall clock).
2. The session file exists and has ≥ 1 assistant entry.
3. `get_state` after `switch_session` reports the prior messages.
4. The follow-up completes and its answer references the interrupted work (the model can see the
   prior context — assert the reply is non-empty and the turn produced `agent_end`; the *content*
   check is by eye and goes in the finding).

Also record which mechanism worked. `--session` is documented for interactive mode and
`switch_session` for RPC; whether the flag is honoured under `--mode rpc` is exactly what step 4
finds out. Either is fine for the SDK; the finding says which. Also note for phase 1: the session
directory resolves in the order `--session-dir` flag → `PI_CODING_AGENT_SESSION_DIR` → `sessionDir`
in settings, so the runner can use the environment variable rather than a flag.

**Finding.** `DRIVE: pass|fail — abort→agent_end in N.Ns; resume via switch_session|startup flag;
context survives: yes|no`

**If it fails.** The SDK surface changes (resume may need to replay rather than reopen), the design
survives.

### 3.3 Structured output — the submit tool

**Question.** Can `ask()` be built on a tool the model calls to finish, with the turn ending
deterministically?

**Procedure.** `ext.ts` registers `submit_result` with a Typebox schema
(`{ summary: string; risk: "low"|"medium"|"high"; files: string[] }`), and its `execute` returns
`{ content: [...], terminate: true }`. `run.ts` prompts: *"Assess the risk of deleting `/tmp`. Call
`submit_result` with your assessment; do not reply in prose."* Repeat **five times**, fresh process
each.

**Pass:**
1. **5/5** runs contain exactly one `submit_result` call whose args validate against the schema.
2. In each, no `message_start` follows the `submit_result` tool result before `agent_end` — i.e.
   `terminate: true` skipped the follow-up call. (Pi's doc: it takes effect "only when every
   finalized tool result in that batch is terminating" — with one tool in the batch, that holds.)
3. Median wall clock recorded.

**Finding.** `SUBMIT: pass|fail — 5/5 valid; terminate skips follow-up: yes|no; median N.Ns`

**If it fails at 3/5 or 4/5**, note the failure mode (prose reply, malformed args, extra turn) and
run the fallback: ask for JSON in the final message, parse it, count. If neither reaches 5/5, the
third option — provider structured outputs — is a phase 1 decision, not a phase 0 one, because it
changes what the broker must pass through.

### 3.4 Attach — observational, and the one most likely to change a decision

**Question.** What happens when `pi --session <path>` opens a session another process is driving
over RPC?

**Why it matters more than phases.md says.** [plan.md](../plan.md) D4 and
[phases.md](../phases.md) §3 describe attach as `pi --session <path>`. That is two Pi processes and
one JSONL file. Two writers to one append-only log is not a shared live session — it is either a
fork, a corruption, or a lock. Meanwhile [console.md](../console.md) §3 already assumes the other
answer: the console is "a second view onto the same session, driven through the runner's existing
RPC bridge." This spike decides which model is real. **The intent of D4 does not change either
way; its mechanism might.**

**Procedure** (a person at a terminal is required — this cannot be fully scripted):
1. `run.ts` starts Pi RPC with `--session-dir`, prompts once, waits for `agent_end`, then prints
   the session path and the attach command and **keeps running**, tailing events to stdout.
2. In another terminal, run the printed `pi --session <path>` command.
3. Observe, in order: (a) does the TUI open the session and show the prior turn? (b) type a message
   in the TUI — does the RPC process's event tail show anything? (c) does the RPC process's next
   `get_state` include the TUI's message? (d) after quitting the TUI, is there one session file or
   two, and is the original intact?

**Finding.** `ATTACH: shared|forked|locked|corrupt — TUI sees prior turn: y/n; RPC sees TUI input:
y/n; files after: N`

**Expected outcome and what it implies.** Most likely `forked` or `locked`: the TUI reads the
history but the two processes do not share a live turn. If so, `orc attach` must be **a client of
the runner** — a thin TUI that forwards `prompt`/`steer` through the runner to the *one* Pi process,
and renders the runner's event stream. Pi's `extension_ui_request` sub-protocol exists for exactly
that relay. Record the finding; **update D4's mechanism in plan.md §8** (one paragraph) and
phases.md §3; console.md needs no change. If instead the session is genuinely `shared`, D4 stands as
written and the console is simply another attach.

### 3.5 Event inventory — what phase 1's telemetry can be built on

**Question.** Exactly which fields does the RPC stream carry per turn?

**Procedure.** One prompt that triggers two tool calls (*"Use bash to print the date, then use bash
to print the hostname."*). Write every event to `events.jsonl` with a receive timestamp. Then
tabulate: each event type seen; for each, whether it carries `usage`, `model`, `provider`,
`toolName`, `toolCallId`, `args`; and compute each tool's duration from the receive timestamps of
its start and end events.

**Pass:**
1. `message_update` (or `message_end`) carries `usage` with at least `input`, `output`, `cost`.
2. The assistant message carries `model` and `provider`.
3. Tool start/end events are pairable by `toolCallId`, so a duration is computable.

**Expected finding, from the RPC doc: tool timing is *not* a field.** Durations come from the
runner's own clock at the moment it receives start and end. That is fine — the runner is the trusted
emitter anyway ([observability.md](../observability.md) §3) — but phase 1 must know to do it
rather than look for a field that is not there.

**Finding.** `EVENTS: usage in <event>; fields {input,output,cost,totalTokens,...}; model+provider
in <event>; tool timing: field|derived`

**If it fails.** Phase 1's observability increment shrinks to what is actually there. Not a design
change.

### 3.6 Trust — headless with no terminal

**Question.** What does Pi do in RPC mode when a project has `.pi/` config and nothing can answer a
trust prompt?

**Procedure.** Three runs, each in a fresh temp project containing `.pi/settings.json` and a trivial
`.pi/extensions/marker.ts` (registers a command; its presence proves the project config loaded).
1. **No handler, no default.** Start Pi RPC in that cwd. Send a prompt. Pi's usage doc states that
   non-interactive modes "do not show a trust prompt," so a hang is unlikely; the live question is
   whether the default (`"ask"`, with nobody to ask) **silently declines** to load `.pi/` — in which
   case the marker extension is absent and the turn otherwise completes. Record which. The timeout
   stays as a guard.
2. **Handler.** `-e ext.ts` where the extension answers `project_trust` with
   `{ trusted: "yes", remember: false }`. Send a prompt. Does the marker extension load?
3. **Setting.** No handler; global `settings.json` (under the temp `HOME`) sets
   `"defaultProjectTrust": "always"`. The setting is **global only** — it is not honoured in a
   project's `.pi/settings.json`, which is correct, since otherwise a repo could trust itself. Values
   are `"ask"` (default), `"always"`, `"never"`. Same check.

**Pass:** runs 2 and 3 both load the project extension and complete the turn. Run 1's behaviour is
recorded whatever it is.

**Finding.** `TRUST: headless default = loads|declines-silently|hangs; handler works: y/n;
defaultProjectTrust=always works: y/n`

**What it decides.** Phase 2's runner trusts the workspace by policy, not by prompt, so it needs one
of runs 2/3 to work. Which one becomes the runner's mechanism. Run 1's answer says whether an
*unconfigured* runner fails safe (declines silently — the likely case) or fails stuck. A silent
decline is the subtler hazard: a runner that forgot to set trust would run agents *without the
project's extensions* and nothing would say so. Phase 2's runner should assert the marker loaded.

---

## 4. `FINDINGS.md`

One block per spike, written by the script on completion, in this exact shape so phase 1's plan can
cite it:

```
## 01-veto
VETO: pass — {block:true} from tool_call prevents execution; reason reaches model: yes
script: spikes/01-veto/run.ts   pi: 0.85.1   model: claude-haiku-4-5   date: 2026-09-XX
```

Spike 4 is written by hand after observation, same shape.

The file is the phase's deliverable. Phase 1's detailed plan opens by quoting it.

---

## 5. Exit criteria

1. `run-all.sh` exits 0 — spikes 1, 2, 3, 5, 6 pass their executable conditions.
2. Spike 4 has been performed by a person and its finding recorded.
3. `FINDINGS.md` has six blocks.
4. The kill criterion has been evaluated **in writing**: either "spike 1 passed, proceed to phase
   1" or "spike 1 failed, redesign per §3.1" — and if spike 4 came back anything but `shared`,
   D4's mechanism paragraph in [plan.md](../plan.md) §8 has been updated.
5. `spikes/` is committed as a record and **nothing from it is imported by anything**.

**Sizing.** One to two days for a person including the manual attach spike; a few hours for an
agent session with a key in hand, plus a person for §3.4. Model spend is well under a dollar —
roughly fifteen Haiku turns.

---

## 6. Open items

1. **Q5 must be answered before the findings are trusted.** Spikes against 0.85.1 say nothing about
   another version. If the pin changes, re-run.
2. ~~`defaultProjectTrust` values are not confirmed here.~~ **Closed:** `"ask"` | `"always"` |
   `"never"`, global settings only; and non-interactive modes never show the prompt (Pi settings
   and usage docs, 2026-09-18). Spike 6 is updated accordingly.
3. **The attach spike may reshape D4.** That is expected and cheap now; it would not be cheap after
   phase 1 builds `orc attach` on the wrong model.
4. **Whether `--session` is honoured under `--mode rpc`.** The flag exists for interactive mode;
   `switch_session` exists for RPC; the docs are silent on the overlap. Spike 2 now tries the flag
   first and records which works; phase 1 builds on whichever it is.
