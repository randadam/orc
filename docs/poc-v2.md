# POC v2 — the feature-delivery workflow

[poc.md](poc.md) defines POC v1: the smallest thing that proves the harness fits, `tool_call` can
veto, credentials stay out of sandboxes, and imperative orchestration reads well. This document
defines **v2** — the workflow that makes orc worth using, built on v1's skeleton once it stands.

It is the same four claims under real load, plus two new ones: that a dependency-scheduled fleet
converges, and that LLM review gates produce signal rather than ceremony.

---

## 1. The shape

```
prompt + repo
   │
   ├─ 0. prevalidate ──────────── baseline must be green, else escalate
   │
   ├─ 1. PM  ⇄ human ──────────── PRD                          [interactive]
   │
   ├─ 2. principal → plan
   │      ⇄ architect, security ─ findings (severity-graded)   [loop, max 5]
   │      principal arbitrates ── accept/reject with rationale
   │      QA authors ──────────── E2E test plan
   │      ops authors ─────────── deployment runbook
   │
   ├─ 3. principal → slice graph  (capability-level dependsOn, acyclic)
   │
   ├─ 4. scheduler ────────────── ready slices run concurrently
   │      per slice:
   │        senior ⇄ principal ── feasibility                  [loop, max 3]
   │        senior → local tests (unit, contract, integration)
   │        senior → implement, or fan out subslices
   │        implement until slice tests green
   │        senior resolves merge conflicts, re-verify on merged tree
   │        principal → review, merge
   │
   ├─ 5. QA sign-off ──────────── evidence: coverage report
   ├─ 6. ops sign-off ─────────── evidence: metrics present in diff
   │
   └─ runbook + metrics + rollback plan
```

Every loop has a cap. Every cap escalates to a human. Every gate cites evidence.

---

## 2. Scheduling: the DAG is the model, lanes are the view

The requirement is dependency-driven assignment — "B after A, D after C, run the two chains
concurrently." That is right. But **lanes are the wrong primitive to schedule on**, for two reasons:

**Cross-lane edges destroy the lane abstraction.** The moment D (lane 2) depends on B (lane 1), a
lane is no longer a schedulable unit. The usual repair is a barrier across all lanes, which is
strictly worse than the edge you already have: it makes *every* lane wait for the slowest, when
only D needed to wait for B. With agents whose durations vary by an order of magnitude, global
barriers mean most of the fleet idles.

**A Gantt chart is a rendering of a schedule, not a scheduling algorithm.** The bars are output. The
input is a dependency graph. Encoding lanes as the primitive throws away the edges and then tries to
reconstruct them with barriers.

So slices carry edges, and the scheduler derives everything else:

```ts
interface Slice {
  id: string;
  title: string;
  acceptance: string[];        // testable criteria
  dependsOn: string[];         // slice ids that must be merged first
}
```

A slice is **ready** when every `dependsOn` is merged. That is the whole rule. It gives you:

- **Dependencies** — what you asked for.
- **Lanes for free** — a dependency chain *is* a lane. Render them as a Gantt view for the human;
  never schedule on them.
- **Cross-lane edges** — ordinary edges, no barriers, no global stalls.
- **Maximum parallelism** — anything ready runs, rather than waiting on a lane's slowest member.

Cycles are rejected before scheduling (`orc.assertAcyclic`). An LLM will emit one eventually.

Concurrency is capped (`maxConcurrency`, default low). A ready set of ten slices would otherwise
start ten sandboxes at once, which is neither affordable nor what a laptop wants. A crude turn cap
per run and per agent guards against runaway loops during development — spend enforcement proper
belongs to the broker at v1, but a hard stop costs twenty lines and prevents an expensive night.

### Dependencies are capability-level, not file-level

A dependency means *this work cannot begin until that capability exists* — "phone-based auth cannot
start until we are collecting phone numbers." It is the judgement a project manager makes from the
feature description, not an analysis of the codebase. The principal produces these edges from the
plan, and they are reviewable by a human who has never opened the repo.

