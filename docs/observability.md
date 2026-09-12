# Observability — measuring configurations against each other

Most of what is unresolved about orc is **empirical**, not architectural. Is a slice the right size?
Does the PRD loop converge on quality or merely on agreement? Can Haiku carry implementation? Every
one of those is a hypothesis, and none can be settled by argument.

This document specifies the instrument. It is not a dashboard project — it exists so that
"configuration A is better than configuration B" becomes a sentence with evidence behind it.

---

## 1. What a "configuration" is

Comparison is meaningless without a stable identity for the thing being compared. A configuration is
the full set of choices that could plausibly change an outcome:

| Dimension | Example |
| --- | --- |
| Model per role | senior-impl on Haiku vs Sonnet |
| Effort level | Sonnet roles at `low` vs `high` |
| Iteration caps | PRD loop 5 vs 3; feasibility 3 vs 2 |
| Slice granularity guidance | the prompt that tells the principal how finely to cut |
| Concurrency | `maxConcurrency` 1 vs 3 |
| Prompt and skill content | any edit to `.pi/skills/**` |

**orc already has an identity for exactly this set: the policy hash** — the frozen `orc.config.ts`
snapshot plus the content hashes of every loaded extension and skill
([plan.md](plan.md) D2, [plugin-api.md](plugin-api.md) §6). Reuse it rather than inventing a second
notion of identity that can drift from it.

Every span and metric carries `orc.config.hash` plus the individual dimensions as separate
attributes, so you can group by the whole configuration or slice along one axis.

---

## 2. Two signals, two jobs

**Traces answer "what happened in this run."** One trace per run, spans nesting naturally:

```
run
├── phase: prd
│   └── agent: pm                      (many turns)
├── phase: plan
│   ├── agent: principal → plan
│   ├── agent: architect → findings    ⟍ concurrent
│   ├── agent: security  → findings    ⟋
│   └── agent: principal → arbitration (round 1..n)
├── phase: slices
└── phase: build
    ├── slice: auth-api
    │   ├── agent: senior (feasibility)
    │   ├── agent: senior-impl
    │   │   ├── tool: edit
    │   │   ├── tool: bash
    │   │   └── verify: slice-tests    ← exit code lives here
    │   ├── integrate (conflicts: 2)
    │   └── agent: principal (review)
    └── slice: auth-ui
```

**Metrics answer "is this configuration better."** Aggregation across runs is metric-shaped, and the
interesting quantities (turns-to-green, conflict rate) are derived. Emit them **explicitly at the
point they are known** — at slice completion, at merge — rather than reconstructing them from trace
structure later. Derived-from-traces analysis is fragile and expensive to query; an explicit
histogram is neither.

Emit both. Traces diagnose a bad run; metrics decide between configurations.

---

## 3. Instrument the runner and the broker, never the agent

The same principle that governs verification (§4 of [poc-v2.md](poc-v2.md)) governs telemetry:
**a number the model can author is not evidence.**

An agent asked to report its own turn count, token usage, or success has every incentive and
opportunity to be wrong — not maliciously, just unreliably. So nothing inside the sandbox emits
metrics that matter.

| Emitter | What it knows | Why it is trustworthy |
| --- | --- | --- |
| **Workflow engine** (`orc-sdk`) | Run, phase, step boundaries; escalations; step cache hits | It *is* the control flow |
| **Runner** | Agent turns, tool calls, durations, verify exit codes | Derives everything from Pi's RPC event stream (`agent_start`, `turn_start`, `tool_execution_*`, `agent_end`) — the agent is observed, not consulted |
| **Broker** | Every token, every cache hit, every dollar | It is the only path to a model, and already counts tokens for budget enforcement |
| **Integration step** | Conflicts, files changed, diff size, re-verify results | Reads git, not the agent's account of git |

Two consequences worth noting.

**Pi needs no instrumentation.** The runner already consumes Pi's RPC event stream to drive the
agent, and those events are exactly the span boundaries we want. No upstream dependency, no fork, no
reliance on Pi's own telemetry settings.

**The broker is the natural cost chokepoint.** It sees every token in both directions because it has
to, for budget enforcement. Cost metrics come from there for free, and cannot be misreported by a
sandbox.

Trace context crosses the plane boundary as W3C `traceparent` on the runner's calls to the broker
and to the control plane, so a model call appears under the tool call that caused it.

---

## 4. The metric set

Borrow `gen_ai.*` where the conventions cover it; use `orc.*` for orchestration concepts they do not
model.

### Borrowed — GenAI semantic conventions

The conventions model workflows, agents and tools, not just model calls:

| Metric | Use |
| --- | --- |
| `gen_ai.client.token.usage` | Tokens, split by `gen_ai.token.type` — the input for cost and cache-hit ratio |
| `gen_ai.client.operation.duration` | Per-model-call latency |
| `gen_ai.invoke_agent.duration` | Per-agent wall clock |
| `gen_ai.invoke_agent.inference_calls` | Turns per agent — the denominator for most efficiency questions |
| `gen_ai.invoke_agent.tool_calls` | Tool calls per agent — where a weak model's thrashing shows first |
| `gen_ai.execute_tool.duration` | Per-tool cost, and which tools dominate |
| `gen_ai.invoke_workflow.duration` | Run wall clock |

