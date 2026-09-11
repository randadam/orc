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
   ├─ 3. principal → slice graph  (dependsOn + writes, acyclic)
   │
   ├─ 4. scheduler ────────────── ready slices run concurrently
   │      per slice:
   │        senior ⇄ principal ── feasibility                  [loop, max 3]
   │        senior → local tests (unit, contract, integration)
   │        senior → implement, or fan out subslices
   │        implement until slice tests green
   │        principal → review, merge, re-verify
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
concurrently." That is right. But **lanes are the wrong primitive to schedule on**, for three
reasons:

**Lanes order work; they do not partition it.** Two independent lanes can still write the same
file. Ordering says nothing about disjointness, so lane-parallel slices collide exactly like
unordered ones — just later, during merge, when the cost is highest.

**Cross-lane edges destroy the lane abstraction.** The moment D (lane 2) depends on B (lane 1), a
lane is no longer a schedulable unit. The usual repair is a barrier across all lanes, which is
strictly worse than the edge you already have: it makes *every* lane wait for the slowest, when
only D needed to wait for B. With agents whose durations vary by an order of magnitude, global
barriers mean most of the fleet idles.

**A Gantt chart is a rendering of a schedule, not a scheduling algorithm.** The bars are output. The
input is a dependency graph with resource constraints. Encoding lanes as the primitive throws away
the edges and then tries to reconstruct them with barriers.

So slices carry edges and scope, and the scheduler derives everything else:

```ts
interface Slice {
  id: string;
  title: string;
  acceptance: string[];        // testable criteria
  dependsOn: string[];         // slice ids that must be merged first
  writes: string[];            // path globs this slice may modify
  reads?: string[];            // paths it needs but must not modify
}
```

A slice is **ready** when every `dependsOn` is merged *and* its `writes` do not overlap any running
slice. That single rule gives you:

- **Dependencies** — what you asked for.
- **Lanes for free** — a dependency chain *is* a lane. Render them as a Gantt view for the human;
  never schedule on them.
- **Cross-lane edges** — ordinary edges, no barriers, no global stalls.
- **Disjointness** — which lanes alone never provided.
- **Maximum parallelism** — anything ready runs, rather than waiting on a lane's slowest member.

It is also less code than lanes-plus-checkpoints. The general mechanism is the simpler one here.

### Write scope is enforced, not trusted

The principal is an LLM, so `writes` will sometimes be wrong. Rather than trusting it:

- The runner mounts paths outside a slice's `writes` **read-only**, so a violation fails at the
  filesystem rather than at merge.
- At merge, the diff is checked against the declared scope. Out-of-scope changes fail the slice and
  escalate with the diff attached.

This turns a soft assertion into a checkable invariant, and it reuses the tool-policy machinery
already in v1. If two slices genuinely must write the same file, that is the signal they are one
slice — or that one depends on the other. Both are expressible; "concurrent writers to one file"
is not.

Cycles are rejected before scheduling (`orc.assertAcyclic`). An LLM will emit one eventually.

### What this costs versus a human team

A human team parallelizes *harder* than this, because a person can start against a colleague's
not-yet-merged interface and renegotiate mid-flight. Agents in fresh clones cannot renegotiate —
the repair mechanism is conversation, and they do not have it. So `dependsOn` means *fully blocked
until merged*, which serializes more than a real team would.

That is the accepted v2 tradeoff. The v3 escape hatch, if throughput demands it, is letting a slice
publish an interface early so dependents can start against it — but that is an optimization to make
once the strict version works and the wait times are measured.

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
a slice fails implementation; write-scope violation; merge conflict the principal cannot resolve;
a dependency cycle.

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

**S3 — the scheduler.** Multiple slices, `dependsOn` + `writes`, read-only mounts outside scope,
merge-time scope check, blocked-subgraph failure handling. Exit: a feature with a real dependency
chain and two concurrent slices completes.

**S4 — fan-out and sign-offs.** Subslices on the light tier, QA and ops evidence-based gates, final
artifact assembly.

---

## 9. Open items

1. **Slice granularity has no defined target.** "Independently workable" is not a size. Too large
   and the senior's context overflows; too small and coordination dominates. Needs a stated
   heuristic (files touched? acceptance criteria count?) and tuning against real runs.
2. **Re-verify cost after each merge.** Running the full suite per merge serializes the tail of the
   run. Affordable for small repos; needs affected-test selection for large ones.
3. **No rollback of a bad merge.** If a merge passes review but breaks a later slice, the recovery
   path is unspecified — currently escalation.
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

  // 3 — slice graph: edges and write scope, not lanes.
  const slices = await orc.step("slices", { schema: SliceGraph }, () =>
    principal.ask(`Decompose into slices. Declare dependsOn and writes for each.`,
                  { schema: SliceGraph }));
  orc.assertAcyclic(slices);

  // 4 — schedule. Ready = deps merged AND write scope free.
  const built = await orc.schedule(slices, {
    dependsOn: (s) => s.dependsOn,
    writes: (s) => s.writes,

    run: async (slice, ctx) => {
      const senior = await orc.agent("senior").session({
        workspace: { base: ctx.mergedHead, writable: slice.writes },
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
        workspace: { base: ctx.mergedHead, writable: slice.writes },
      });

      const work = spec.subslices?.length
        ? await orc.parallel(spec.subslices.map((ss) => () =>
            orc.agent("subagent").run(ss.prompt, { acceptance: ss.acceptance })))
        : [await impl.run(spec.prompt, { acceptance: slice.acceptance })];

      // Green means an exit code, not an opinion.
      const tests = await impl.run("Run this slice's tests until green.", { evidence: true });
      if (!tests.green) return orc.escalate(`Slice ${slice.id} could not reach green`, { tests });

      // Merge is serialized; re-verify against the moving base.
      const review = await principal.ask(`Review diff:\n${tests.diff}`, { schema: Review });
      if (!review.approved) return orc.escalate(`Slice ${slice.id} rejected`, { review });
      return ctx.merge(slice, { reverify: true });
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
