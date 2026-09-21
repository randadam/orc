# orc — orientation

Read this first. It exists so a session with no prior context can pick up the design without
re-deriving it or re-litigating settled questions.

**Status: design complete, implementation not started.** Eleven documents, no code.

---

## Reading order

1. **[docs/plan.md](docs/plan.md)** — architecture, components, decisions (§8), open questions (§9).
   The decisions in §8 are the spine; everything else elaborates them.
2. **[docs/phases.md](docs/phases.md)** — the build order. Nine playable phases, each with scope and
   acceptance criteria, plus the decisions settled and left open per phase. **Start here for
   implementation**; each phase gets its own detailed plan from this.
3. **[docs/poc.md](docs/poc.md)** — POC v1. What gets built first and what is deliberately deferred
   behind named seams. Scope authority for phases 0–3.
4. **[docs/poc-v2.md](docs/poc-v2.md)** — the feature-delivery workflow v1 is a skeleton of. Scope
   authority for phases 4–8.
5. The rest as needed: [proxy-design](docs/proxy-design.md) (the broker),
   [plugin-api](docs/plugin-api.md) (the SDK surface), [environments](docs/environments.md)
   (dev containers), [observability](docs/observability.md) (metrics),
   [console](docs/console.md) (UI and connectors), [decision-layer](docs/decision-layer.md) (Jev),
   [fixture](docs/fixture.md) (what the `tudu` seed must contain).

---

## What is decided

Recorded in [docs/plan.md](docs/plan.md) §8 with full reasoning. **Do not reopen these without new
information** — each was argued through and several replaced an earlier wrong answer.

| | Decision |
| --- | --- |
| **D1** | Fresh clone per agent; no shared filesystem. Fan-in via artifacts and diffs. |
| **D2** | TypeScript everywhere, no YAML. `orc.config.ts` is policy evaluated once and frozen; `.pi/extensions/*.ts` is logic. Runtime may narrow policy, never widen. |
| **D3** | Code-driven orchestration is the default; LLM-driven is deferred past the POC. |
| **D4** | Human-in-the-loop is `orc.escalate` plus `orc attach`. |
| **D5** | Sandbox environments come from the repo's `.devcontainer/`, built outside the sandbox. |
| **D6** | OpenTelemetry, emitted from runner and broker — never from inside a sandbox. |
| **D7** | The console is a client of a shared intake/interaction/observation surface. |
| **D8** | A `Decider` interface; Jev is one implementation, an LLM is the other. |

### Principles that recur

These decided several arguments each, and are the ones to reason from when something new comes up:

- **A number the model can author is not evidence.** "Green" is an exit code from the runner. This
  governs verification, telemetry, and the decision layer alike.
- **Cheap where the gate is objective; reliable where the output is only judged by another model.**
  Why Haiku implements and Sonnet plans.
- **Containment, not prevention.** Prompt injection is assumed, not defended against. Every security
  property is about blast radius.
- **Policy is frozen before agents run**, so a plugin cannot widen its own permissions mid-run.
- **One seam per deferred decision**, and a seam is a function signature with one implementation —
  not a registry, not a config surface.

### Rejected, with reasons — do not reintroduce

- **YAML orchestration** — cannot express loops back to earlier phases or escape hatches on
  accumulated state (plan.md D2).
- **File-level write scoping on slices** — you cannot predict which files solving a problem needs;
  blocking an agent at a filesystem boundary is worse than a merge conflict (poc-v2.md §2).
- **Lanes as a scheduling primitive** — a Gantt chart renders a schedule, it is not one. The DAG is
  the model (poc-v2.md §2).
- **Contracts-first slice 0** — coupling is behavioural, not just schemas.
- **LLM judges over output artifacts** — inherits every failure mode of LLM review gates
  (observability.md §7).

---

## The one thing blocking a start

**Nothing, any more, waits on a decision.** The target is **`randadam/tudu`** — empty as of
2026-09-21, to be **seeded by hand as a to-do app fixture** per [docs/fixture.md](docs/fixture.md).
That seed is the first piece of *work* after phase 0, and phase 1's first real run needs it at the
commit phase 1 pins. Of the ten §15 questions only Q2 (phase 6 or phase 8 as the stop) is open, and
it sizes phases 7–8 rather than blocking them.

**The real-model budget is $50/month, hard cap** (§15 Q3). Dollar enforcement lives in the broker
from phase 2; the full phase 6 sweep does not fit a month and is answered on the minimum compare.

Two architectural questions remain genuinely open but do not block: the model backend (plan.md §9)
and target scale.

