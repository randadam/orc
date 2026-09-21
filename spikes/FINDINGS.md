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
| 01-veto | written — not run, needs a key |
| 02-drive | written — not run, needs a key |
| 03-submit | written — not run, needs a key |
| 04-attach | written — not run, needs a key and a person at two terminals |
| 05-events | written — not run, needs a key |
| 06-trust | pass |

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

Written, not run. **This is the kill criterion** ([phase-0.md](../docs/phases/phase-0.md) §3.1) and it
needs a model that will actually call `bash`.

What the probe already confirms about the mechanism, from Pi's own docs and a live extension load:
`tool_call` fires **after** `tool_execution_start` and before execution, and returning
`{ block: true, reason, terminate? }` is the documented way to stop it. So the spike's second pass
condition — that the bash call was genuinely attempted — is satisfiable from
`tool_execution_start`. That is the mechanism being documented, not the veto being observed. The
finding still has to come from a run where `veto-ran` does not exist.

`run.ts` asserts §3.1's three conditions in order: the model attempted a bash call
(`tool_execution_start`), the file at `<tmp>/veto-ran` does not exist afterwards, and the reason
string appears in the tool result the model was shown. It re-prompts once, more forcefully, if the
model does not reach for bash on the first try, and prints the tool result verbatim so a reason that
arrives in an unexpected shape is visible rather than merely absent.

## 02-drive

Written, not run. Needs a key.

`run.ts` follows §3.2 step by step and tries the startup flag before `switch_session`, so the
finding says which mechanism actually works under `--mode rpc` rather than assuming. It prints the
follow-up answer for the by-eye check §3.2 pass condition 4 asks for.

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

Written, not run. Needs a key, five runs.

`typebox` is pinned to `1.3.27` here to match Pi's own dependency exactly, so a schema built in a
spike is the same schema Pi validates against. `run.ts` validates the recorded tool arguments with
`Value.Check` against the very object `ext.ts` registered — not a hand-written copy of it — and
detects the `terminate: true` effect by looking for a `message_start` between the `submit_result`
tool result and `agent_end`. §3.3's fallback (ask for JSON in the final message, parse it, count) is
implemented and runs automatically when the tool path does not reach 5/5, but not when the provider
itself failed.

## 04-attach

Written, not run. Requires a person at **two** terminals — see
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

Written, not run. Needs a key.

`run.ts` writes every record with its receive timestamp to `05-events/events.jsonl` (git-ignored, so
the run can be read afterwards without committing a transcript), prints the event-by-field table
§3.5 asks for, and computes each tool's duration from `Pi.receivedAt` — the runner's own clock,
which is the answer §3.5 expects to have to record.

From Pi's RPC doc, ahead of the run: `message_update` carries a top-level `usage` with
`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens` and a `cost` breakdown, and
`tool_execution_start`/`_end` correlate by `toolCallId`. **No tool timing field appears in either.**
The expectation in §3.5 — that durations are derived from the runner's own clock — looks right, but
the finding is what the stream actually carries on a real turn, not what the doc lists.

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

## Open items

1. ~~**The four model-backed spikes are unwritten, not failed.**~~ **Closed 2026-09-21:** all five
   key-dependent spikes are written, typecheck, and have had their failure paths exercised against a
   deliberately invalid key. What remains is a key and `./run-all.sh`, plus a person for 04-attach.
2. **The kill criterion is unevaluated.** [phase-0.md](../docs/phases/phase-0.md) §5 exit criterion
   4 requires it in writing. Nothing may be built on the tool-policy model until 01-veto runs.
   Writing the script did not evaluate it; only a run does.
3. **0.87.0 shipped on npm.** The pin here stays 0.86.1 per the decided policy — re-pinning is
   deliberate and re-runs the spikes. Worth noting that Pi shipped three minor versions in the
   four days this plan has existed.
4. **01-veto could be run against a stub provider** registered with `pi.registerProvider`, which
   would exercise the `tool_call` hook with no key and no spend. Rejected for now: it proves the
   hook fires, not that the design holds against a real model's tool call, and §3.1's pass
   conditions are written against the real one. Worth reconsidering only if a key stays unavailable.
   `registerProvider` is confirmed present in 0.86.1, so the option is real if it comes to that.
5. **The spikes were written in an environment with no key**, so every script has been run only
   against a 401. The assertions are exercised; the answers are not. A first real run may well turn
   up a shape the scripts do not expect — a `message_update` that carries usage where this expects
   `message_end`, a session entry that nests differently. That is the spike working, not failing;
   fix the script and re-run.
