# Phase 0 findings

One block per spike. Written against **pi 0.86.1**, Node 22.22, on direct Anthropic API keys.
Phase 1's plan quotes this file; until a block says `pass` or `fail`, phase 1 is assuming.

Re-run with `./run-all.sh`. It typechecks, runs every spike present, and exits non-zero if any
ran and failed. Spikes that need a model are skipped, loudly, when `ANTHROPIC_API_KEY` is unset.

| Spike | Status |
| --- | --- |
| 00-harness | pass |
| 01-veto | not written — needs a key |
| 02-drive | not written — needs a key |
| 03-submit | not written — needs a key |
| 04-attach | not run — needs a person at a terminal |
| 05-events | not written — needs a key |
| 06-trust | pass |

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

Not written. **This is the kill criterion** ([phase-0.md](../docs/phases/phase-0.md) §3.1) and it
needs a model that will actually call `bash`.

What the probe already confirms about the mechanism, from Pi's own docs and a live extension load:
`tool_call` fires **after** `tool_execution_start` and before execution, and returning
`{ block: true, reason, terminate? }` is the documented way to stop it. So the spike's second pass
condition — that the bash call was genuinely attempted — is satisfiable from
`tool_execution_start`. That is the mechanism being documented, not the veto being observed. The
finding still has to come from a run where `veto-ran` does not exist.

## 02-drive

Not written. Needs a key.

For whoever writes it: the session directory resolves `--session-dir` → `PI_CODING_AGENT_SESSION_DIR`
→ `sessionDir` in settings, so the runner can use the environment variable rather than a flag.
`--session <path|id>` is present in `pi --help` with no note restricting it to interactive mode,
which is what §3.2 step 4 has to find out for real.

Also relevant to what "the turn ended" means: `agent_end` is **one low-level run**, and may be
followed by a retry, a compaction, or a queued continuation. `agent_settled` is the event that says
nothing more follows automatically. Phase 0's pass conditions are written against `agent_end`;
phase 1's runner should wait on `agent_settled`.

## 03-submit

Not written. Needs a key, five runs.

`typebox` is pinned to `1.3.27` here to match Pi's own dependency exactly, so a schema built in a
spike is the same schema Pi validates against.

## 04-attach

Not run. Requires a person at a terminal — see [phase-0.md](../docs/phases/phase-0.md) §3.4. This is
the spike most likely to change a decision (D4's mechanism), and it cannot be scripted.

## 05-events

Not written. Needs a key.

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

1. **The four model-backed spikes are unwritten, not failed.** `ANTHROPIC_API_KEY` is unset in the
   environment this ran in. The harness they sit on is built and passing, so each is a script, not
   a discovery exercise.
2. **The kill criterion is unevaluated.** [phase-0.md](../docs/phases/phase-0.md) §5 exit criterion
   4 requires it in writing. Nothing may be built on the tool-policy model until 01-veto runs.
3. **0.87.0 shipped on npm.** The pin here stays 0.86.1 per the decided policy — re-pinning is
   deliberate and re-runs the spikes. Worth noting that Pi shipped three minor versions in the
   four days this plan has existed.
4. **01-veto could be run against a stub provider** registered with `pi.registerProvider`, which
   would exercise the `tool_call` hook with no key and no spend. Rejected for now: it proves the
   hook fires, not that the design holds against a real model's tool call, and §3.1's pass
   conditions are written against the real one. Worth reconsidering only if a key stays unavailable.