**There is deliberately no file-level scoping.** An earlier draft had slices declare the paths they
may write, enforced with read-only mounts. That was wrong, for a reason worth recording so it does
not get reintroduced: you cannot predict which files solving a problem will require. An agent that
hits an unforeseen issue — a bug in a shared helper, a missing migration, a type that needs widening
— must be able to fix it. Constraining writes to a predicted set converts "agent solves the problem"
into "agent fails at the boundary," which is strictly worse than a merge conflict.

The honest consequence: **two concurrent slices can touch the same file.** That is accepted.

### Merge conflicts are expected, and that is what merges are for

Real teams do not prevent conflicts by partitioning the filesystem in advance. They let people work,
then resolve at integration time. Same here.

Slices branch from the merged head as of when they start. Merges are **serialized** — one slice
integrates at a time, each rebasing onto whatever landed before it, exactly like merging PRs to a
trunk. On conflict:

1. **The slice's own senior resolves it.** They wrote the code and their session still holds the
   context for why. This matches real practice: the author resolves, the reviewer reviews.
2. **Tests re-run on the merged tree**, not the pre-merge branch. Green-at-clone-time is not
   green-at-merge-time, and that gap is where silent breakage lives.
3. **The principal reviews the resolved diff** and merges.
4. **Escalate** if the senior cannot resolve it or the resolution fails review — a conflict where
   both sides changed the same logic is a design question, not a merge question.

Dependency ordering also happens to be a decent *proxy* for conflict avoidance, without being
designed as one: features that touch the same area tend to depend on each other, so they tend to
land in sequence anyway. Imperfect, free, and enough.

### Dependencies are declared in the spec, requested only as a fallback

The slice spec declares any new packages the senior expects to need. The environment is rebuilt once
before implementation, batched across the ready set, and the principal reviews the dependency list
while approving the spec — the same review a human team gives "this needs a new library."

Mid-implementation discovery is the escape hatch, not the plan: `orc_request_package` emits a
*request*, which resolves outside the sandbox and lands in the slice's diff as a manifest and
lockfile change. Language packages resolve in place; system packages need a rebuild and a sandbox
restart, reusing the crash-resume machinery. Full design in
[environments.md](environments.md) §6.

The reason to declare them up front is cost: the fallback path stalls a slice for minutes, and a
dependency chosen under time pressure by an agent mid-task gets less scrutiny than one proposed
during planning.

### Subslices share one tree, sequentially

When a senior fans out to subagents, those subagents work in the **senior's workspace, one at a
time** — not in separate clones merged back.

Parallel subagents on separate clones would recreate the merge problem *inside* a slice, where
there is no PR boundary to catch it: no review, no integration step, no author to resolve. Parallel
subagents on one shared tree is worse still — concurrent writers with nothing between them.

Subslices are small and exist to save context, not wall-clock. Running them sequentially against the
senior's tree keeps the slice a single coherent unit of work with exactly one integration point.
If subslice throughput ever matters, the answer is more slices, not nested parallelism.

### What this costs versus a human team

A human team parallelizes *harder*, because a person can start against a colleague's not-yet-merged
interface and renegotiate mid-flight. Agents in fresh clones cannot renegotiate — the repair
mechanism is conversation, and they do not have it. So `dependsOn` means *fully blocked until
merged*, which serializes more than a real team would.

That is the accepted v2 tradeoff. The v3 escape hatch, if throughput demands it, is letting a slice
publish an interface early so dependents can start against it — an optimization to make once the
strict version works and the wait times are measured.

### Failure semantics

A failed slice blocks its transitive dependents and nothing else. Independent subgraphs keep
running, then the run escalates with the full state: what merged, what is blocked, what failed and
why. Fail-fast would discard completed work the human could otherwise keep.

---

## 3. Steps, artifacts, and resumability

Every phase result is a **declared artifact** produced by a memoized step. The declaration is the
requirement — there is no separate spec for what a phase must produce.

```ts
const prd = await orc.step("prd", {
  schema: PRD,
  description: "Problem, users, acceptance criteria, non-goals, open questions",
}, () => pm.awaitResult({ schema: PRD }));
```

`orc.step` gives four things at once:

1. **Validation at the boundary.** Structured output is checked against the schema before anything
   downstream sees it. A malformed PRD fails at the PRD step, not three phases later.
