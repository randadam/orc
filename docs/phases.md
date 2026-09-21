# Phases — the prototype, one playable increment at a time

This document sequences the build. It reconciles the two staging vocabularies already in the docs —
[poc.md](poc.md) §7's Weeks 0–3 and [poc-v2.md](poc-v2.md) §9's S0–S4 — into one ordered list of
phases, and it is the authority on order from here on. Each phase ends with something you can run
and poke at; each is planned in detail separately, so this document stays at the level of goals,
scope, and acceptance criteria.

Nothing here reopens a decision in [plan.md](plan.md) §8. Where a phase needs a smaller decision that
those do not cover, it is either **settled here** (the obvious ones) or **left open with options**,
and anything that needs a real run rather than an argument is flagged as a spike.

---

## 1. Principles for the ordering

Four rules produced the sequence below, and they are the ones to reason from when a phase needs
re-cutting.

**Kill risks before building on them.** The design rests on a few claims about Pi that no argument
can settle: that `tool_call` can veto, that a session another process is driving can be attached to,
that structured output can be extracted reliably. Those are spikes, and they come first.

**Ergonomics before isolation.** The orchestration API is the thing users touch, and it is cheapest
to change before a broker, a container and a runner sit between the workflow and the agent. So the
SDK is iterated on bare subprocesses with a real key, and containment arrives once the shape is
stable.

**Instrument as soon as the emitter exists, not when a dashboard is wanted.** Every empirical open
item in the docs is answered by a metric, and retrofitting instrumentation means re-running
everything ([observability.md](observability.md) §6). So each phase carries an *observability
increment*: spans arrive with the runner, cost with the broker, comparison with the first real
configuration question. The instrument is never a phase of its own, because it is never the thing
being proved — it is how the thing being proved gets measured.

**Skeleton before flesh.** Once the plumbing stands, the feature-delivery workflow is built as a
stubbed walking skeleton first and thickened one phase at a time. This is poc-v2's S0 rule, and it
is kept: control flow, memoization, resume and escalation are proved on canned output before any
role does real work.

---

## 2. The phases at a glance

| Phase | Delivers | Maps to | Playable result |
| --- | --- | --- | --- |
| **0** | Spikes on Pi | Week 0 / M0 | Scripts that prove (or kill) the harness claims |
| **1** | The SDK on bare subprocesses, with traces | Week 1 | `orc run` a loop-and-escape workflow on your machine, read its trace |
| **2** | Sandboxes and the broker | Week 2 | Same workflow in containers holding no key; cost per run |
| **3** | Durability and a cheap dev loop | Week 3 | Kill a sandbox and resume; replay recorded sessions offline |
| **4** | Feature delivery, walking skeleton | S0 | The whole workflow shape runs on stubs in seconds |
| **5** | Real planning | S1 | Interview a PM, read a reviewed plan, see the review loop converge or not |
| **6** | One real slice, two models, first comparison | S2 | A slice merges green; `orc compare` answers Haiku vs Sonnet |
| **7** | The scheduler | S3 | A dependency chain with concurrent slices and a resolved conflict |
| **8** | Fan-out and sign-offs | S4 | The full workflow, end to end, evidence-gated |

Phases 0–3 are the plumbing ([poc.md](poc.md)); 4–8 are the workflow ([poc-v2.md](poc-v2.md)). The
seam between them is deliberate: **phase 3 is the last phase that can change the SDK's shape
cheaply.** After it, the workflow is a consumer.

The AWS deployment, the egress gateway, the console and the connectors are not phases here. They are
listed in §12 so the seams that keep them cheap stay visible, and no more.

---

## 3. Phase 0 — spikes: is Pi the harness we think it is?

> Detailed plan: [phases/phase-0.md](phases/phase-0.md).

**Goal.** Falsify the load-bearing assumptions about Pi before anything is built on them. Nothing
from this phase is kept as code.

**What you can play with.** A handful of throwaway scripts under `spikes/`, each answering one
question with a yes or no you can reproduce.

**Scope.**

- Drive `pi --mode rpc` from Node: `prompt`, consume events to `agent_end`, `abort` mid-turn.
- A throwaway extension that blocks `bash` from a `tool_call` handler — the claim the entire tool
  policy model rests on.
- Extract structured output from a turn against a schema, by whichever mechanism the spike below settles.
- Attach a Pi TUI (`pi --session <path>`) to a session another process is driving over RPC, and see
  what happens to both. **Answered 2026-09-21: they do not share a live session** — one file, two
  writers, no live channel. `orc attach` becomes a client of the runner; see [plan.md](plan.md) §8
  D4, revised, and `spikes/FINDINGS.md`.
- Confirm what Pi's RPC event stream carries per turn: token usage, model, tool timings. Phase 1's
  telemetry is built on whatever this finds.
- Confirm how `project_trust` behaves in RPC mode with no terminal to answer the prompt.

**Acceptance.**

1. A `bash` call is blocked from `tool_call` and demonstrably never executes.
2. A session is prompted, aborted mid-turn, and resumed from its JSONL, from a script.
3. One structured-output mechanism works reliably enough to build `ask()` on.
4. Written findings for the attach, usage and trust questions, each one sentence and one script.

**Kill criterion.** If (1) fails, stop. The tool-policy model in [plan.md](plan.md) §4 changes before
any package is written. If (2) or (3) fails, the SDK surface changes but the design survives.