Core attributes: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.response.model`, `gen_ai.agent.name`, `gen_ai.tool.name`, `error.type`.

**These conventions are still in Development status** — as of mid-2026 nothing `gen_ai.*` is marked
Stable, and they now live in a dedicated repository split out of the main semantic-conventions repo
(v1.42.0). The core shape (operation, provider, model, token usage) has held since v1.37.0, which is
enough to build on, but **pin the convention version** and keep the comparison logic in §5 anchored
on `orc.*` names. A rename upstream should cost a dashboard, never an analysis.

### Ours — `orc.*`

Each of these exists to close a specific open question:

| Metric | Attributes | Question it answers |
| --- | --- | --- |
| `orc.run.outcome` | outcome, config.hash | Does this configuration finish at all? |
| `orc.run.cost_usd` | config.hash | Cost per run, from broker token counts |
| `orc.run.escalations` | reason, phase | **The headline quality signal** — where humans get pulled in |
| `orc.slice.turns_to_green` | role, model, slice.id | Can Haiku carry implementation? (poc-v2 open item 8) |
| `orc.slice.verify_runs` | outcome | How many test cycles a slice needs |
| `orc.slice.diff_lines`, `orc.slice.files_changed` | slice.id | Slice granularity — is the cut the right size? (item 1) |
| `orc.slice.feasibility_rounds` | slice.id | Is the senior/principal negotiation converging? |
| `orc.review.rounds` | phase | Does the PRD loop converge, or hit the cap? |
| `orc.review.findings` | severity, round | **Do findings weaken across rounds, or just stop?** (item 5) |
| `orc.arbitration.decisions` | accepted/rejected | Is the principal actually arbitrating, or rubber-stamping? |
| `orc.merge.conflicts` | resolved_by | Conflict rate, and who resolved it (item 2) |
| `orc.merge.reverify.duration` | — | Does the re-verify tail dominate? (item 3) |
| `orc.model.cache_hit_ratio` | role, model | Is the caching discipline actually working? |
| `orc.package.requests` | decision, ecosystem | How often agents need unplanned dependencies |
| `orc.step.cache` | hit/miss | Whether resume is saving what it should |

`orc.review.findings` split by severity *and round* is the one I would build first. It directly tests
whether the review loop produces signal or ceremony — if round-5 findings are merely fewer rather
than genuinely less severe, the loop is converging on agreement, and no amount of raising the cap
will fix that.

---

## 5. Comparing configurations is a method, not a metric

The instrument is the easy half. Using it correctly is where this goes wrong.

**Hold the input constant.** A configuration comparison requires the same feature request, the same
repository, the same base commit. A fixed benchmark set of 3–5 feature requests of varying size,
pinned by commit, is the minimum. Comparing runs over different inputs measures the inputs.

**Repeat.** Agent runs have high variance — same config, same input, materially different
trajectories. A single run per configuration is an anecdote. **n ≥ 3**, and report the median with
the spread, not the mean. If the spread across identical configs exceeds the gap between
configurations, the comparison has not concluded anything.

**Recorded fixtures cannot be used here.** They are deterministic by design, so replaying them
measures nothing about model behavior. Fixture mode makes *development* nearly free
([poc.md](poc.md) §4); configuration comparison spends real money. Budget for it deliberately —
a 5-config × 3-repeat sweep over 3 tasks is 45 real runs.

**Three headline metrics, everything else diagnostic:**

1. **Completion without escalation** — the success rate. A configuration that finishes half its runs
   is not cheaper, whatever the per-turn price.
2. **Cost per *completed* run** — not per run, and certainly not per turn. A cheaper model that needs
   more turns, more retries, or more human help is not cheaper. This is the metric that will
   adjudicate the Haiku-for-implementation decision.
3. **Human interventions per run** — escalations are the real cost of a weak configuration, and they
   are denominated in the scarcest resource involved.

Resist the urge to build a composite score. Three numbers that each mean something beat one number
that means nothing.

---

## 6. In the POC

Use the real OTEL SDK from the start — the instrumentation points are the same either way, and
retrofitting them is the expensive part. Keep the backend trivial:

- OTLP export to a **local collector**, writing to files. No hosted backend, no dashboards.
- `orc compare` reads the run records and prints a table grouped by `orc.config.hash`: the three
  headline metrics plus whichever diagnostic columns are asked for.
- Traces to a local Jaeger only when diagnosing a specific bad run.

S0 gets run/phase/step spans and `orc.run.*` — enough to see the skeleton work. The slice and merge
metrics arrive with the scheduler at S3, since before that there is nothing to aggregate. The three
headline metrics should be printable by the end of S2, because that is when the first real
configuration question (Haiku vs Sonnet for implementation) becomes answerable.

---

## 7. Open items

1. **Cost attribution for cache writes.** A cache write costs 1.25×, and the run that pays it is not
   necessarily the run that benefits. Per-run cost is therefore slightly unfair across a sweep;
   whether that matters at these magnitudes is untested.
2. **Escalation count is a proxy, not a measure, of quality.** A configuration that escalates rarely
   might be good, or might be failing silently in ways no gate catches. Pair it with a periodic human
   read of the output artifacts — the metric cannot replace that.
3. **No quality metric for the artifacts themselves.** Nothing here scores whether the PRD is any
   good or the runbook is usable. An LLM-judge over artifacts is the obvious idea and inherits every
   problem of LLM review gates ([poc-v2.md](poc-v2.md) §5); a small human-rated sample is more
   honest and does not scale. Unresolved.
4. **GenAI conventions may drift** while in Development status. Pinned version plus `orc.*`-anchored
   analysis is the mitigation, not a fix.