2. **The schema is the spec.** `description` and the schema travel into the agent's prompt, so what
   the step requires and what the agent is told cannot drift apart.
3. **Resume.** Re-running skips steps whose artifact exists. Debugging the merge phase does not mean
   re-running the PM interview.
4. **Correct invalidation.** The cache key is `id + hash(schema) + hash(prompt) + hash(inputs)`.
   Edit a reviewer's prompt and its cached findings invalidate automatically, along with everything
   downstream. Without this, resume silently serves stale artifacts of the wrong shape — the single
   most maddening bug this design could have.

Loop iterations key by index (`arbitrate:3`), so re-entry is memoized per round.

**Human answers are artifacts too.** An escalation that a human resolves is stored under its step
id, or resume re-asks the same question — which would make escalation worse than useless.

This is not durable execution. The workflow is still an ordinary process; if it dies mid-step, that
step re-runs. It is checkpointing at step granularity, which is enough for the dev loop and is the
seam that becomes durable execution later.

---

## 4. Verification the model cannot author

"Green" must be a fact, not a claim. If an agent runs the tests and *reports* the result, an LLM can
report green on a red suite — and since every gate in this workflow rests on some notion of green,
that one weakness would hollow out all of them.

So verification is a **runner-executed primitive**. The agent may request it and read the result; it
cannot produce the result:

```ts
const tests = await ctx.verify("slice-tests", { cmd: baseline.testCmd });
// → { exitCode, stdout, stderr, durationMs, sha }   written by the runner, outside the model
```

The returned artifact is signed into the run record by the runner. An agent asked "are the tests
green?" answers by reading a `verify` artifact, and a gate that cannot point at one does not pass.
This also makes the whole run auditable after the fact: every green in the record traces to a
command, an exit code, and the tree it ran against.

**The command comes from prevalidation.** Test invocation is repo-specific (`npm test`, `make check`,
`pytest -q`). Phase 0 already runs the suite to establish the baseline, so it discovers and pins
`testCmd` into the baseline artifact, and everything downstream uses that rather than guessing.

---

## 5. Gates that produce signal

Three rules, applied to every review and sign-off.

**Severity is structured, and only `blocking` gates.**

```ts
const Finding = z.object({
  severity: z.enum(["blocking", "major", "minor", "note"]),
  claim: z.string(),
  evidence: z.string(),        // file:line, command output, or PRD quote
  remedy: z.string(),
});
```

An LLM asked to find problems always finds some. Without graded severity, "any finding" gates the
loop and you hit the cap on every run.

**The principal arbitrates.** Reviewers are advisory. The principal must accept or reject each
finding *with written rationale*, and the rejections are part of the artifact. Without a decider,
security says "add X," ops says "X is operationally bad," and the loop burns its cap on an
unresolvable disagreement.

**Sign-off cites evidence from a command that ran.** Not an opinion:

| Gate | Evidence |
| --- | --- |
| Baseline green | test suite exit code + summary |
| Slice complete | slice test exit code |
| Merge accepted | full suite exit code on the merged tree |
| QA sign-off | coverage report against the E2E plan |
| Ops sign-off | named metrics found in the diff (grep/AST), runbook sections present |

Each row is a `verify` artifact (§4) produced by the runner, which is what makes the evidence
unforgeable rather than merely requested. If a gate cannot be tied to such an artifact, it is
advisory and does not gate. Three gates that always pass are worse than no gates, because they look
like assurance.

---

## 6. Escalation

One mechanism, used everywhere: `orc.escalate(reason, context)` suspends the run, surfaces the
question, and records the answer as an artifact.

Triggers: baseline not green; review loop hits 5 with unresolved blockers; feasibility loop hits 3;
a slice fails implementation; a merge conflict the slice's senior cannot resolve, or whose
resolution fails review; a dependency cycle.

The human's options are `abort`, `proceed` (with the decision recorded as documented risk), or
`amend` (edit the artifact and resume from that step). In v2 this is a terminal prompt; Pi's
`extension_ui_request` over RPC is the path to routing it elsewhere later.

---

## 7. The interactive phase

The PM phase needs a human. It does not need a UI:

