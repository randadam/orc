# Phase 0 findings

One block per spike. Written against **pi 0.86.1**, Node 22.22, on direct Anthropic API keys.
Phase 1's plan quotes this file; until a block says `pass` or `fail`, phase 1 is assuming.

Re-run with `./run-all.sh`. It typechecks, runs every spike present, and exits non-zero if any
ran and failed. Spikes that need a model are skipped, loudly, when no key is configured.

**The key.** Copy `spikes/.env.example` to `spikes/.env` and put `ANTHROPIC_KEY=sk-ant-...` in it.
`.env` is git-ignored. `ANTHROPIC_API_KEY` in the real environment wins over the file, and either
name works in either place. Nothing else in `spikes/` reads a credential, and nothing writes one
anywhere: `lib/rpc.ts` is the only place a key is handed to a process, which is the same discipline
[CLAUDE.md](../CLAUDE.md) puts on the broker.

| Spike | Status |
| --- | --- |
| 00-harness | pass |
| 01-veto | **pass** — the kill criterion is answered |
| 02-drive | **pass** |
| 03-submit | **pass** |
| 04-attach | **forked** — observed 2026-09-21; D4's mechanism changes |
| 05-events | pass |
| 06-trust | pass |

**Phase 0 is complete as of 2026-09-21.** `./run-all.sh` exits 0 with all six passing; 04-attach was
performed by hand; every [phase-0.md](../docs/phases/phase-0.md) §5 exit criterion is met. Nothing
here is imported by anything, and nothing here should be — phase 1's runner rewrites `lib/rpc.ts`
with tests.

**Two of the six took more than one run**, both because the spike was wrong rather than Pi. That is
what the spikes are for, and the mistakes are written up rather than quietly fixed — each one is a
trap phase 1's runner would otherwise walk into.

**The kill criterion is evaluated: spike 1 passed, proceed to phase 1.**
[phase-0.md](../docs/phases/phase-0.md) §5 exit criterion 4 asks for this in writing, so: a
`tool_call` handler returning `{ block: true }` stopped `bash` from executing, the file it would
have created does not exist, and the reason reached the model. The tool-policy model in
[plan.md](../docs/plan.md) §4 stands as designed.

**A spike that could not reach its question says so.** An unusable key looks exactly like a model
that declined to call a tool, and the difference matters most on 01-veto, where "the bash call never
happened" is either the design working or the provider being down. Every model-backed spike checks
`stopReason: "error"` on the assistant message first and reports
`no verdict: the model call never succeeded (...)` instead of a finding it did not observe. Do not
paste such a line into the table above as a `fail`.

---

## 00-harness

Not one of the six. The RPC client the other spikes are built on, plus the one check that
can fail silently: Pi frames records with LF only, and Node's `readline` also splits on U+2028 and
U+2029, which are legal inside JSON strings. A decoder that gets this wrong corrupts a stream
rarely enough to look like a model problem.

```
HARNESS: pass — LF-only framing holds across chunk, CRLF and U+2028/9 cases; pi --mode rpc answers get_state with no API key
script: spikes/00-harness/run.ts   pi: 0.86.1   date: 2026-09-21
```

Two things it settles for phase 1:

- **`pi --mode rpc` starts and serves commands with no API key set.** `get_state` and
  `get_commands` answer from the process, not the provider. Anything that does not call the model
  is testable for free — which is how 06-trust below came back without spending anything.
- **The package exports only ESM conditions and no `./package.json`.** `require.resolve` cannot
  locate it; `import.meta.resolve` off the main entry is how the runner finds the CLI.

## 01-veto

```
VETO: pass — {block:true} from tool_call prevents execution; reason reaches model: yes
script: spikes/01-veto/run.ts   pi: 0.86.1   model: claude-haiku-4-5   date: 2026-09-21
```

All three §3.1 conditions held on the first run: the model attempted the `bash` call, `veto-ran` did
not exist afterwards, and the reason string came back in the tool result the model was shown —
twice, in fact, which is the model retrying the blocked call once and being refused again. **The
veto is in-process and it works.** Phase 1 can build the tool policy on it.

**This was the kill criterion** ([phase-0.md](../docs/phases/phase-0.md) §3.1) and it
needs a model that will actually call `bash`.

What the probe established ahead of the run, from Pi's own docs and a live extension load:
`tool_call` fires **after** `tool_execution_start` and before execution, and returning
`{ block: true, reason, terminate? }` is the documented way to stop it. So the spike's second pass
condition — that the bash call was genuinely attempted — is satisfiable from
`tool_execution_start`. That is the mechanism being documented, not the veto being observed. The
finding still has to come from a run where `veto-ran` does not exist.

