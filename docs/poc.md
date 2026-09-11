# POC scope

The design in [plan.md](plan.md) describes a system worth building. Building it in that order would
be a mistake: most of its complexity exists to serve problems the prototype does not have yet.

This document defines a proof of concept that proves the **load-bearing claims** and defers
everything else — with one named seam per deferred decision, so deferring costs a function signature
rather than a rewrite.

**Target: ~4 weeks, single developer, nothing on AWS.**

The workflow this builds toward is [poc-v2.md](poc-v2.md) — start there for what v1 is a skeleton of.

---

## 1. What the POC must prove

Four claims. Each is falsifiable, and if any is false the design changes:

1. **Pi is drivable as a fleet member.** A supervisor spawns `pi --mode rpc`, prompts it, consumes
   the event stream to `agent_end`, aborts mid-turn, and resumes a session. If this is awkward,
   the harness choice is wrong.
2. **`tool_call` can actually veto.** A Pi extension can block a tool invocation before it executes.
   The entire tool-policy model rests on this. *Test it in week 0, before anything else.*
3. **Secret isolation holds.** A sandboxed agent does real model work while holding only a sentinel.
   No real credential appears in its environment, filesystem, or session log. This is the thesis of
   the whole project.
4. **Imperative orchestration expresses the real lifecycle.** A workflow with a loop back to an
   earlier phase, an escape hatch on attempt count, and a conditional bail-out runs correctly and
   reads clearly. If the API fights this, fix it now while there is nothing to migrate.

Anything not in service of these four is out.

---

## 2. What's in

| In scope | Why it can't wait |
| --- | --- |
| `orc-runner` driving `pi --mode rpc` over JSONL | Claim 1 |
| `@orc/pi` extension: provider override + `tool_call` gate | Claims 2, 3 |
| Broker: sentinel mint/validate/substitute, single upstream | Claim 3 — the core property |
| `defineWorkflow` + `agent().session()/run()/ask()`, `parallel()` | Claim 4 |
| Local Docker sandbox, one container per agent, no network but the broker | Claim 3 needs real isolation |
| A pre-baked image carrying the target repo's dependencies | The no-network property is only honest if nothing needs to install (§3) |
| Fresh clone per agent (D1), done by the runner | Cheap, and already decided |
| Two roles with different tool policy | Proves per-role enforcement is real |
| `ctx.verify()` — runner-executed commands, results the model cannot author | Every "green" in every gate depends on it |
| Concurrency cap and a crude turn cap per run and per agent | A runaway loop during development is a real cost event |
| Session JSONL persisted to a local directory | Needed for resume and for recorded tests |

That's it. Roughly: a broker, a runner, an extension, an SDK, and one example workflow.

---

## 3. Dependencies: one pre-baked repo, so no-network stays honest

Two requirements collide: the sandbox has **no network except the broker**, and agents must **run
the repo's test suite**. A test suite needs its dependencies, and `npm install` needs a registry.

Three resolutions exist. Allowing registry egress drags the CONNECT proxy — the hardest security
component — into the POC, defeating the deferral. Vendoring dependencies into the workspace mount
works but breaks whenever a lockfile changes. So:

**The POC targets a single repository, and its dependencies are baked into the sandbox image.**
`images/pi-kit/` installs the target repo's toolchain and dependency tree at build time. Nothing
needs to reach a registry at run time, so "no network but the broker" stays literally true — and
that property is claim 3, the entire thesis. The moment a second target repo is wanted, the egress
gateway has been earned.

This makes the POC repo-specific, which is the correct trade at this stage and should be stated
plainly rather than discovered later.

### The threat model goes live here

Running the target repo's test suite means **executing arbitrary code from that repository inside
the sandbox** — the exact scenario the isolation design exists for. Up to this point the threat
model is theoretical; from S2 onward it is exercised on every run. That is a feature: the credential
isolation test (§8, criterion 2) runs against a sandbox that is genuinely executing untrusted code,
not a synthetic one.

---

## 4. What's deferred, and the seam that keeps it cheap

The rule: **every deferred decision gets exactly one seam, and a seam is a function signature with
exactly one implementation.** Not a plugin system, not a registry, not a config surface. One
function you later write a second version of.

| Deferred | POC does | Seam | Cost to adopt later |
| --- | --- | --- | --- |
| **Model catalog from broker** ([proxy-design.md](proxy-design.md) §3.5) | One pinned model, descriptor hardcoded — the seam stays closed until v2 stage S4 introduces the light tier | `resolveModels(): Promise<Model[]>` in `@orc/pi`, returns a constant | Swap the body for a `fetch` to `/m/catalog`; it is already the argument to Pi's `refreshModels` hook |
| **Inbound wire format choice** ([proxy-design.md](proxy-design.md) §3.6) | `anthropic-messages` only | `ModelBackend` interface in the broker, one impl | Add a second impl; no call sites change |
| **AWS everything** | Local Docker via dockerode | `Sandbox` interface: `start/exec/stop/mount` | `FargateSandbox` alongside `LocalDockerSandbox` |
| **DynamoDB + S3** | JSON files on local disk | `RunStore`, `SessionStore` interfaces | Second impl per interface |
| **Egress gateway, MITM, credential injection** | Sandbox has *no* network except the broker; the runner clones the workspace and mounts it | none needed — it is additive | The CONNECT proxy is new code, not a change to existing code |
| **Bedrock SigV4** | Direct API key, held by the broker only | Credential resolver function in the broker | Second resolver; sentinel path is unchanged |
| **LLM-driven orchestration (`orc_*` tools)** | Code-driven workflows only | The tools are thin wrappers over the same runner RPC the SDK uses | Register the tools; the control-plane calls already exist |
| **Budget enforcement, approvals, policy hash** | Token counts logged, nothing enforced | Broker already sees every token | Add the check where the counter already increments |
| **`orc.config.ts` as a separate file** | Roles declared inline, next to the workflow | `defineConfig()` returns the same frozen value either way | Move the call to its own file when the security boundary needs it |