```
$ orc run feature-delivery --feature "..." --repo ./myrepo
[orc] pm agent ready — attach with:  orc attach pm
```

`orc attach pm` runs `pi --session <path>` against that agent's live session, giving the real Pi
TUI. The human converses; when a conforming PRD artifact is emitted, the workflow continues. No UI
code, and the same channel serves escalation prompts later.

The workflow process blocks for the human's duration. Fine locally; a reason step-level
checkpointing matters before this ever runs on Fargate.

---

## 8. Roles

| Role | Reviews | Authors | Writes code | POC model |
| --- | --- | --- | --- | --- |
| PM | — | PRD | no | `claude-sonnet-5` |
| Principal | plan, PRs | slice graph, arbitration | merges only | `claude-sonnet-5` |
| Architect | plan | findings | no | `claude-sonnet-5` |
| Security | plan | findings | no | `claude-sonnet-5` |
| QA | E2E coverage | E2E test plan | tests only | `claude-sonnet-5` |
| Ops | deploy readiness | runbook, metrics, rollback | no | `claude-sonnet-5` |
| Senior — feasibility | slice feasibility | slice spec | no | `claude-sonnet-5` |
| Senior — implementation | — | local tests | yes | `claude-haiku-4-5` |
| Sub-agent | — | — | yes | `claude-haiku-4-5` |

Note the split: **architect and security review the plan; QA and ops author artifacts at that
stage.** An author should not also gate the loop that produces their input — that is how review
loops oscillate.

### Concrete models for the POC

**Decided: `claude-haiku-4-5` for implementation, `claude-sonnet-5` for everything else.**

The principle behind the line is not "cheap where volume is" — it is **cheap where the gate is
objective, reliable where the output is only judged by another model.**

Implementation has an unforgeable success criterion: `orc.verify` returns an exit code the model
cannot author (§4). A weak model that writes bad code is *caught* — the tests fail, the turn is
retried, the turn cap bounds the damage. Planning and review have no such gate. A mediocre plan, a
missed security finding, or a shallow arbitration is silently accepted and propagates into every
slice downstream. Spend the model budget where nothing else can catch the mistake.

That also happens to put the cheap model where the token volume is, since implementation dominates
turn count and context size. A blended cached run lands around **$2–3**.

**The senior runs at two tiers, in its two phases.** Feasibility negotiation and writing the slice
spec are judgement work; implementing from that spec is execution against a test suite. The design
already splits these into separate sessions — implementation starts from a cleared context, hydrated
from the spec — so the same role is `claude-sonnet-5` while it reasons and `claude-haiku-4-5` while
it builds, at no extra complexity.

### The honest risk in this split

Implementation is the **most tool-call-intensive role in the system** — read, write, edit, bash, in
long iterative loops. If Haiku 4.5 is going to struggle anywhere, it is there, and the failure mode
is burned turns rather than wrong output: retry loops that never reach green.

Three things make that acceptable rather than reckless. The failure is *visible* (tests stay red
rather than passing wrongly), it is *bounded* (turn caps, §2), and the fix is *one line* — promoting
the implementation session to `claude-sonnet-5` is a config change, not a redesign. If S2 shows the
senior thrashing, that is the first knob to turn, and the measurement to take is turns-to-green
rather than cost-per-turn.

One thing to watch: the implementation session also **resolves merge conflicts**, because it holds
the context for why the code is as it is. That is judgement work landing on the cheap tier. It stays
there for the POC because context matters more than raw capability here, and it is gated twice —
tests re-run on the merged tree, and the principal reviews the resolved diff on Sonnet. If conflict
resolution turns out to be where Haiku fails, the narrow fix is to escalate only conflicts to a
Sonnet session hydrated from the spec.

### The principal is a role, not a session

Tempting to give the principal one long-lived session spanning the whole run: it reviews the plan,
arbitrates up to five rounds, plans the slices, negotiates feasibility with every senior, and reviews
every merged diff. For a five-slice feature that is thirty-plus turns carrying full diffs.

Two things break. It hits compaction, which is lossy, so the principal silently forgets its own
earlier arbitration rationale — the record says one thing and the agent believes another. And it
contradicts the principle the whole design rests on: if artifacts are the currency between phases,
the principal should not *need* a continuous session.