**Settled here.**

- Spikes are disposable and live outside `packages/`. Nothing in them is a foundation.

**Left open — structured output.** Three candidate mechanisms, to be chosen by what works in the spike:

| Option | How | For | Against |
| --- | --- | --- | --- |
| **Submit tool** (recommended) | Register a `submit_result` tool with the schema; the agent calls it to finish | Model-agnostic, ends the turn deterministically, validation at the boundary | One more tool in every role's allowlist |
| Parse the final message | Ask for JSON, parse the last assistant message | No tooling | Fragile; retries on parse failure burn turns |
| Provider structured outputs | Use the API's native constrained output | Strongest guarantee | Ties `ask()` to a provider feature; the broker must pass it through |

**Spikes.** All of this phase is spikes. The two that could change the design are the veto and the
attach; the rest change a package.

---

## 4. Phase 1 — the SDK, on bare subprocesses, with traces

> Detailed plan: [phases/phase-1.md](phases/phase-1.md).

**Goal.** Get the orchestration API right while changing it is cheap. Agents are local `pi`
subprocesses with a real key in the environment. No broker, no container, no isolation.

**What you can play with.** `orc run examples/loop-and-escape` on your machine: a workflow with a
review loop, a loop back to an earlier phase, an attempt-count escape hatch and a terminal
escalation prompt. Then `orc trace <run>` (or a local Jaeger) to read what the agents did, and a
second `orc run` that skips the steps already done.

**Scope.**

- `@orc/sdk`: `defineConfig` (frozen value, inline beside the workflow — no separate file yet),
  `defineWorkflow`, `orc.agent(role).run() / ask() / session()`, `orc.parallel()`, `orc.step()` with
  on-disk memoization and correct cache keys (id + schema + prompt + inputs), `orc.escalate()` as a
  terminal prompt whose answer is stored under its step id, `orc.verify()` executed by the runner.
- `@orc/runner` as a library: spawns `pi --mode rpc`, bridges the RPC, forwards Pi's events verbatim.
  A `Sandbox` interface with one implementation, `LocalProcessSandbox`.
- `@orc/pi`: the extension loaded into every agent — `tool_call` gate driven by the role's
  allow/deny lists, and `resolveModels()` returning a constant.
- `orc` CLI: `run`, `runs`, `show <run>`, `trace <run>`.
- The **run directory**: everything about a run on disk, never only in the workflow process's memory
  ([console.md](console.md) §7). Steps, escalations, sessions, verify results, telemetry — each with a
  stable id.
- Two example workflows: the loop-and-escape one, and one that fans out with `parallel()`.
- Two roles with different tool policy, so per-role enforcement is real from the first run.
- Turn caps per agent and per run. A runaway loop during development is a real cost event.

**Observability increment.** The OTEL SDK is wired now, because the runner is the emitter and it now
exists. One trace per run; spans for run, phase, step, agent, turn, tool call and verify, derived
from Pi's RPC stream. `orc.config.hash` computed from the frozen config plus the content hashes of
loaded extensions and skills, stamped on every span and every run record from the very first run —
it costs nothing now and is the join key for every comparison later. Token counts come from Pi's
events and are labelled provisional; the broker replaces them in phase 2.

**Acceptance.**

1. The loop-and-escape workflow runs end to end against a real model and reads like ordinary
   TypeScript to someone who has not seen orc. Comments explain the task, not the API.
2. A `deny`-listed tool is blocked at `tool_call` and never executes — asserted by a test.
3. Re-running a completed run skips every memoized step; editing a step's prompt invalidates that
   step and everything downstream, and nothing else.
4. An escalation answered once is not re-asked on resume.
5. `orc.verify()` returns an exit code the agent did not produce, recorded in the run directory.
6. A trace of the run exists, with spans nested run → agent → turn → tool, carrying the config hash.

**Settled here.**

- **Monorepo.** pnpm workspaces, Node 22, TypeScript, vitest. Packages per [poc.md](poc.md) §6.
- **The runner is a library with a `Sandbox` seam**, not a separate process yet. Phase 2 puts the same
  code inside a container; the workflow-facing interface does not change.
- **The run directory is the API.** Every later reader — resume, `orc compare`, the console — reads
  files under `.orc/runs/<id>/`. Its layout is fixed in this phase's detailed plan and versioned.
- **Escalation is a terminal prompt** in the workflow process (D4). No other channel in the prototype.
- **Phase 1 runs against a throwaway clone** in a temp directory, never the developer's checkout.
  Agents hold `write` and `bash` on a real machine here; the target is disposable by construction.
- **One model, Sonnet.** The Haiku split arrives with real implementation in phase 6.

~~**Left open — where telemetry lands.**~~ **Settled 2026-09-21 in
[phases/phase-1.md](phases/phase-1.md) §2.1: an in-process exporter writes `trace.jsonl` into the
run directory; OTLP to a collector is an `--otlp` flag, off by default.** Decided by Q6 (no Docker,
and a collector is a container) and by the run directory already being the one place every later
reader looks. The options, for the record:

