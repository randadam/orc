# The decision layer

orc makes a lot of small judgements that are not generation: how severe is this finding, is this
merge conflict mechanical or semantic, does this escalation belong to the requester or the operator,
is this bash command out of scope.

Today each of those is either **an expensive LLM call for a small decision**, or **a crude static
rule**, because an LLM in that position would be too slow or too costly to justify.

[Jev](https://typesafe.ai) — TypeSafe AI's System One model — is built for exactly this shape: it
takes unstructured state plus a typed question and returns a typed decision with a calibrated
confidence, in 70–500ms at a fraction of an LLM call. This document specifies where orc uses it, and
— more importantly — where it must not.

---

## 1. Build the layer, not the integration

**Jev entered early access on 2026-09-15.** Designing orc so that its correctness depends on a
three-day-old early-access product would be reckless, however good it is.

So the same discipline as the console: define the **interface**, make Jev the first implementation,
and keep an LLM implementation behind the same interface.

```ts
interface Decider {
  choice<T extends string>(q: ChoiceQuestion<T>, state: string): Promise<Decision<T>>;
  score(q: ScoreQuestion, state: string): Promise<Decision<number>>;
  boolean(q: BooleanQuestion, state: string): Promise<Decision<boolean>>;
}

interface Decision<T> {
  value: T;
  confidence: number;        // 0–1, calibrated
  source: "jev" | "llm";     // which implementation answered
}
```

Every decision point calls `Decider`. Jev off means the LLM implementation answers and the system
behaves exactly as designed before this document. **Jev is a performance and consistency
optimization, never a capability the design depends on.** If access lapses, orc degrades rather than
breaks.

In the POC, Jev is **off by default and enabled per question**, after that question has been shadowed
(§5).

---

## 2. The hard boundary: Jev grades, it does not adjudicate or explain

Two rules, and neither is negotiable.

**A typed decision is still a model output, not a fact.** The verification principle
([poc-v2.md](poc-v2.md) §4) stands unchanged: "green" is an exit code produced by the runner, never
a decision produced by a model — however confident, however calibrated. Jev routes and triages; it
never adjudicates correctness. Any use of Jev that would let a model's judgement stand in for a
command's exit code is a bug in the design, not a clever optimization.

**Jev returns no text.** Several places in orc require *written rationale* — the principal must
accept or reject each finding with reasoning, and that rationale is part of the artifact
([poc-v2.md](poc-v2.md) §5). Jev cannot produce it. The division is therefore:

> **The LLM writes the finding and the reasoning. Jev assigns the grade.**

That split is not a compromise. It is better than what it replaces (§3.1).

**Policy narrows, never widens.** Where Jev gates an action, it may only *veto* something policy
already permits. It can never permit something policy denies. Same rule as runtime policy narrowing
([plan.md](plan.md) D2) — the authoritative decision stays with the frozen configuration.

---

## 3. Where it earns its place

### 3.1 Finding severity — a quality win, not a cost win

Reviewers currently self-assign severity, and only `blocking` gates the loop. The weakness is that
severity is then **inconsistent across agents and across rounds** — the architect's "blocking" and
the security reviewer's "blocking" are calibrated differently, and neither is stable between round 1
and round 5.

That inconsistency lands directly on a metric we care about: whether round-5 findings are
substantively weaker or merely fewer ([observability.md](observability.md) §4). Measured with a
wobbly ruler, the question is unanswerable.

So: the LLM writes the finding, its evidence and its remedy. **Jev scores its severity** — a Score
over ordered levels (`note` / `minor` / `major` / `blocking`), applied uniformly to every finding
from every reviewer in every round. One ruler. The loop gate and the convergence metric both become
meaningful.

### 3.2 Decisions we currently make crudely, because an LLM would be too slow

| Decision | Type | Today | With Jev |
| --- | --- | --- | --- |
| **Tool-call risk** (`tool_call` hook) | Boolean | Static allow/deny lists only | A per-command judgement in the hot path — affordable at 70–500ms, not at LLM latency. **Veto only.** |
| **Merge conflict triage** | Choice: mechanical / semantic / ambiguous | Senior attempts, escalates on failure | Semantic conflicts route straight to escalation instead of burning a failing attempt |
| **Verify failure triage** | Choice: real / flake / environment / dependency | Blind retry | Retry, re-run, or escalate, chosen rather than guessed |
| **Escalation routing** | Choice: requester / operator | Undesigned ([console.md](console.md) §9 item 2) | Closes that open item |
| **Work item `kind`** | Choice: feature / remediation | A field someone must set ([console.md](console.md) §4) | Inferred at intake, with the higher-stakes gates that `remediation` implies |
| **Slice granularity** | Score | No signal at all | A size judgement on the proposed graph before scheduling ([poc-v2.md](poc-v2.md) §10 item 1) |

The second column is the interesting one. Tool-call risk assessment is not something orc does badly
today — it is something orc **does not do at all**, because per-command LLM evaluation would make
every turn unusably slow. A sub-second decision changes what is possible, not just what it costs.

### 3.3 Cheap replacements for small LLM calls

Spec sufficiency (`is this spec implementable alone?`) and package-request plausibility are Boolean
questions currently answered by a full LLM turn. Both cascade (§4) and neither is on a critical
correctness path.

---

## 4. The cascade, and why the threshold is a configuration axis

```ts
const d = await decider.score(SEVERITY_Q, finding.text);
if (d.confidence >= threshold) return d.value;
return await llm.assessSeverity(finding);   // fall back, record the fallback
```

Confidence below threshold falls back to the LLM. That is what makes the whole thing safe to adopt
incrementally: a question Jev is bad at produces low confidence and costs only the latency of finding
out.

**The threshold belongs in `orc.config.ts`**, which means it lands in the policy hash, which means it
becomes a comparable configuration axis exactly like model choice
([observability.md](observability.md) §1). "Severity threshold 0.7 vs 0.9" is a sweep you can run.

### Question design matters more than the threshold

One documented result from the field is worth carrying: on a hard classification task, asking a
**direct Boolean** flagged roughly **25× more false positives** than asking the same thing as a
**Score over ordered descriptive levels**. The lesson generalizes — for anything nuanced, prefer a
Score over well-described levels to a bare yes/no, because the levels carry the calibration the
Boolean has to invent.

Vendor benchmarks do not transfer to our questions. Every question gets calibrated on our own data
before it is trusted (§5).

---

## 5. Shadow before trusting

No question goes live on Jev because it seemed like a good fit. The rollout uses the measurement
infrastructure that already exists:

1. **Shadow.** Run Jev alongside the current implementation. Jev's answer is recorded and discarded;
   the LLM's answer is used.
2. **Measure agreement**, per question, with the disagreements kept for reading. Agreement alone is
   not enough — the disagreements are where you learn whether Jev is wrong or whether the LLM was.
3. **Promote** a question to Jev-decides with a threshold chosen from the observed confidence
   distribution, not a round number.
4. **Keep watching.** `orc.decision.fallback` rising means the threshold or the question drifted.

Metrics added to [observability.md](observability.md)'s set:

| Metric | Attributes | Question |
| --- | --- | --- |
| `orc.decision.count` | question, source, outcome | How often each path answers |
| `orc.decision.confidence` | question | The distribution that sets the threshold |
| `orc.decision.fallback` | question | Is the threshold right? |
| `orc.decision.agreement` | question | Shadow-mode agreement with the LLM |
| `orc.decision.duration` | question, source | The latency win, measured rather than assumed |

---

## 6. Placement and security

Jev is a second upstream, and it inherits the existing model exactly:

- **It is not a Pi provider.** Jev is not a chat model and does not fit `registerProvider`. It is orc
  infrastructure — called by the workflow engine, the runner, and the intake path, never registered
  as a model an agent can talk to.
- **The broker fronts it.** `api.typesafe.ai` becomes a second upstream behind the model gateway,
  with sentinel substitution exactly as for the LLM ([proxy-design.md](proxy-design.md) §3). No
  credential enters a sandbox.
- **Tool-call gating routes outward.** The `tool_call` hook runs inside the sandbox, so its decision
  request goes through the runner's unix socket → broker, like every other outbound call. The agent
  holds no Jev credential and cannot call Jev directly.
- **Budget and audit cover it.** Decisions count toward the run's spend, and every decision is
  recorded with its confidence and source.

---

## 7. Open items

1. **Early-access dependency.** ~~Availability~~ **Access confirmed 2026-09-21** ([phases.md](phases.md)
   §15 Q8); the shadow track starts in phase 5. Rate limits and API stability remain unknown — the
   `Decider` interface and the always-present LLM fallback are still the mitigation; do not let a
   question become Jev-only. The API shape in §1–§4 came from secondary sources and must be verified
   against TypeSafe's primary documentation before `JevDecider` is written.
2. **Calibration is per-question and unmeasured.** §5 is the process, but no question has been
   shadowed yet, and the confidence distributions that set thresholds do not exist.
3. **Tool-call gating latency in the hot path.** 70–500ms per gated tool call is affordable in
   principle; whether it is affordable on *every* bash call in a long implementation loop is
   untested. Gate selectively — by command class — before gating universally.
4. **Which access surface.** Access exists, but whether it is the direct API, OpenRouter, or a
   gateway is unconfirmed; the broker's upstream entry and credential handling differ by answer. On
   AWS this interacts with the SigV4 decision ([plan.md](plan.md) §9 item 1), since Jev is not a
   Bedrock model and reintroduces a long-lived key unless fronted differently — the broker holds
   that key exactly as it holds the model key today.