`run.ts` asserts those three conditions in order and prints the tool result verbatim, so a reason
arriving in an unexpected shape is visible rather than merely absent. It re-prompts once, more
forcefully, if the model does not reach for bash on the first try; on the observed run it did not
need to.

## 02-drive

```
DRIVE: pass — abort→agent_end in 0.0s; resume via startup flag; context survives: yes
script: spikes/02-drive/run.ts   pi: 0.86.1   model: claude-haiku-4-5   date: 2026-09-21
```

What it establishes:

- **Abort works, and it is immediate.** `agent_end` arrived **0.0s** after the abort, and **10 of
  10** tool executions ended aborted. By the model's own account on resume, *"0 sleeps completed"* —
  the abort caught every one of them in flight.
- **`--session <path>` IS honoured under `--mode rpc`.** The startup flag worked on the first try, so
  `switch_session` was never needed. This is the open question §3.2 step 4 existed to settle
  ([phase-0.md](../docs/phases/phase-0.md) §6 item 4), and it means phase 1's resume is a flag.
- **Context survives the resume.** `messageCount` 14, and the follow-up turn answered about the
  interrupted work rather than starting fresh.

It took three runs, and the second one's failure is the more instructive of the two.
**Pi runs sibling tool calls concurrently by default** — Haiku emitted all ten `bash` calls in one
assistant message and all ten `tool_execution_start`s fired together. The check asserted
`tool_execution_start < 10` as a stand-in for §3.2's *"it did not run all ten sleeps — check wall
clock"*, and under parallel execution a start count measures nothing about work done. It now counts
**tool executions that ended aborted**, which is the effect itself rather than a proxy for it.
Phase 1 should take the parallelism as a finding in its own right: a per-tool
`executionMode: "sequential"` exists, and `tool_call` preflights siblings sequentially before they
execute concurrently.

The first run never reached the abort at all: it waited 60s for a *second*
`tool_execution_start` — which, in that run, the model never produced as a separate message — and
the turn finished during the wait, so the `abort` landed on an idle session. Two things came out of
that. The wait is now event-driven and a turn that ends before it can be aborted is reported as
exactly that. And, for the runner: **an `abort` on a settled session emits nothing.** It answers,
and stays silent. A runner that sends `abort` then waits for `agent_end` to confirm will hang
whenever the turn happened to finish first — wait on the response, and treat an already-settled
session as already aborted.

For whoever runs it: the session directory resolves `--session-dir` → `PI_CODING_AGENT_SESSION_DIR`
→ `sessionDir` in settings, so the runner can use the environment variable rather than a flag.
`--session <path|id>` is present in `pi --help` with no note restricting it to interactive mode,
which is what §3.2 step 4 has to find out for real.

Also relevant to what "the turn ended" means: `agent_end` is **one low-level run**, and may be
followed by a retry, a compaction, or a queued continuation. `agent_settled` is the event that says
nothing more follows automatically. §3.2's pass conditions are written against `agent_end`; the
scripts time `abort`→`agent_end` as specified but wait on `agent_settled` before reading a turn's
results, because a retry after `agent_end` would otherwise be read as the answer. Phase 1's runner
should do the same.

## 03-submit

```
SUBMIT: pass — 5/5 valid; terminate skips follow-up: yes; median 5.3s
script: spikes/03-submit/run.ts   pi: 0.86.1   model: claude-haiku-4-5   date: 2026-09-21
```

Five fresh processes, five single `submit_result` calls, five argument sets valid against the schema
`ext.ts` registered, and no follow-up assistant message in any of them. Two five-run batches came in
at medians of 5.3s and 6.6s, spread 4.7s–10.5s. The JSON fallback was never needed. **`ask()` can be built on a terminating tool**, and it costs one
turn rather than two.

It took two runs. The first reported `terminate skips follow-up: no`, which was wrong: the check
looked for any `message_start` between the `submit_result` tool result and `agent_end`, and
05-events showed that **Pi emits `message_start`/`message_end` for the `toolResult` message too**.
The tool result's own `message_start` was being counted as the follow-up it was meant to detect, so
the check could never have passed. It now requires `message.role === "assistant"`.

Worth remembering as a class, because phase 1's telemetry can make exactly the same mistake:
**an event name is not a message type.** Count assistant turns by reading `message.role`, never by
counting `message_start`.

`typebox` is pinned to `1.3.27` here to match Pi's own dependency exactly, so a schema built in a
spike is the same schema Pi validates against, and `run.ts` validates against the very object
`ext.ts` registered rather than a hand-written copy.

## 04-attach

```
ATTACH: forked — TUI sees prior turn: y; RPC sees TUI input: n; files after: 1
script: spikes/04-attach/run.ts   pi: 0.86.1   date: 2026-09-21
```

**Not shared. `orc attach` cannot be `pi --session <path>`, and D4's mechanism changes** — see
[plan.md](../docs/plan.md) §8 D4, updated with this.