**Start on direct API keys.** Moving to SigV4 later — Claude Platform on AWS, or Bedrock — is a
credential resolver and a base URL in the broker, with the sandbox, runner and workflows untouched.
The only discipline that keeps it that cheap: **nothing outside the broker ever constructs a model
client or sees a key**, even in throwaway prototype code. Shortcut that and a one-function change
becomes a refactor.

---

## Three staging vocabularies, and one of them is the order

Easy to confuse — they are phases of different things:

- **poc.md §7 uses Weeks 0–3.** That is POC v1: the plumbing. Week 0 is a spike that can kill the
  design (can Pi's `tool_call` hook actually veto a tool?), then SDK, sandboxes, broker, resume.
- **poc-v2.md §9 uses S0–S4.** That is the feature-delivery workflow, built *after* v1 stands. S0 is
  a stubbed walking skeleton; S2 is the first real implementation; S3 adds the scheduler.
- **phases.md uses Phases 0–8**, which is Weeks 0–3 followed by S0–S4 as one sequence, with an
  observability increment attached to each. The mapping table is in phases.md §2.

Weeks first, then stages. **Plan against the phase numbers**; poc.md and poc-v2.md remain the record
of how scope was cut, and phases.md is the record of the order.

---

## Open items: triage

Roughly 30 across the docs, each listed at the end of its own document. They are not equivalent:

- **Blocking:** nothing awaits a decision. The first work item is seeding `tudu`
  ([docs/fixture.md](docs/fixture.md)). phases.md §15 holds the ten questions put to the author;
  nine are struck through, Q2 is pending and non-blocking.
- **Empirical** — need a real run, not a decision. Slice granularity, conflict rate, whether Haiku
  can carry implementation, whether the PRD loop converges on quality or merely agreement.
  [docs/observability.md](docs/observability.md) is the instrument built to answer them, and names
  the metric for each.
- **Later** — post-POC by design: connectors, the metrics console, incident attachment, egress
  gateway hardening, AWS deployment.

When an open item is settled, record it where it lives and say what decided it. Several items in
these docs are struck through with the answer rather than deleted, which is the pattern to follow.

---

## Conventions

- **Docs are design docs**, not specs to implement literally. Code samples show intent and API
  shape; they are not copy-paste targets.
- **Decisions live in plan.md §8.** A new decision gets a D-number there plus detail in the relevant
  doc — not one or the other.
- **Every doc ends with its own open items.** Keep that; it is how the triage above stays honest.
- **Detailed phase plans live in `docs/phases/phase-N.md`.** phases.md is the order authority; a
  phase plan is the execution authority for its phase and opens by stating which §15 questions it
  assumes answers to. Phase 0 is written; it depends on almost none of them.
- **Cross-references use a relative markdown link plus a section number.** Section numbers have been renumbered a few times,
  so verify a reference resolves before trusting it.
- Prose over bullets where reasoning matters. The reasoning is the valuable part — several of these
  decisions replaced a plausible wrong answer, and the record of *why* is what stops it coming back.

---

## How work is cut

**Plan in small slices that are independently deliverable and verifiable end to end.** This applies
to every phase plan, to orc's own implementation, and to the benchmark features — the same rule at
every level.

A slice qualifies when all three hold:

1. **Deliverable on its own.** It merges and is useful without waiting on sibling slices. If it only
   makes sense once three others land, it is a fragment, not a slice — recut.
2. **Verifiable end to end** by something that exits 0 or 1: a test, a script, a `verify` command.
   Not "reviewed and looks right." A slice with no executable check is not done being planned.
3. **Small enough for a small context window.** The spec, the code it touches and its tests should
   be readable in one session without compaction. This is a hard constraint, not a preference: the
   implementation tier is Haiku, implementation starts from a cleared context hydrated from the
   spec, and a slice that overflows that context fails in ways that look like model weakness and
   are actually planning weakness.

When a piece of work does not fit, the answer is to cut it smaller or to add a dependency edge — not
to make the slice bigger and hope. Phase 0's spikes already follow this shape (one script, one
question, one exit code each); every phase plan from phase 1 on is written the same way.

---

## Code conventions

**Documentation lives in `docs/`. Comments are not documentation.** Code comments are limited to
exactly two kinds:

1. **Docstrings** — JSDoc on exported symbols: what it is, what it takes, what it returns.
2. **One-liners about critical gotchas** — a single line where the next reader would otherwise
   break something: an ordering constraint, a non-obvious invariant, a thing that looks wrong on
   purpose.

Nothing else. No paragraphs explaining how a block of code works — if it needs a paragraph, the code
needs restructuring or the explanation belongs in a doc. No design decisions inlined as comments —
decisions live in [docs/plan.md](docs/plan.md) §8, and the reasoning behind a module lives in the
doc that specifies it. A comment that restates the code is noise; a comment that explains a
decision is a doc in the wrong place.