So the principal gets a **fresh session per phase**, hydrated from the artifacts it needs (the plan,
the arbitration record, the slice spec). Each diff review is a clean session with the slice spec as
context. It costs prompt tokens and buys determinism, resumability, and steps that are actually
memoizable — a long-lived session is not a cacheable unit of work.

The same reasoning applies to every role except two: the PM, which is a genuine human conversation,
and the slice senior, which keeps its implementation session precisely so it can resolve its own
merge conflicts later.

The light-tier sub-agent is the riskiest choice here. Small models are exactly where tool-calling
reliability degrades, and these agents edit files under strict schemas. Prove one weak-model agent
can complete one trivial subslice before building the tier out.

---

## 9. Staging

The full workflow is not the first runnable thing. Each stage runs end to end.

**S0 — walking skeleton.** All phases wired, every role a stub returning canned structured output.
One real model, no fan-out, no merging, local branches. Proves control flow, `orc.step`, resume, and
escalation plumbing. *This is the milestone that matters most; everything after is thickening.*

**S1 — real planning.** PM interactive phase, real principal, real architect and security review
with severity and arbitration. Slice graph produced but not executed. Exit: a human reads the PRD,
plan, test plan and runbook and finds them genuinely useful.

**S2 — real execution, one slice.** Senior feasibility loop, implementation, slice tests, principal
review and merge, re-verify. Single slice only — no scheduler yet.

**S3 — the scheduler.** Multiple slices, capability-level `dependsOn`, serialized integration with
author-resolved conflicts and re-verify on the merged tree, blocked-subgraph failure handling.
Exit: a feature with a real dependency chain and two concurrent slices completes — including at
least one genuine merge conflict resolved without human help.

**S4 — fan-out and sign-offs.** Subslices on the light tier, QA and ops evidence-based gates, final
artifact assembly.

**Two models are in play from S2**, not S4 — the split in §8 puts `claude-haiku-4-5` on
implementation and `claude-sonnet-5` everywhere else, so [poc.md](poc.md)'s model-catalog seam opens
as soon as real implementation starts. That is a deliberate trade: it means the "can a weak model
build?" question is answered at S2 with a whole slice, rather than at S4 with a subslice. S4 then
only extends the tier already in use to sub-agents, which is a much smaller step.

---

## 10. Open items

Empirical, not architectural — each needs a real run to answer, and none blocks starting.

1. **Slice granularity has no defined target.** "Independently workable" is not a size. Too large
   and the senior's context overflows; too small and coordination dominates. With no file-level
   scoping, granularity and dependency structure are the *only* levers on conflict rate, which
   raises the stakes on getting it right. Needs a stated heuristic and tuning against real runs.
2. **Conflict rate is unknown.** Concurrent slices may touch the same files often enough that the
   resolve-and-reverify tail dominates the run. Measure before optimizing; if it bites, the lever is
   slice granularity, not filesystem partitioning.
3. **Re-verify cost after each merge.** Running the full suite per merge serializes the tail of the
   run. Affordable for small repos; needs affected-test selection for large ones.
4. **No rollback of a bad merge.** If a merge passes review but breaks a later slice, the recovery
   path is escalation and nothing more. A `git revert` of the offending merge is the obvious
   mechanism; whether the run can continue afterwards is unspecified.
5. **The PRD loop may converge on agreement rather than quality.** Reviewers that see the previous
   round's rejections may simply stop objecting. Worth checking whether round-5 findings are
   substantively weaker than round-1 findings, or merely fewer.
6. **Cost per run is estimated, not measured.** §8 puts a blended cached run at roughly $2–3, but
   that assumes a 50K-token average context and a cache that actually hits. Real context growth
   across a long run is the unknown; measure `usage` from the first real runs rather than trusting
   the estimate.
8. **Can Haiku 4.5 carry implementation?** The split in §8 puts the cheap model on the most
   tool-intensive role. The measurement that decides it is turns-to-green per slice, taken at S2.
7. **Which repository is the POC target.** The one genuinely blocking unknown: it determines the
   pre-baked image, the toolchain, and `testCmd` ([poc.md](poc.md) §3).