| Option | For | Against |
| --- | --- | --- |
| **In-process exporter writing JSONL into the run directory** (chosen) | Nothing to run; `orc show` and `orc compare` read one place; records outlive the run by construction | Not a standard backend; viewing a trace needs a converter or a small viewer |
| OTLP to a local collector writing files | Standard; Jaeger for free | A collector to run on every dev loop; run records and telemetry live in two places |

**Spikes.** None beyond phase 0. If phase 0 found the RPC stream does not carry usage, phase 1
records turns and durations only and cost waits for the broker.

---

## 5. Phase 2 — sandboxes and the broker

**Goal.** Make the thesis testable: a sandboxed agent does real work holding only a sentinel, with no
network except the broker.

**What you can play with.** The same workflows, now one container per agent. `docker exec` into a
running sandbox and fail to find a key. `orc show <run>` now reports cost, from the broker.

**Scope.**

- `@orc/broker` in TypeScript: sentinel mint / validate / substitute, one upstream
  (`api.anthropic.com`, direct key), SSE proxied unbuffered, upstream auth failures rewritten to
  `502 upstream_auth_failed`, token usage parsed from the stream. A `ModelBackend` interface with one
  implementation and a credential-resolver function with one implementation
  ([poc.md](poc.md) §4). **Nothing outside the broker constructs a model client or sees a key**,
  including throwaway code.
- **Dollar budget enforced in the broker, from this phase** (§15 Q3: a $50/month hard cap). Two
  counters where the tokens are already counted — per run and per calendar month — both set in
  `orc.config.ts`. Crossing either revokes the run's sentinels and lets in-flight requests drain;
  the run halts and reports rather than degrading to a cheaper model
  ([proxy-design.md](proxy-design.md) §3.8). The provider console's own spend limit is the outer
  backstop, set to the same number.
- `LocalDockerSandbox` via dockerode: one container per agent, no network but the broker, read-only
  root, writable `/workspace`.
- The runner inside the container as PID 1, driving `pi` and executing `verify` commands.
- Fresh clone per agent (D1), materialized by the runner.
- The sandbox image: `devcontainer build` run once by hand on the target repo, plus a derived layer
  with pinned pi, the runner and `@orc/pi` ([environments.md](environments.md) §5). No allowlist
  filter, no compose translation yet.
- Per-role tool policy enforced inside the sandbox by `@orc/pi`, from the frozen config the runner
  receives.
- The isolation test suite: from inside a live sandbox, dump every process environment, walk the
  filesystem, read the session JSONL; assert no real credential anywhere while model calls succeed.
  Plus the oracle check: an invalid upstream key yields the generic 502 and nothing else.

**Observability increment.** Cost becomes trustworthy: `gen_ai.client.token.usage` and
`orc.run.cost_usd` from the broker, replacing the provisional Pi-reported numbers.
`orc.model.cache_hit_ratio` per role, which is the first thing to check once a proxy sits in the
path — if caching stopped working, the cost model in [poc-v2.md](poc-v2.md) §8 is wrong.
`orc runs` lists runs with outcome, cost, turns and wall clock.

**Acceptance.**

1. A workflow with two agents in parallel completes with every agent in its own container.
2. The isolation test passes: no real credential in any environment, on any filesystem path, or in
   any session log, while model calls succeed.
3. A `deny`-listed tool is blocked inside the sandbox, asserted by a test that runs in the container.
4. Cache hit ratio through the broker matches direct calls for the same prompts, within noise.
5. `orc show <run>` reports a cost that reconciles with the provider's usage figures.
6. A run whose cap is set below its expected cost halts at the cap: its sentinels are dead
   immediately after, the run record says `budget_exceeded`, and no request after the halt reaches
   the upstream — asserted by a test, not observed.

**Settled here.**

- **Broker in TypeScript** for the prototype ([poc.md](poc.md) §6). Go is a v1 rewrite, not a
  phase.
- **The CLI is the control plane.** It mints sentinels, starts the broker, starts sandboxes and runs
  the workflow. No `orcd`.
- **The sandbox's one network route is a host process that serves both the model path and the
  control path.** That keeps "no network but the broker" literally true while the workflow still
  talks to the runner.

**Left open — the control channel between the workflow process and an in-container runner.**

| Option | How | For | Against |
| --- | --- | --- | --- |
| **stdio over the container's attached streams** (recommended) | dockerode attaches to PID 1's stdin/stdout; the runner speaks JSONL both ways, forwarding Pi's RPC verbatim plus its own commands (`verify`, `clone`) | Zero network surface; the runner is a thin multiplexer; matches how the runner drives Pi | One stream per container to keep healthy; reattach after a crash needs care |
| Runner connects out to the host process | The runner opens a connection to the same host process the broker runs in | Survives reattach naturally; becomes the mTLS channel on AWS | A second protocol on the broker's listener now; the sandbox's allowed route widens by one path |
| Runner listens; host connects in | Runner exposes a socket reachable only from the host | Conventional | Inbound listener inside the sandbox is a surface the design does not otherwise have |

Choose in this phase's detailed plan after a short spike on reattach behaviour, since phase 3's
resume depends on it.

**Spikes.**

- Does `pi` start cleanly with no network except the broker — no update check, no model-list fetch,
  no telemetry call that hangs a startup?
- Does SSE through a Node proxy preserve streaming and caching headers, or does something buffer?
- Reattach to a running container's stdio after the workflow process restarts.

---

## 6. Phase 3 — durability and a cheap dev loop