What happened, in order: the TUI opened the session and showed the prior turn, so the history is
readable by a second process. A message typed into the TUI produced **nothing** in the RPC process's
event tail, and the RPC process's `get_state` still reported 3 messages afterwards, exactly as
before. There is no live channel between them.

**The detail that matters more than the verdict word: there is one file, and both processes write
to it.** The session file went from 6 entries to 10 and still parses — the TUI appended its turn to
the same JSONL the RPC process owns. "Forked" here does not mean two files; it means two writers
with divergent views of one append-only log. Pi's v2 session format is a tree keyed by
`id`/`parentId` precisely so that in-place branching does not need a second file, so the RPC
process's next write would have branched from a parent four entries stale rather than corrupting
anything.

**What this run does not establish**, and nobody should assume from it: what happens when the RPC
process writes *after* the TUI has written. Here it was idle throughout. That is the case
`orc attach` would actually hit, and it was not tested — which is an argument for not building on
this path at all rather than for testing it further.

**The consequence.** `orc attach` must be a client of the runner: a thin TUI forwarding
`prompt`/`steer` through the runner to the one Pi process and rendering the runner's event stream.
Pi's `extension_ui_request` sub-protocol is the relay for it. This is the model
[console.md](../docs/console.md) §3 already assumed, so the console needs no change; D4 and
[phases.md](../docs/phases.md) §3 did, and are updated.