---

## Appendix — the workflow, in code

Abbreviated, but the control flow is real. Note that nothing here needs orchestration-specific
syntax: the loops are `while`, the escape hatches are `if`, the fan-out is a scheduler call.

```ts
import { defineWorkflow, z } from "@orc/plugin-sdk";

export default defineWorkflow("feature-delivery", async (orc, input: {
  feature: string; repo: string;
}) => {
  // 0 — prevalidate. A red baseline makes every later "green" meaningless.
  const base = await orc.step("baseline", { schema: Baseline }, async () => {
    const cmd = await orc.agent("ops").ask("Identify this repo's test command.", { schema: TestCmd });
    const run = await orc.verify("baseline", { cmd: cmd.value });   // runner executes, not the model
    return { testCmd: cmd.value, green: run.exitCode === 0, run };
  });
  if (!base.green) return orc.escalate("Baseline is not green", base);

  // 1 — PRD, with a human in the loop via `orc attach pm`.
  const pm = await orc.agent("pm").session();
  await pm.send(`Interview the user about: ${input.feature}. Produce a PRD when complete.`);
  orc.notify("pm agent ready — attach with: orc attach pm");
  const prd = await orc.step("prd", {
    schema: PRD,
    description: "Problem, users, acceptance criteria, non-goals, open questions",
  }, () => pm.awaitResult({ schema: PRD }));

  // 2 — plan, reviewed under severity, arbitrated by the principal.
  // The principal is a role, not a session: each phase gets a fresh one, hydrated from artifacts.
  const principal = () => orc.agent("principal");
  let plan = await orc.step("plan:0", { schema: Plan }, () =>
    principal().ask(`Plan the implementation of:\n${prd.md}`, { schema: Plan }));

  for (let round = 1; ; round++) {
    const findings = (await orc.parallel([
      () => orc.agent("architect").ask(`Review:\n${plan.md}`, { schema: Findings }),
      () => orc.agent("security").ask(`Review:\n${plan.md}`, { schema: Findings }),
    ])).flatMap((f) => f.findings);

    const blocking = findings.filter((f) => f.severity === "blocking");
    if (blocking.length === 0) break;

    if (round >= 5) {
      const call = await orc.escalate("Plan did not converge in 5 rounds", { blocking });
      if (call.action === "abort") return orc.fail("aborted at plan review");
      break;                                    // proceed, risk recorded in the artifact
    }

    // The principal decides — reviewers advise. Rejections carry rationale.
    const arb = await orc.step(`arbitrate:${round}`, { schema: Arbitration }, () =>
      principal().ask(`Plan:\n${plan.md}\n\nAccept or reject each finding with rationale:\n` +
                      `${fmt(findings)}\n\nPrior rounds:\n${fmt(priorArbitrations)}`,
                      { schema: Arbitration }));
    plan = arb.revisedPlan;
  }

  // QA and ops author here; they gate later, against evidence.
  const [testPlan, runbook] = await orc.parallel([
    () => orc.step("test-plan", { schema: TestPlan }, () =>
      orc.agent("qa").ask(`E2E plan for:\n${plan.md}`, { schema: TestPlan })),
    () => orc.step("runbook", { schema: Runbook }, () =>
      orc.agent("ops").ask(`Deploy strategy, metrics, rollback thresholds:\n${plan.md}`,
                           { schema: Runbook })),
  ]);

  // 3 — slice graph: capability-level edges, not lanes and not file scopes.
  const slices = await orc.step("slices", { schema: SliceGraph }, () =>
    principal().ask(`Plan:\n${plan.md}\n\nDecompose into slices. ` +
                    `Declare capability-level dependsOn for each.`,
                  { schema: SliceGraph }));
  orc.assertAcyclic(slices);

  // 4 — schedule. Ready = all deps merged. Conflicts are resolved at integration, not prevented.
  const built = await orc.schedule(slices, {
    dependsOn: (s) => s.dependsOn,        // capability-level; no file scoping
    maxConcurrency: 3,                    // a ready set of ten should not start ten sandboxes

    run: async (slice, ctx) => {
      // Full tree, writable. An agent that hits an unforeseen problem must be able to fix it.
      const senior = await orc.agent("senior").session({
        workspace: { base: ctx.mergedHead },
      });

      // Feasibility: bounded negotiation with the principal.
      let spec = await senior.ask(`Assess feasibility:\n${fmt(slice)}`, { schema: SliceSpec });
      for (let i = 1; !spec.agreed; i++) {
        if (i >= 3) return orc.escalate(`Slice ${slice.id} feasibility stalled`, { spec });
        const reply = await principal().ask(`Slice:\n${fmt(slice)}\nSenior raised:\n${spec.concerns}`,
                                            { schema: Reply });
        spec = await senior.ask(`Principal says:\n${reply.md}`, { schema: SliceSpec });
      }

      // The spec is a lossy handoff written by the agent about to clear its context.
      // The principal is already in this conversation; make it sign off before work starts.
      // spec.dependencies is reviewed here too — a new package is a code change (environments.md §6).
      const ok = await principal().ask(`Is this spec sufficient to implement from, alone?\n` +
                                       `${fmt(spec)}`, { schema: Approval });
      if (!ok.approved) return orc.escalate(`Slice ${slice.id} spec rejected`, { spec, ok });

      // Batched rebuild before implementation; a no-op when nothing new was declared.
      await ctx.prepareEnvironment(spec.dependencies);

      // Implementation starts from the written spec, not the negotiation transcript.
      const impl = await orc.agent("senior").session({
        workspace: { base: ctx.mergedHead },
      });

      // Subslices run sequentially in the senior's tree — no nested merge, one integration point.
      if (spec.subslices?.length) {
        for (const ss of spec.subslices) {
          await orc.agent("subagent").run(ss.prompt, {
            acceptance: ss.acceptance, workspace: impl.workspace,
          });
        }
      } else {
        await impl.run(spec.prompt, { acceptance: slice.acceptance });
      }

      // Green is an exit code produced by the runner, not a claim produced by the model.
      const tests = await orc.verify(`slice:${slice.id}`, { cmd: base.testCmd, cwd: impl.workspace });
      if (tests.exitCode !== 0) {
        return orc.escalate(`Slice ${slice.id} could not reach green`, { tests });
      }

      // Merge is serialized. The base has moved; the author resolves, then we re-verify.
      const merged = await ctx.integrate(slice, {
        resolveWith: impl,                // the senior who wrote it holds the context
        reverify: true,                   // tests run on the merged tree, not the branch
      });
      if (!merged.ok) return orc.escalate(`Slice ${slice.id} could not integrate`, merged);

      const review = await principal().ask(`Spec:\n${fmt(spec)}\n\nReview merged diff:\n` +
                                           `${merged.diff}`, { schema: Review });
      if (!review.approved) return orc.escalate(`Slice ${slice.id} rejected`, { review });
      return ctx.land(slice, merged);
    },
  });

  if (built.blocked.length) {
    return orc.escalate("Some slices blocked", { merged: built.merged, blocked: built.blocked });
  }

  // 5, 6 — evidence-based sign-offs.
  const coverage = await orc.verify("coverage", { cmd: base.coverageCmd });
  const qa = await orc.step("qa-signoff", { schema: SignOff }, () =>
    orc.agent("qa").ask(`Coverage report:\n${coverage.stdout}\n\nPlan:\n${fmt(testPlan)}\n` +
                        `Does coverage meet the plan? Cite the report.`, { schema: SignOff }));
  if (!qa.approved) return orc.escalate("QA withheld sign-off", { qa, coverage });

  const metrics = await orc.verify("metrics", { cmd: `grep -rn ${fmt(runbook.metricNames)} src/` });
  const ops = await orc.step("ops-signoff", { schema: SignOff }, () =>
    orc.agent("ops").ask(`Metric search:\n${metrics.stdout}\n\nRunbook:\n${fmt(runbook)}\n` +
                         `Are all named metrics present and the runbook complete?`,
                         { schema: SignOff }));
  if (!ops.approved) return orc.escalate("Ops withheld sign-off", { ops, metrics });

  return { prd, plan, testPlan, runbook: ops.runbook, metrics: ops.metrics, rollback: ops.rollback };
});
```