**Goal.** Make runs survive the things that kill them, and make developing against orc cost nothing
most of the time.

**What you can play with.** `kill -9` a sandbox mid-turn and watch `orc run` resume from the
persisted session rather than starting over. Run the test suite offline against recorded sessions.
Write a workflow test with mocked agents.

**Scope.**

- Session persistence: Pi's session JSONL streamed out of the sandbox to the run directory as it is
  written, not uploaded at exit. Resume onto a fresh sandbox from the persisted session.
- Step-level resume (phase 1) and session-level resume (this phase) composed: a run re-entered
  mid-slice skips finished steps *and* continues the interrupted session.
- `@orc/sdk/testing`: `testWorkflow` with `mockAgent` (level 1), and recorded-session replay
  (level 2) — real Pi JSONL captured once, replayed without a model
  ([plugin-api.md](plugin-api.md) §7).
- Fixture mode as a runner flag, so any workflow can run against recordings.
- Concurrency cap on sandboxes, enforced.
- `orc attach <agent>` for a live session, as a client of the runner — phase 0 found that a second
  Pi process on the same session file does not share it ([plan.md](plan.md) §8 D4).

**Observability increment.** `orc.step.cache` hit/miss, so resume can be seen saving what it should.
`orc.run.outcome` and `orc.run.escalations` with reason and phase — the headline quality signal
exists from here, even though nothing yet produces interesting escalations.

**Acceptance.**

1. Killing a sandbox mid-run and re-running resumes from the persisted session; the agent does not
   restart its task, and at most the last few JSONL entries are lost.
2. A workflow test with mocked agents runs in CI with no key and no Docker.
3. A recorded-session test detects a prompt change as a failing diff, without spending tokens.
4. Every phase-1 and phase-2 acceptance criterion still passes.

**Settled here.**

- **Recordings are Pi's JSONL, unmodified.** No parallel recording format.
- **Fixture mode is a runner flag, not a second runner.** Same code path, replayed input.

**Spikes.**

- What exactly is lost when a session is resumed mid-tool-call, and can the runner make that
  idempotent (re-issue the interrupted tool call, or mark the turn failed and re-prompt)?

---

## 7. Phase 4 — feature delivery, walking skeleton (S0)

**Goal.** The whole [poc-v2.md](poc-v2.md) workflow wired end to end with every role a stub
returning canned structured output. Proves the control flow, the artifact declarations, resume across
all phases, and every escalation path — on nothing.

**What you can play with.** `orc run feature-delivery --feature "..."` finishes in seconds. Watch
the phases go by, answer an escalation, re-run and see it skip to where you were. Edit a stub to emit
a `blocking` finding and watch the review loop iterate and cap.

**Scope.**

- Every phase from prevalidate to sign-off, in code, with the loop caps and escape hatches from the
  appendix of [poc-v2.md](poc-v2.md).
- Every artifact schema declared via `orc.step`: baseline, PRD, plan, findings, arbitration, test
  plan, runbook, slice graph, slice spec, review, sign-off.
- `orc.assertAcyclic` on the slice graph.
- One real model at one point only, to prove the seam: the ops role's "identify the test command"
  step, which is trivial and cheap.
- No fan-out, no merging, no scheduler. Slices are produced and listed, not executed.

**Observability increment.** Run, phase and step spans for the full shape, so a trace of the
skeleton looks like the tree in [observability.md](observability.md) §2. `orc.review.rounds` and
`orc.review.findings` by severity and round, emitted from the workflow engine — meaningless on stubs,
but the emission points are the expensive part and they are in place before any real reviewer runs.

**Acceptance.**

1. The workflow completes on stubs, producing every declared artifact in the run directory.
2. Each escalation trigger in [poc-v2.md](poc-v2.md) §6 can be provoked by a stub and resolved with
   each of `abort` / `proceed` / `amend`.
3. Resume from any phase boundary skips everything before it.
4. Cache invalidation is correct across the whole shape: changing one reviewer's prompt invalidates
   that review and the arbitration after it, and nothing before.
5. The workflow reads as the task, not as the API — poc.md's criterion 5, applied to the real thing.

**Settled here.**

- **Stubs are `mockAgent` from phase 3**, not a second stubbing mechanism.
- **The Decider interface exists from this phase** with one implementation, `LlmDecider`, used for
  finding severity. It returns canned values here; phase 5 gives it a real prompt. Jev is not in
  scope for any phase; see §13.

**Spikes.** None. This phase is assembly.

---

## 8. Phase 5 — real planning (S1)

**Goal.** Every planning role does real work. PM interview with a human, principal plans, architect
and security review under graded severity, principal arbitrates with written rationale, QA and ops
author their artifacts. The slice graph is produced and not executed.

**What you can play with.** Start a run, `orc attach pm`, be interviewed, get a PRD. Read the plan,
the findings, the arbitration record, the test plan and the runbook. Look at the review loop's
convergence in the run's metrics and decide whether it converged on quality or on agreement.

**Scope.**

- Skills under `.pi/skills/` for each planning role.
- Severity assigned by `LlmDecider` with a real prompt, uniformly across reviewers and rounds — one
  ruler ([decision-layer.md](decision-layer.md) §3.1).