The harness that produced it requires a person at **two** terminals — see
[phase-0.md](../docs/phases/phase-0.md) §3.4. This is the spike most likely to change a decision
(D4's mechanism), and the observation cannot be scripted; the setup around it can, and now is.

`pnpm 04-attach` seeds one turn over RPC, writes an `attach.sh` into the throwaway workspace and
prints the one command to run in the second terminal, then tails its own event stream while asking
the four §3.4 questions. Two of them it answers itself: whether the RPC process's `get_state`
grew a message, and how many session files exist afterwards with the original still parsing. The
verdict — `shared` / `forked` / `locked` / `corrupt` — is derived from those, and the script says in
its own output that anything but `shared` means updating D4's mechanism in
[plan.md](../docs/plan.md) §8 and [phases.md](../docs/phases.md) §3.

`attach.sh` sources `spikes/.env` rather than carrying a copy of the key, so the second terminal
gets a working TUI without the credential landing in a temp file or in scrollback.

## 05-events

```
EVENTS: usage in message_update; fields {input,output,cacheRead,cacheWrite,totalTokens,cost,cacheWrite1h}; model+provider in message_start; tool timing: derived
script: spikes/05-events/run.ts   pi: 0.86.1   model: claude-haiku-4-5   date: 2026-09-21
```

The shape below is from one two-tool turn of 86 records; counts vary with response length (a second
run gave 75 records and 47 `message_update`s), the fields do not. What phase 1's telemetry can be
built on, by event:

| Event | count | usage | model | provider | toolName | toolCallId | args |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `message_start` / `message_end` | 6 each | yes | yes | yes | yes | yes | — |
| `message_update` | 58 | yes | — | — | — | — | — |
| `tool_execution_start` | 2 | — | — | — | yes | yes | yes |
| `tool_execution_update` | 4 | — | — | — | yes | yes | yes |
| `tool_execution_end` | 2 | — | — | — | yes | yes | — |
| `turn_end` | 2 | yes | yes | yes | — | — | — |
| `agent_start` / `agent_end` / `agent_settled` / `turn_start` | 1/1/1/2 | — | — | — | — | — | — |

Four things phase 1 should take from it:

- **`turn_end` is the cheap place to bill from.** It carries `usage`, `model` and `provider`
  together, **twice** over this turn, where `message_update` carried usage fifty-odd times for the
  same work.
- **`usage` has a field the docs do not list: `cacheWrite1h`.** The full set observed is
  `input, output, cacheRead, cacheWrite, totalTokens, cost, cacheWrite1h`. A cost calculation that
  enumerates fields will silently miss it; one that reads `cost.total` will not.
- **Tool timing is derived, as §3.5 expected.** No duration field appears on any tool event. The
  two `bash` calls clocked 0.01s each from the receive timestamps, which is the runner's own clock
  and the only one there is ([observability.md](../docs/observability.md) §3).
- **`message_start` fires for tool results as well as assistant messages** — that is why it shows
  `toolName` and `toolCallId` above, and it is what broke 03-submit's check. Read the role.

`run.ts` writes every record with its receive timestamp to `05-events/events.jsonl` (git-ignored, so
the run can be read afterwards without committing a transcript), prints the event-by-field table
§3.5 asks for, and computes each tool's duration from `Pi.receivedAt` — the runner's own clock,
which is the answer §3.5 expects to have to record.

The doc's description held up on a real turn, with the one addition (`cacheWrite1h`) noted above.

## 06-trust

```
TRUST: headless default = declines-silently; handler works: y; defaultProjectTrust=always works: y; --approve works: y
script: spikes/06-trust/run.ts   pi: 0.86.1   date: 2026-09-21
```

Four fresh temp `HOME`s, four fresh temp projects, each holding a `.pi/extensions/marker.ts` whose
registered command appears in `get_commands` only if the project was trusted. No prompt, no model
call, no spend.

**The default is the subtle failure the plan predicted.** With no handler and no global setting, Pi
neither hangs nor complains — it loads the project's `.pi/` not at all, and the process otherwise
behaves normally. A runner that forgets to set trust runs agents *without the project's extensions*
and nothing says so.

**Three mechanisms work, not two.** §3.6 names a `project_trust` handler and
`defaultProjectTrust: "always"`. There is also `--approve` / `-a` ("Trust project-local files for
this run"), which is per-run rather than global and is the closest fit to
[plan.md](../docs/plan.md) §8 D2's rule that policy is frozen per run: a global setting in the
sandbox image would trust every project the sandbox ever opens, where the flag trusts exactly the
one workspace the runner is starting.

**What phase 2 must do either way:** assert the marker loaded. Trust that silently fails open on
"no extensions" is indistinguishable from a working run until behaviour diverges.

---

## What phase 1 should carry forward

Six things here are not findings about the questions asked, but traps the runner will hit anyway:

1. **Wait on `agent_settled`, not `agent_end`.** `agent_end` is one low-level run and may be
   followed by a retry, a compaction or a queued continuation.
2. **An `abort` on a settled session emits nothing.** Wait on the command response; treat an
   already-settled session as already aborted.
3. **Sibling tool calls execute concurrently.** `tool_call` preflights them sequentially, then they
   run in parallel. A gate assuming one in-flight tool at a time is wrong.
4. **`message_start` fires for tool-result messages too.** Read `message.role`; never count turns by
   counting the event.
5. **Bill from `turn_end`**, which carries `usage`, `model` and `provider` together once per turn,
   and read `cost.total` rather than enumerating usage fields — there is an undocumented
   `cacheWrite1h` in there.
6. **Assert the trust marker loaded.** The default declines silently, so a misconfigured runner runs
   agents without the project's extensions and nothing says so.

## Open items

1. ~~**The four model-backed spikes are unwritten, not failed.**~~ **Closed 2026-09-21:** all five
   key-dependent spikes are written, typecheck, and have had their failure paths exercised against a
   deliberately invalid key. What remains is a key and `./run-all.sh`, plus a person for 04-attach.
2. ~~**The kill criterion is unevaluated.**~~ **Closed 2026-09-21: 01-veto passed.** The verdict is
   written at the top of this file, as [phase-0.md](../docs/phases/phase-0.md) §5 exit criterion 4
   requires. Phase 1 may build on the tool-policy model.
3. **0.87.0 shipped on npm.** The pin here stays 0.86.1 per the decided policy — re-pinning is
   deliberate and re-runs the spikes. Worth noting that Pi shipped three minor versions in the
   four days this plan has existed.
4. **01-veto could be run against a stub provider** registered with `pi.registerProvider`, which
   would exercise the `tool_call` hook with no key and no spend. Rejected for now: it proves the
   hook fires, not that the design holds against a real model's tool call, and §3.1's pass
   conditions are written against the real one. Worth reconsidering only if a key stays unavailable.
   `registerProvider` is confirmed present in 0.86.1, so the option is real if it comes to that.
5. ~~**The spikes were written in an environment with no key**, so a first real run may well turn up
   a shape the scripts do not expect.~~ **It did, three times**, and every one was the spike being
   wrong rather than Pi: 03-submit counted a `message_start` belonging to a tool result; 02-drive
   first waited out a timeout for a second tool call the model never made, then measured the abort
   by counting tool *starts*, which parallel tool execution makes meaningless. All three are fixed
   and the reasoning is kept above rather than deleted.
6. ~~**`--session` under `--mode rpc` is unanswered.**~~ **Closed: it is honoured.** 02-drive
   resumed via the startup flag on the first attempt and never needed `switch_session`. Phase 1's
   resume is a flag.
7. ~~**One re-run is outstanding: 02-drive.**~~ **Closed: `./run-all.sh` is green end to end**, all
   six passing, 2026-09-21. Exit criterion 1 is met.
8. **Pi runs sibling tool calls concurrently by default.** Recorded under 02-drive. It falls out of
   the bug rather than out of any spike's question, and it bears on the tool gate: `tool_call`
   preflights siblings sequentially, then they execute in parallel, so a gate that assumes one
   in-flight tool at a time is wrong.
