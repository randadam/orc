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

## 4. Gates that produce signal

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

If a gate cannot be tied to a command, it is advisory and does not gate. Three gates that always
pass are worse than no gates, because they look like assurance.

---

## 5. Escalation

One mechanism, used everywhere: `orc.escalate(reason, context)` suspends the run, surfaces the
question, and records the answer as an artifact.

Triggers: baseline not green; review loop hits 5 with unresolved blockers; feasibility loop hits 3;
a slice fails implementation; a merge conflict the slice's senior cannot resolve, or whose
resolution fails review; a dependency cycle.

The human's options are `abort`, `proceed` (with the decision recorded as documented risk), or
`amend` (edit the artifact and resume from that step). In v2 this is a terminal prompt; Pi's
`extension_ui_request` over RPC is the path to routing it elsewhere later.

---

## 6. The interactive phase

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

## 7. Roles

| Role | Reviews | Authors | Writes code | Model tier |
| --- | --- | --- | --- | --- |
| PM | — | PRD | no | strong |
| Principal | plan, PRs | slice graph, arbitration | merges only | strong |
| Architect | plan | findings | no | strong |
| Security | plan | findings | no | strong |
| QA | E2E coverage | E2E test plan | tests only | mid |
| Ops | deploy readiness | runbook, metrics, rollback | no | mid |
| Senior | slice feasibility | slice spec, local tests | yes | strong |
| Sub-agent | — | — | yes | light |

Note the split: **architect and security review the plan; QA and ops author artifacts at that
stage.** An author should not also gate the loop that produces their input — that is how review
loops oscillate.

The light-tier sub-agent is the riskiest choice here. Small models are exactly where tool-calling
reliability degrades, and these agents edit files under strict schemas. Prove one weak-model agent
can complete one trivial subslice before building the tier out.

---

## 8. Staging

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

---

## 9. Open items

1. **Slice granularity has no defined target.** "Independently workable" is not a size. Too large
   and the senior's context overflows; too small and coordination dominates. With no file-level
   scoping, granularity and dependency structure are the *only* levers on conflict rate, which
   raises the stakes on getting it right. Needs a stated heuristic and tuning against real runs.
2. **Re-verify cost after each merge.** Running the full suite per merge serializes the tail of the
   run. Affordable for small repos; needs affected-test selection for large ones.
3. **No rollback of a bad merge.** If a merge passes review but breaks a later slice, the recovery
   path is unspecified — currently escalation.
6. **Conflict rate is unknown.** Concurrent slices may touch the same files often enough that the
   resolve-and-reverify tail dominates the run. Measure it before optimizing; if it bites, the lever
   is slice granularity, not filesystem partitioning.
4. **The PRD loop may converge on agreement rather than quality.** Reviewers that see the previous
   round's rejections may simply stop objecting. Worth checking whether round 5 findings are
   substantively weaker than round 1, or just fewer.
5. **Cost per run is unmeasured and probably large.** 60–100+ agent turns. Recorded-fixture mode is
   not optional for iterating on this.

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
  const base = await orc.step("baseline", { schema: Baseline }, () =>
    orc.agent("ops").run("Run the suite. Report exit code and summary.", { evidence: true }));
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
  const principal = await orc.agent("principal").session();
  let plan = await orc.step("plan:0", { schema: Plan }, () =>
    principal.ask(`Plan the implementation of:\n${prd.md}`, { schema: Plan }));

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
      principal.ask(`Accept or reject each finding with rationale:\n${fmt(findings)}`,
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
    principal.ask(`Decompose into slices. Declare capability-level dependsOn for each.`,
                  { schema: SliceGraph }));
  orc.assertAcyclic(slices);

  // 4 — schedule. Ready = all deps merged. Conflicts are resolved at integration, not prevented.
  const built = await orc.schedule(slices, {
    dependsOn: (s) => s.dependsOn,        // capability-level; no file scoping

    run: async (slice, ctx) => {
      // Full tree, writable. An agent that hits an unforeseen problem must be able to fix it.
      const senior = await orc.agent("senior").session({
        workspace: { base: ctx.mergedHead },
      });

      // Feasibility: bounded negotiation with the principal.
      let spec = await senior.ask(`Assess feasibility:\n${fmt(slice)}`, { schema: SliceSpec });
      for (let i = 1; !spec.agreed; i++) {
        if (i >= 3) return orc.escalate(`Slice ${slice.id} feasibility stalled`, { spec });
        const reply = await principal.ask(`Senior raised:\n${spec.concerns}`, { schema: Reply });
        spec = await senior.ask(`Principal says:\n${reply.md}`, { schema: SliceSpec });
      }

      // Implementation starts from the written spec, not the negotiation transcript.
      const impl = await orc.agent("senior").session({
        workspace: { base: ctx.mergedHead },
      });

      const work = spec.subslices?.length
        ? await orc.parallel(spec.subslices.map((ss) => () =>
            orc.agent("subagent").run(ss.prompt, { acceptance: ss.acceptance })))
        : [await impl.run(spec.prompt, { acceptance: slice.acceptance })];

      // Green means an exit code, not an opinion.
      const tests = await impl.run("Run this slice's tests until green.", { evidence: true });
      if (!tests.green) return orc.escalate(`Slice ${slice.id} could not reach green`, { tests });

      // Merge is serialized. The base has moved; the author resolves, then we re-verify.
      const merged = await ctx.integrate(slice, {
        resolveWith: impl,                // the senior who wrote it holds the context
        reverify: true,                   // tests run on the merged tree, not the branch
      });
      if (!merged.ok) return orc.escalate(`Slice ${slice.id} could not integrate`, merged);

      const review = await principal.ask(`Review merged diff:\n${merged.diff}`, { schema: Review });
      if (!review.approved) return orc.escalate(`Slice ${slice.id} rejected`, { review });
      return ctx.land(slice, merged);
    },
  });

  if (built.blocked.length) {
    return orc.escalate("Some slices blocked", { merged: built.merged, blocked: built.blocked });
  }

  // 5, 6 — evidence-based sign-offs.
  const qa = await orc.step("qa-signoff", { schema: SignOff }, () =>
    orc.agent("qa").ask(`Verify coverage against the plan.`, { evidence: true }));
  if (!qa.approved) return orc.escalate("QA withheld sign-off", qa);

  const ops = await orc.step("ops-signoff", { schema: SignOff }, () =>
    orc.agent("ops").ask(`Confirm metrics exist in the diff and the runbook is complete.`,
                         { evidence: true }));
  if (!ops.approved) return orc.escalate("Ops withheld sign-off", ops);

  return { prd, plan, testPlan, runbook: ops.runbook, metrics: ops.metrics, rollback: ops.rollback };
});
```