- **The Jev shadow track begins.** `JevDecider` behind the same `Decider` interface, run *alongside*
  `LlmDecider` on the severity question only: Jev's grade is recorded and discarded, the LLM's is
  used ([decision-layer.md](decision-layer.md) §5). First step, before writing it: verify the API
  shape against TypeSafe's primary documentation — the description in decision-layer.md came from
  secondary sources. Severity is posed as a **Score over ordered levels**, not a Boolean, per the
  25× false-positive result recorded there.
- Arbitration artifacts carrying rationale for every accepted and rejected finding.
- Fresh principal session per phase, hydrated from artifacts ([poc-v2.md](poc-v2.md) §8).
- A **benchmark set**: three to five feature requests of varying size against the target repo,
  pinned by commit ([observability.md](observability.md) §5). Defined now, because this is the first
  phase whose output a human should read and compare.

**Observability increment.** The first real signal. `orc.review.rounds`, `orc.review.findings` by
severity and round, `orc.arbitration.decisions` accepted/rejected — the three that answer whether the
review loop produces signal or ceremony ([poc-v2.md](poc-v2.md) §10 item 6). Cost per planning run
against the estimate. From the shadow track: `orc.decision.agreement`, `orc.decision.confidence`
and `orc.decision.duration` on the severity question — the dataset that later decides whether Jev
grades for real.

**Acceptance.**

1. A human reads the PRD, plan, test plan and runbook for each benchmark item and finds them
   genuinely useful. This is a judgement and it is the exit criterion.
2. Round-by-round findings are recorded with severity; the run's metrics show whether severity
   fell across rounds or only the count did.
3. The arbitration record shows the principal rejecting at least some findings with rationale, on at
   least one benchmark item. A principal that accepts everything is not arbitrating.
4. `n ≥ 3` runs of one benchmark item on one configuration, and the spread is recorded.
5. After those runs, the shadow track has produced a **recorded finding**: Jev-vs-LLM agreement rate
   on severity, the confidence distribution, and the disagreements kept for reading. This is a
   deliverable, not a gate — the phase passes whatever the numbers say.

**Settled here.**

- **The PM phase is `orc attach`** (D4). No chat UI in the prototype.
- **Quality is read by a human** ([observability.md](observability.md) §7). No LLM judge over the
  artifacts.
- **Nothing in this or any later phase's acceptance depends on Jev.** It shadows. Promotion to
  Jev-decides is a judgement made from the observed distribution, per
  [decision-layer.md](decision-layer.md) §5, and is not a phase criterion.

**Spikes.**

- Does the attach path found in phase 0 hold up for a multi-turn interview, with the workflow
  process waiting on the PRD artifact?

---

## 9. Phase 6 — one real slice, two models, first comparison (S2)

**Goal.** Real execution of a single slice: feasibility negotiation, implementation on the cheap
tier, runner-verified tests, principal review, merge, re-verify. Two models in play. The first
configuration question is answerable.

**What you can play with.** A feature from the benchmark set lands as a merged commit on a local
branch, green on the merged tree. `orc compare` prints the three headline metrics grouped by config
hash, and you can flip the implementation model in one line and run the sweep again.

**Scope.**

- Senior feasibility loop with the principal, capped at 3, escalating on stall; spec approval before
  implementation.
- Implementation session on `claude-haiku-4-5` from a cleared context hydrated from the spec;
  feasibility on `claude-sonnet-5`. The model-catalog seam opens: `resolveModels()` returns two.
- `orc.verify` for slice tests and for the full suite on the merged tree.
- *Optional, if the phase 5 shadow is going well:* verify-failure triage (real / flake /
  environment / dependency) joins the shadow track here, since this is the first phase with real
  failures to classify ([decision-layer.md](decision-layer.md) §3.2). Shadow only; retries stay
  blind until promoted.
- Serialized integration for the single slice: merge to a local trunk branch, re-verify, principal
  review of the merged diff.
- **Package requests**, pnpm-only, exactly as [environments.md](environments.md) §6: a request
  resolved outside the sandbox, installed offline inside it, landing in the diff, with the lockfile
  reconciled at merge against approved requests. Escalates to a human for approval in the prototype.
- Dollar budget has been enforced in the broker since phase 2 (§15 Q3); the turn cap remains as
  the backstop against a loop that burns turns without spending much. The compare in this phase is
  sized to the cap: two configurations × three runs × one item, widened only if the spread demands.

**Observability increment.** `orc.slice.turns_to_green`, `orc.slice.verify_runs`,
`orc.slice.feasibility_rounds`, `orc.package.requests`. **`orc compare`**: reads run records, groups
by `orc.config.hash`, prints completion-without-escalation, cost per completed run, and human
interventions per run, with median and spread over `n ≥ 3`. This is the instrument the rest of the
project's empirical questions are answered with, and it arrives here because this is the first phase
with a question worth spending real runs on.

**Acceptance.**

1. One benchmark slice completes end to end: green slice tests, merged, green on the merged tree,
   approved by the principal, with every green traceable to a `verify` artifact.
2. A `verify` result cannot be produced by the agent — asserted by a test that has the agent try.
3. A package request lands in the diff as a manifest and lockfile change and nowhere else; a
   hand-edited manifest fails reconciliation at merge.
4. `orc compare` prints the three headline metrics for Haiku-vs-Sonnet on implementation, over at
   least three runs each of at least one benchmark item, and the result is recorded in
   [poc-v2.md](poc-v2.md) §10 item 8 either way.