Note the last row. You said you don't want config overhead during prototyping, and you shouldn't have
it: in the POC there is **no separate config file at all**. Roles live in TypeScript beside the
workflow that uses them. `defineConfig` still produces a frozen value, so the structure that later
gets snapshotted and hashed is already the structure you're writing — it just isn't enforced yet, and
it isn't in its own file yet.

```ts
// examples/ship-feature/workflow.ts — POC: config and logic in one file
import { defineConfig, defineWorkflow, role } from "@orc/sdk";

export const config = defineConfig({
  roles: {
    backend: role({ tools: { allow: ["read", "write", "edit", "bash"] } }),
    reviewer: role({ tools: { allow: ["read", "grep"], deny: ["write", "edit", "bash"] } }),
  },
});

export default defineWorkflow("ship-feature", async (orc, input) => { /* ... */ });
```

---

## 5. Deliberately *not* abstracted

Seams have a cost, and the wrong ones are worse than none. These stay concrete in the POC:

- **No harness abstraction.** Pi is not hidden behind a "harness interface." If we ever swap
  harnesses, the RPC bridge is small enough to rewrite, and a speculative interface built against a
  sample size of one would be wrong anyway.
- **No provider abstraction inside the sandbox.** That is Pi's job, and it already does it well.
- **No event-bus abstraction.** Pi's event types are forwarded verbatim. Inventing a parallel
  vocabulary now means maintaining a mapping forever.
- **No scheduler.** The workflow process spawns sandboxes directly. A queue matters at a scale the
  POC does not have.
- **No `orcd` control-plane service.** The `orc` CLI *is* the control plane in the POC: it evaluates
  the config, mints sentinels, starts sandboxes, runs the workflow. Splitting it into a service is a
  deployment concern, and deployment is deferred entirely.

---

## 6. Shape

```
packages/
  orc-sdk/        defineWorkflow, defineConfig, agent handles, testing helpers
  orc-pi/         Pi extension: provider override, tool_call gate, resolveModels()
  orc-runner/     spawns pi --mode rpc, bridges RPC <-> control, clones workspace
  orc-broker/     sentinel mint/validate/substitute, one upstream, token logging
  orc-cli/        `orc run` — evaluates config, starts broker + sandboxes, runs workflow
images/pi-kit/    Dockerfile: pinned pi, node, git, runner
examples/ship-feature/
```

Five packages, all TypeScript. The broker is TypeScript in the POC too — Go is the right choice for a
long-lived TLS-intercepting proxy, and the POC's broker intercepts nothing. Rewriting ~300 lines in
Go at v1 is cheaper than running two toolchains now.

---

## 7. Sequence

**Week 0 — the spike that can kill the design.** Drive `pi --mode rpc` from a Node script. Register
an extension that blocks a `bash` call from `tool_call`. Nothing else. If claim 2 fails, stop and
redesign the tool-policy model before writing anything in §5.

**Week 1 — local fleet, no isolation.** `defineWorkflow`, agent handles, sessions, `parallel()`.
Agents as local subprocesses, real API key, no broker. Get claim 4 right — write the loop-and-escape-
hatch example and rewrite the API until it reads well. Cheapest possible iteration on ergonomics.

**Week 2 — sandboxes and the broker.** Docker sandbox per agent, no network but the broker. Sentinel
mint/validate/substitute. Fresh clone per agent, mounted by the runner. Claim 3 becomes testable.

**Week 3 — make it real.** Session persistence and resume, per-role tool enforcement, a second
example, the isolation test suite, and the recorded-session test harness.

---

## 8. Exit criteria

The POC is done when:

1. `orc run ship-feature` completes end to end against a real repository, with at least two agents
   running in parallel and a review loop that iterates at least once.
2. A test asserts that from inside a running sandbox, no real credential appears in any process
   environment, anywhere on the filesystem, or in the session JSONL — while model calls succeed.
3. A test asserts a `deny`-listed tool is blocked at `tool_call` and never executes.
4. Killing a sandbox mid-run and re-running resumes from the persisted session rather than restarting.
5. The loop-and-escape-hatch workflow reads like ordinary TypeScript to someone who has not seen orc.

Criterion 5 is a judgement call, and it is the one most worth being strict about. If the workflow
needs comments explaining the orchestration API rather than the task, the API is wrong.

---

## 9. What the POC will not tell us

Worth being honest about, so the results are not over-read:

- **Nothing about scale.** Local Docker on one machine says nothing about Fargate cold starts,
  scheduler behavior, or cost at fan-out.
- **Nothing about the egress gateway.** The hardest security component — CONNECT, TLS interception,
  per-host credential injection — is entirely absent. Deferred, not validated.
- **Little about model variation.** One pinned model means tool-calling reliability across the
  open-weight catalog stays an open question.
- **Nothing about prompt-injection containment in practice.** The hostile-plugin exercise
  (proxy-design.md §8) needs the egress gateway to be meaningful.

The POC de-risks the harness choice and the credential model. The network and scale risks stay where
they are, to be taken deliberately at v1.