**Settled here.**

- **Models per role are those in [poc-v2.md](poc-v2.md) §8.** The first thing to change if the
  measurement says so is the implementation model, and it is a one-line change.
- **The trunk is a local branch.** No pull request, no GitHub, no push in the prototype.

**Spikes.**

- Can Haiku 4.5 carry a whole slice? This phase *is* the spike; turns-to-green is the measurement.
- Is the 50K-token average context in the cost estimate real? Measure context growth per turn.

---

## 10. Phase 7 — the scheduler (S3)

**Goal.** Many slices, capability-level dependencies, concurrency, serialized integration with
author-resolved conflicts, blocked-subgraph failure handling. The claim under test is that a
dependency-scheduled fleet converges.

**What you can play with.** A benchmark feature with a real dependency chain: two slices running at
once, one waiting on another, at least one genuine merge conflict resolved by the slice's own senior
without a human, and a failed slice that blocks its dependents while the rest of the graph finishes.

**Scope.**

- `orc.schedule` over the slice DAG: ready = all `dependsOn` merged; `maxConcurrency`; cycle
  rejection already in place from phase 4.
- Serialized `ctx.integrate` with conflict resolution by the implementation session, re-verify on
  the merged tree, principal review, `ctx.land`.
- Failure semantics: a failed slice blocks its transitive dependents; independent subgraphs continue;
  the run escalates with full state at the end ([poc-v2.md](poc-v2.md) §2).
- Environment build pipeline pieces deferred from phase 2: the `devcontainer.json` allowlist filter
  folded into the policy hash, compose services as sidecars in the agent's network namespace, image
  cache keyed on `.devcontainer/**` plus lockfiles ([environments.md](environments.md) §3–4, §7).
- Durable run records carrying the commit shas each slice and run produced
  ([observability.md](observability.md) §7) — free now, unrecoverable later.

**Observability increment.** `orc.merge.conflicts` by who resolved it, `orc.merge.reverify.duration`,
`orc.slice.diff_lines` and `orc.slice.files_changed`. These are the instruments for slice
granularity and conflict rate, the two open items with the highest stakes and no data
([poc-v2.md](poc-v2.md) §10 items 1–2).

**Acceptance.**

1. A benchmark feature with at least two concurrent slices and one dependency edge completes.
2. At least one genuine merge conflict is resolved by the slice's senior and passes re-verify and
   review without human help.
3. A deliberately failed slice blocks only its dependents; the run ends with an escalation that
   names what merged, what blocked, and why.
4. A repo whose devcontainer uses a compose service runs its integration tests against that service
   as a sidecar, with the agent holding no Docker access.
5. Every landed slice's run record carries its merge commit sha.

**Settled here.**

- **Conflicts are resolved by the implementation session, on the cheap tier**, gated by re-verify
  and Sonnet review ([poc-v2.md](poc-v2.md) §8). If that is where Haiku fails, the narrow fix is a
  Sonnet session hydrated from the spec for conflicts only — and conflict triage
  (mechanical / semantic / ambiguous) is the shadow-track candidate that would let that fix route
  only *semantic* conflicts to the expensive session. It joins the shadow here at the earliest, as
  an option, once `ctx.integrate` exists to observe.
- **Merges are serialized.** One integration at a time, no exceptions, so the re-verify tail is
  measured before anyone tries to optimize it.

**Spikes.**

- Conflict rate on the benchmark set. Unknown until measured; decides whether granularity guidance
  needs work before phase 8.
- Does the re-verify tail dominate at three concurrent slices on the target repo's suite?

---

## 11. Phase 8 — fan-out and sign-offs (S4)

**Goal.** The complete workflow. Subslices on the light tier in the senior's tree, QA and ops gates
that cite evidence from commands that ran, and the final artifact bundle.

**What you can play with.** The whole thing, on the whole benchmark set: PRD to runbook, with a
coverage report and a metrics grep deciding sign-off rather than an opinion.

**Scope.**

- Subslices run sequentially in the senior's workspace by sub-agents on `claude-haiku-4-5`
  ([poc-v2.md](poc-v2.md) §2). One trivial subslice proven before the tier is built out.
- QA sign-off against a `verify`-produced coverage report; ops sign-off against a `verify`-produced
  search for the runbook's named metrics.
- Final artifact assembly: PRD, plan, test plan, runbook, metrics, rollback plan.
- Custom metrics as declared commands under `orc.custom.*`, carrying the config hash
  ([observability.md](observability.md) §8) — small, and the point at which a user can measure
  something orc did not anticipate.

**Observability increment.** Nothing new to emit; the whole instrument is exercised across the whole
workflow. A full sweep on the benchmark set — several configurations, `n ≥ 3` each — with the results
written back into the open items of the docs they answer.

**Acceptance.**

1. The full workflow completes on every benchmark item under the default configuration.
2. Every gate in [poc-v2.md](poc-v2.md) §5's table points at a `verify` artifact; a gate that
   cannot is advisory and provably does not block.
3. A sub-agent completes a trivial subslice before any other subslice work is attempted.
4. One sweep's results are recorded against the empirical open items in poc-v2.md §10 and
   observability.md, with each item either answered or restated with the measured spread.

**Settled here.**

- **This is the finish line for the prototype**, subject to the question in §14. Everything in §12
  is after it.

---

## 12. After the prototype — not phases, just seams

Listed so no phase above accidentally closes one. Each is deferred behind a seam named in
[poc.md](poc.md) §4, and none needs a decision before phase 8.

| Deferred | The seam that keeps it cheap |
| --- | --- |
| Egress gateway: CONNECT, MITM, per-host credential injection | Additive; nothing above assumes it |
| AWS: Fargate sandboxes, DynamoDB, S3, `orcd` as a service | `Sandbox`, `RunStore`, `SessionStore` interfaces; the CLI-as-control-plane split |
| SigV4 via Claude Platform on AWS or Bedrock | The credential-resolver function in the broker |
| Model catalog from the broker | `resolveModels()` |
| `orc.config.ts` as its own file, policy approval, `orc policy diff` | `defineConfig` already produces the frozen value |
| Dollar budget enforced in the broker | The counter already increments there |
| LLM-driven orchestration (`orc_*` tools) | Thin wrappers over the same runner calls the SDK uses |
| Console, connectors, escalation routing | The run directory is already the readable surface |
| ~~Jev as a `Decider` implementation~~ | **Moved into the prototype** — §15 Q8 answered yes. Shadow track from phase 5; nothing gates on it |
| Broker rewrite in Go | The prototype's broker intercepts nothing |

---

## 13. Decisions this document makes

Below D-level. If any of these turns out to be architectural, promote it to [plan.md](plan.md) §8
with a number, per the convention there.

| Decision | Phase | Why it is obvious |
| --- | --- | --- |
| Spikes are disposable, outside `packages/` | 0 | Foundations built during a spike are foundations built on an unproved assumption |
| pnpm monorepo, Node 22, vitest | 1 | The docs already assume TypeScript, pnpm and Node 22 |
| Runner is a library behind a `Sandbox` seam; `LocalProcessSandbox` then `LocalDockerSandbox` | 1, 2 | poc.md §4 names the seam; this just says the first implementation is a bare process |
| The run directory is the readable surface; layout fixed and versioned in phase 1 | 1 | Resume, `orc compare` and the console all read it; console.md §7 |
| `orc.config.hash` stamped on every record from the first run | 1 | The join key for every comparison; costs nothing now |
| Escalation is a terminal prompt throughout | 1 | D4 |
| One model until real implementation; two from phase 6 | 1, 6 | poc-v2.md §9 |
| Broker in TypeScript; CLI is the control plane; no `orcd` | 2 | poc.md §5–6 |
| Recordings are Pi's JSONL; fixture mode is a runner flag | 3 | plugin-api.md §7; no parallel format |
| Stubs are `mockAgent`; `Decider` exists from S0 with only `LlmDecider` | 4 | One stubbing mechanism; the interface is cheaper to have from the start than to retrofit |
| PM is `orc attach`; quality is read by a human | 5 | D4; observability.md §7 |
| Local trunk branch; no PRs or pushes in the prototype | 6 | Nothing GitHub-shaped is in scope |
| Merges serialized; conflicts resolved by the implementation session | 7 | poc-v2.md §2, §8 |
| `JevDecider` shadows `LlmDecider` on severity from phase 5; no acceptance depends on it | 5 | §15 Q8 answered yes; decision-layer.md §5 says shadow before trusting |

## 14. Decisions left open, with options

Each is settled in the named phase's detailed plan, not here.

| Decision | Phase | Options (recommended first) | What decides it |
| --- | --- | --- | --- |
| Structured-output mechanism for `ask()` | 0 | Submit tool · parse final message · provider structured outputs | The phase 0 spike |
| ~~Where telemetry lands~~ | 1 | **Settled: in-process JSONL in the run dir; OTLP as a flag** ([phases/phase-1.md](phases/phase-1.md) §2.1) | Q6: no Docker, so no collector on the dev loop |
| Control channel to an in-container runner | 2 | Attached stdio · runner connects out · runner listens | The reattach spike |
| ~~Target repository (§15, Q1)~~ | — | **Settled 2026-09-21: `randadam/tudu`, a hand-seeded to-do app fixture** ([fixture.md](fixture.md)) | The author |
| Where the prototype ends (§15, Q2) | — | Phase 8 · phase 6 · phase 7 | The author |
| Benchmark set contents | 5 | Depends on the target repo | Chosen with the repo |
| Which questions are promoted to Jev, and when | 5–8 | Severity first · then verify-failure and conflict triage if severity's agreement holds · none | The observed agreement rate and confidence distribution from the shadow track, not a phase boundary |

## 15. Questions for the author

These are not answerable from the existing docs, and several change the plan above. Answers get
recorded here, struck through with the decision, per the convention in CLAUDE.md.

1. ~~**Which repository is the prototype target?**~~ **Answered 2026-09-21: `randadam/tudu`**
   (renamed from `aib` the same day), **seeded by hand as a purpose-built fixture: a to-do app.**
   Simple enough to seed in a day, open-ended enough to keep adding features to. On inspection the
   repository was empty (zero refs, zero objects), so seeding is the first piece of work rather
   than a further decision; what the seed must contain to exercise every phase is
   [fixture.md](fixture.md). TypeScript + pnpm, so the guard list and pre-baked image plan hold as
   written. The original question, for the record:
   Three shapes, with different costs:
   - *A purpose-built fixture repo*: small TypeScript service, fast pnpm test suite, a devcontainer
     you control, and seeded feature requests. Deterministic and cheap to benchmark; artificial, so it
     may hide real-world friction (slow suites, odd `postCreateCommand`s).
   - *An existing open-source TypeScript repo*: realistic; but its devcontainer may not exist or may
     not prebuild, and its suite may be slow enough to dominate re-verify.
   - *orc itself*: dogfooding from phase 4; but a bug in orc then breaks both the tool and the target
     at once, which makes failures hard to attribute.
   A reasonable split is the fixture through phase 6 and something real from phase 7, when conflict
   rate and re-verify cost need a real codebase to mean anything. Which do you want, and do you have
   a candidate for the real one?
2. **Where does the prototype end?** This document assumes phase 8. If the goal is "prove the design
   and answer the Haiku question," phase 6 is a defensible stop and phases 7–8 become the next
   project. Which? *(Explained to the author 2026-09-21; pending. The $50/month cap under Q3 bears
   on it — see there.)*
3. ~~**What is the real-model budget?**~~ **Answered 2026-09-21: $50 per month, hard cap, to
   start.** Four consequences, all now in the plan:
   - **Dollar-budget enforcement in the broker moves to phase 2.** A cap enforced by watching a
     billing page is not a hard cap. Per-run and per-month counters where the tokens are already
     counted; crossing either revokes sentinels and halts the run ([phases.md](phases.md) §5). The
     provider console's own spend limit is set to the same number as the outer backstop.
   - **The full phase 6 sweep does not fit in a month.** 45 runs at ~$2–3 is $90–135. Phase 6's
     *acceptance* — two configurations × three runs × one benchmark item, ~6 runs, ~$12–18 — does.
     Anything beyond that is shrunk or spread across months; the compare is answered on the minimum
     and widened only if the spread demands it.
   - **Phase 3's recorded mode is leaned on hard.** Every dev-loop iteration that can replay, does.
   - **Turn caps stay as the backstop** for loops that burn turns without spending much.
4. **Which empirical question do you want answered first?** The docs name two front-runners: can
   Haiku carry implementation (answerable at phase 6), and does the review loop converge on quality
   (answerable at phase 5). The order above answers the second first because planning comes before
   execution. If the Haiku question matters more, phase 5 can be thinned to a minimum and phase 6
   pulled forward.
5. ~~**Which Pi version are you tracking?**~~ **Answered 2026-09-21: latest stable — as a pinning
   policy, not a floating version.** Pin the latest stable release at the start of phase 0; every
   later phase pins the same; re-pinning is a deliberate act that re-runs the phase 0 spikes. Never
   `latest` in a manifest. Evidence for why this matters: between 2026-09-18 and 2026-09-21 Pi went
   `0.85.1 → 0.86.0 → 0.86.1` — two minor releases in three days. **Pinned: `0.86.1`**
   ([phases/phase-0.md](phases/phase-0.md) §1).
6. **What is the development environment?** Docker available locally (Desktop, or Linux with
   rootless?), and is the `devcontainer` CLI acceptable as a build-time dependency? Phase 2 assumes
   both.
7. **Is a direct Anthropic API key the credential for the whole prototype?** The docs say start on
   keys and the broker owns the only copy. Confirm no AWS account is in scope before phase 8, so
   nothing is built for it.
8. ~~**Is Jev access actually in hand?**~~ **Answered yes, 2026-09-21.** A shadow track on finding
   severity runs beside phases 5–8 at no cost to the sequence; the Jev row leaves §12. Nothing in
   any phase's acceptance depends on it. Which access surface (direct API, OpenRouter, a gateway) is
   still unconfirmed — [decision-layer.md](decision-layer.md) §7.
9. ~~**Who implements each phase?**~~ **Answered 2026-09-21: the author does.** Executable
   acceptance suites and a byte-level phase 1 run-directory layout are **adopted anyway**, on their
   own merit rather than because of who executes: a phase gate that is *reported* met — by a person
   or a model — is the self-report problem the design guards against at runtime, and an exit code
   is not. Phase 0 already follows this ([phases/phase-0.md](phases/phase-0.md) §5); every later
   phase plan does too.
10. ~~**Is one human the only user throughout?**~~ **Answered 2026-09-21: single user for now.**
    No identity field in phase 1; escalation records carry no attribution. The cost accepted is the
    migration described in [console.md](console.md) §5 when a second person arrives, which is the
    console's problem to solve, not the prototype's.

---

## 16. Open items

1. **Phase sizing.** No phase carries an estimate. The detailed plans set them; this document only
   orders. Phases 5–8 are the ones whose size depends most on the answers in §15.
2. **Vocabulary.** Weeks 0–3 and S0–S4 remain in poc.md and poc-v2.md as the record of how the
   scope was cut. This document's phase numbers are the sequence to plan against; the mapping is in
   §2. If the two ever disagree on content, poc.md and poc-v2.md are the scope authority and this
   document is the order authority.
3. **The benchmark set is undefined** until the target repository is chosen. It is a phase 5
   deliverable, but it constrains the fixture repo's design if the fixture option is taken in Q1, so
   it may need sketching earlier.
