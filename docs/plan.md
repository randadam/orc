# orc — development plan

An agent orchestration framework using [Pi](https://github.com/earendil-works/pi) as the harness,
with a secrets-isolating proxy layer, remote execution on AWS, and orchestration written as
Pi-style plugins that live in the target repo.

---

## 1. Why Pi

Pi is a terminal-first agent harness whose core is deliberately small and whose extension surface
is unusually complete. Three properties make it the right substrate for an orchestrator rather
than something we wrap and fight:

**It is already drivable as a subprocess.** Pi ships an RPC mode: JSONL over stdin/stdout, with
commands (`prompt`, `steer`, `follow_up`, `abort`, `get_state`, `fork`, `switch_session`) and a
matching event stream (`agent_start`, `message_update`, `tool_execution_start`, `agent_end`).
A supervisor process gets a complete, language-agnostic control channel over a running agent
without patching Pi. There is also an in-process SDK (`createAgentSession`,
`createAgentSessionRuntime`, `runPrintMode`, `runRpcMode`) when we want to embed rather than spawn.

**Its extension API is the orchestration API we would otherwise have had to invent.**
`pi.registerTool` adds LLM-callable tools with Typebox schemas and streaming progress.
`pi.registerCommand` / `registerShortcut` / `registerFlag` extend the operator-facing surface.
`pi.on(...)` exposes a lifecycle: `tool_call` (which can *block or modify* a tool invocation
before it executes), `tool_result`, `context`, `before_agent_start`, `session_start`,
`agent_settled`. `ctx.newSession`, `ctx.fork`, `ctx.navigateTree`, `ctx.switchSession` give
programmatic control of the session tree. An orchestrator is, structurally, an extension that
registers spawn/await tools and gates the children's `tool_call` events.

**Provider indirection is built in.** `pi.registerProvider` lets us override an existing provider's
`baseUrl` and `headers`, or register new ones, with `$ENV_VAR` interpolation resolved at request
time. Pointing a sandboxed agent at our broker instead of `api.anthropic.com` is three lines of
extension code, not a fork.

And Pi's packaging story — a `package.json` with `keywords: ["pi-package"]` and a `pi` key naming
`extensions` / `skills` / `prompts` / `themes` directories, installable via `pi install npm:...`
or `pi install git:...` — is exactly the "plugins that run from a repo" requirement, already solved.
We adopt it rather than inventing a parallel plugin format.

### What Pi explicitly does not give us

Pi's own security documentation is direct about this, and our design is shaped by taking it at
face value:

> Pi does not include a built-in sandbox.

Built-in tools read, write, and run shell commands with the permissions of the pi process.
Extensions run with those same permissions. Project trust gates *input loading only* — it stops a
repo from silently changing settings before you approve it, and it explicitly "does not make
untrusted code, untrusted prompts, or untrusted model output safe." Prompt injection from repo
files, comments, and build output is called out as expected, unpreventable local-agent risk.

So Pi supplies the agent loop, the tools, the session model, and the extension surface. **orc
supplies everything outside the process boundary**: isolation, credential handling, network policy,
scheduling, durable state, and audit. That division is clean, and it means we track Pi upstream
instead of maintaining a fork.

---

## 2. Architecture

```
                        ┌──────────────────────────────────────────────┐
   developer's repo     │  CONTROL PLANE  (private subnet, has egress) │
   ┌────────────────┐   │                                              │
   │ .pi/extensions │   │   orcd            broker                     │
   │ .pi/skills     │──▶│   ├ run store     ├ model gateway  ──┐       │
   │ orc.config.ts  │   │   ├ scheduler     ├ egress gateway ──┼──▶ internet
   └────────────────┘   │   ├ event bus     └ policy engine    │   (allowlisted)
                        │   └ artifact svc                     │
                        │       │                        Secrets Manager
                        └───────┼──────────────────────────────────────┘
                                │ control (mTLS)      ▲ sentinel-bearing
                                ▼                     │ requests only
                        ┌──────────────────────────────────────────────┐
                        │  AGENT PLANE  (isolated subnet, NO egress)   │
                        │                                              │
                        │  ┌─ sandbox ─────┐  ┌─ sandbox ─────┐        │
                        │  │ orc-runner    │  │ orc-runner    │  ...   │
                        │  │   │ JSONL/RPC │  │   │           │        │
                        │  │   ▼           │  │   ▼           │        │
                        │  │ pi (harness)  │  │ pi (harness)  │        │
                        │  │ + orc pi-pkg  │  │ + orc pi-pkg  │        │
                        │  │ + your plugin │  │ + your plugin │        │
                        │  │ /workspace    │  │ /workspace    │        │
                        │  └───────────────┘  └───────────────┘        │
                        └──────────────────────────────────────────────┘
```

Two planes, one rule between them: **nothing in the agent plane holds a credential, and nothing in
the agent plane reaches the internet except through the broker.**

### 2.1 Components

| Component | Language | Runs on | Responsibility |
| --- | --- | --- | --- |
| `orc` (CLI) | TypeScript | developer machine / CI | `init`, `dev`, `run`, `logs`, `attach`, `fork`, `deploy` |
| `orcd` (control plane) | TypeScript (Node 22) | ECS Fargate service | Run lifecycle, scheduling, event bus, session/artifact storage, policy resolution |
| `broker` (proxy layer) | Go | ECS Fargate service | Model gateway + egress gateway + credential substitution + audit |
| `orc-runner` | TypeScript | inside each sandbox | Supervises `pi` over RPC, bridges orchestration tools to `orcd`, streams events |
| `@orc/pi` | TypeScript | inside each sandbox | The Pi package: provider override, orchestration tools, `tool_call` policy gate |
| `@orc/plugin-sdk` | TypeScript | developer's repo | Types + helpers for writing orchestration plugins; `defineWorkflow` for code-driven runs |
| sandbox image | `devcontainer build` + derived layer | ECR | Repo's own `.devcontainer/` plus pi, runner, internal CA ([environments.md](environments.md)) |
| `infra` | AWS CDK (TS) | — | VPC, ECS, DynamoDB, S3, Secrets Manager, IAM, observability |

Go for the broker is a deliberate exception to an otherwise TypeScript stack: it is a long-lived,
latency-sensitive network component doing TLS interception and streaming proxying, and Go's
stdlib (`crypto/tls`, `net/http/httputil`) is the right tool. Everything else stays TypeScript so
we share types with Pi and let plugin authors work in one language.

### 2.2 The run model

A **run** is one execution of one orchestration plugin. It owns a tree of **agents**; each agent is
one Pi session in one sandbox. The root agent is the orchestrator.

```
run:   ship-feature #4711
 └── agent:root (orchestrator)      pi session, orchestration plugin loaded
      ├── agent:impl-api            pi session, skill=backend, workspace=repo@feature/x
      ├── agent:impl-ui             pi session, skill=frontend, workspace=repo@feature/x
      └── agent:review              pi session, skill=reviewer, read-only workspace
```

Agents are addressable, durable, and resumable. Because Pi persists sessions as JSONL with an
`id`/`parentId` tree, we get fork-and-branch for free: `orc fork <agent> --at <entry-id>` maps onto
Pi's own `fork`, and a run can be replayed or bisected after the fact.

**State lives in three places**, and the split matters:

- **DynamoDB** — run/agent metadata, state machine transitions, leases, sentinel bindings.
  Small, hot, strongly consistent reads on the run record.
- **S3** — session JSONL (written through by the runner, one object per agent, versioned),
  artifacts, logs. Cheap, durable, replayable.
- **The sandbox's ephemeral disk** — `/workspace` only. Assumed lost at any moment.

Session JSONL is streamed to S3 incrementally rather than uploaded at exit, so a killed sandbox
loses at most the last few entries and a run can be resumed onto a fresh sandbox.

### 2.3 Sandbox isolation

Each agent gets an **ECS Fargate task** in `awsvpc` mode:

- **Own network namespace and ENI.** Agents cannot see each other's traffic.
- **Task-scoped IAM role** with *no* `secretsmanager:*`, *no* `s3:*` on run buckets, and *no*
  `bedrock:*`. The sandbox role's only job is pulling its image; everything else is brokered.
- **Isolated subnet: no NAT gateway, no internet gateway route.** Not "firewalled off" — the route
  simply does not exist. The security group permits egress to exactly two destinations: the
  broker's internal NLB and `orcd`'s internal NLB.
- **Read-only root filesystem** with writable tmpfs at `/workspace` and `/tmp`.
- **No Docker socket.** Compose services from the repo's devcontainer run as sidecars in the same
  network namespace, started by the runner — the agent reaches them on `localhost` and holds no
  Docker access ([environments.md](environments.md) §4).

Fargate over EC2/Firecracker for v1: per-task IAM and per-task ENIs are exactly the primitives the
isolation model needs, with no node fleet to manage. Its cost is cold start (~30–60s). Milestone 4
addresses that with warm pools; milestone 6 revisits Firecracker-on-EC2 if the economics demand it.

### 2.4 How an agent is driven

`orc-runner` is PID 1 in the sandbox. It:

1. Fetches the run's **policy bundle** from `orcd` over mTLS (SPIFFE-style identity issued at task
   start): model allowlist, tool policy, egress allowlist, workspace spec, sentinel values.
2. Materializes `/workspace` — clone at a pinned ref, via the broker's git path.
3. Launches `pi --mode rpc` with `ORC_*` env, the sentinel model credential, and `@orc/pi` loaded.
4. Speaks Pi's JSONL RPC on stdin/stdout: sends `prompt` / `steer` / `abort`, consumes
   `agent_start`, `message_update`, `tool_execution_*`, `agent_end`.
5. Bridges the orchestration tools (§4) — a tool call inside Pi arrives at the runner over a unix
   domain socket and becomes an authenticated call to `orcd`. **The agent process itself never
   holds an `orcd` credential**; the runner does, and it is not readable from the agent's user.
6. Tails session JSONL to S3 and forwards events to the run's event stream.

RPC-over-subprocess rather than the in-process SDK, deliberately: the agent loop runs in a separate
process from the thing holding the control-plane credential, so a compromised tool call cannot read
the runner's memory.

---

## 3. The proxy layer

Full design in **[proxy-design.md](proxy-design.md)**. The essentials:

The broker is the *only* path out of the agent plane, and it runs two gateways.

**Model gateway (reverse proxy).** The sandbox's Pi is configured — via `@orc/pi`'s
`pi.registerProvider("anthropic", { baseUrl: "https://broker.orc.internal/m/anthropic" })` — to send
inference to the broker. The request carries a **sentinel** credential: a well-formed but worthless
token (`sk-ant-orc01-<run>-<rand>`) minted per run, bound to run + agent + scope, with a TTL. The
broker validates it, swaps in the real credential from Secrets Manager, and forwards upstream.
The real credential never travels inward. Streaming responses proxy through untouched.

This is the same shape as Pi's own documented Docker Sandboxes integration, where "the provider
credential is not passed into the container. The sandbox receives a sentinel value instead, and the
proxy substitutes the real credential on egress." We are generalizing it to every credential class,
not just the model key.

**On AWS there is a strictly better variant, and it is the recommended default:** point the model
gateway at **Amazon Bedrock** and have the broker sign requests with SigV4 using its own task role.
Then there is no long-lived model API key anywhere in the system — not in the sandbox, not in
Secrets Manager, not in the broker's memory. The sentinel is validated, the request is re-signed,
and IAM is the authorization boundary. The broker accepts the `anthropic-messages` wire format on
its inbound side either way, so Pi is unaware of which backend is in use.

**Egress gateway (forward proxy).** Everything else — `git clone`, `npm install`, `pip`, a `curl`
in an agent's bash tool — goes through an HTTP CONNECT proxy at `HTTPS_PROXY`, with an internal CA
trusted by the image. Policy is deny-by-default and evaluated per request against the run's
allowlist. For allowlisted hosts that need auth, the broker injects the credential on egress:
a GitHub token attaches to `github.com` and to nothing else, ever. Rejected requests are logged
with run, agent, host, and rule.

**The property this buys:** a fully prompt-injected agent, executing attacker-chosen shell commands
with attacker-chosen network calls, has no secret to steal and no unapproved host to send one to.
Containment, not prevention — Pi is right that prevention is not available.

---

## 4. Orchestration plugins

Full API in **[plugin-api.md](plugin-api.md)**. The essentials:

An orchestration plugin **is a Pi package**. It lives in the target repo under `.pi/`, or is
installed from npm/git, and follows Pi's own manifest convention:

```json
{
  "name": "@acme/ship-feature",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

The orchestrator agent loads it, plus `@orc/pi`, which registers the fleet-control tools. Two
authoring styles, one runtime:

**LLM-driven.** The orchestrator is itself a Pi agent. It gets tools — `orc_spawn`, `orc_send`,
`orc_await`, `orc_cancel`, `orc_artifact` — and decides the plan itself. Good for open-ended work.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineRole } from "@orc/plugin-sdk";

export default function (pi: ExtensionAPI) {
  defineRole(pi, "backend", { skill: "backend-engineer", model: "claude-opus-4-5" });
  defineRole(pi, "reviewer", { skill: "strict-reviewer", workspace: "read-only" });

  pi.registerCommand("ship", {
    description: "Implement and review a feature across parallel agents",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await pi.sendUserMessage(`Plan and delegate: ${args}`);
    },
  });
}
```

**Code-driven.** For work whose shape is known, skip the planning LLM and write the DAG:

```ts
import { defineWorkflow } from "@orc/plugin-sdk";

export default defineWorkflow("ship-feature", async (orc, { issue }) => {
  const plan = await orc.agent("architect").ask(`Break down ${issue}`, { schema: PlanSchema });
  const work = await orc.parallel(
    plan.tasks.map((t) => () => orc.agent("backend").run(t.prompt, { workspace: t.paths })),
  );
  const review = await orc.agent("reviewer").run("Review the diff", { inputs: work });
  return review.approved ? orc.openPullRequest(work) : orc.fail(review.reason);
});
```

Both compile to the same control-plane calls. `defineWorkflow` is the one piece that is genuinely
ours rather than Pi's — it is a thin deterministic driver over the same `orc_*` primitives, so an
LLM-driven and a code-driven run are indistinguishable to `orcd`.

**Policy is a value; logic is code — both TypeScript.** orc has no YAML (§8, D2). `orc.config.ts` at
the repo root is the security-relevant surface. It is TypeScript that *evaluates to a static value*,
resolved once before any agent starts, then frozen and hashed:

```ts
// orc.config.ts — evaluated once, before any agent starts, then frozen and hashed
import { defineConfig, role } from "@orc/sdk";

export default defineConfig({
  roles: {
    backend: role({
      // image defaults to the repo's built devcontainer digest; override only to differ
      model: { provider: "bedrock", id: "anthropic.claude-opus-4-5" },
      tools: { allow: ["read", "write", "edit", "bash", "orc_*"], deny: ["web_fetch"] },
      egress: ["github.com", "registry.npmjs.org", "*.amazonaws.com"],
      secrets: [{ name: "GITHUB_TOKEN", scope: ["github.com"], mode: "inject" }],
    }),
  },
  limits: { maxAgents: 12, wallClock: "45m", usdBudget: 25 },
});
```

`mode: "inject"` is the point: the secret is named in policy but *resolved only inside the broker*.
The config never contains a secret value, and neither does the sandbox.

**Trust.** Pi's `project_trust` event means a repo's `.pi/` resources are not loaded until approved.
We bind that to orc's own model: a plugin change alters the policy hash, and a run whose policy hash
is unapproved requires explicit promotion. Orchestration plugins are code with network
and credential implications, and they get reviewed as such.

---

## 5. Milestones

Each milestone has exit criteria; none is "done" on code alone.

> **Start with the POC, not M1.** [poc.md](poc.md) defines a ~4-week prototype that proves the
> load-bearing claims (harness fit, tool gating, credential isolation, orchestration ergonomics)
> while deferring AWS, the egress gateway, and the model catalog behind named seams. The milestones
> below describe the full system; the POC is how it starts.

### M0 — Spike: drive Pi as a subprocess (1 week)

Prove the harness assumption before building on it. A Node supervisor spawns `pi --mode rpc`,
sends a `prompt`, consumes the event stream to `agent_end`, and cleanly `abort`s mid-turn. A
throwaway extension registers one tool and blocks a `bash` call from a `tool_call` handler.

*Exit:* RPC control loop and `tool_call` gating both demonstrated. **If `tool_call` cannot reliably
veto execution, the whole tool-policy design changes — find out now.**

### M1 — Local orchestration (3 weeks)

`@orc/plugin-sdk`, `@orc/pi`, `orc-runner`, and `orc dev` running everything on local Docker.
Local broker with sentinel substitution for one provider. Two agents spawned from an orchestrator
plugin, doing real work in a real repo, with session JSONL on disk.

*Exit:* `orc dev run examples/ship-feature` completes end to end. No API key inside any container —
verified by `env` dump and a filesystem sweep from inside a running sandbox.

### M2 — AWS control plane (4 weeks)

CDK stack: VPC with an isolated agent subnet (no NAT), ECS services for `orcd` and `broker`,
DynamoDB, S3, ECR, internal NLBs, mTLS between planes. Fargate task per agent. Session
streaming to S3, resume onto a fresh sandbox after a kill.

*Exit:* the M1 example runs unchanged on AWS. Killing a sandbox mid-run loses no more than the last
few session entries and the agent resumes. `orc logs -f` streams live.

### M3 — Security hardening (3 weeks)

Egress gateway with CONNECT + internal CA + per-run allowlist. Credential injection for
`github.com` and the package registries. Bedrock SigV4 path in the model gateway. IAM split
enforced and tested. Structured audit log of every egress decision to S3.

*Exit:* a **deliberately hostile plugin** — one told to exfiltrate everything it can reach — run as
a red-team exercise, obtains no credential and reaches no non-allowlisted host. Every attempt
appears in the audit log. This exercise is the milestone, not a checkbox on it.

### M4 — Scale and developer experience (3 weeks)

Warm sandbox pools to cut cold start. Cost and token accounting per run/agent, enforced against
`limits`. OpenTelemetry traces spanning orchestrator → child agents → model calls. `orc attach`
for live steering of a running agent (Pi's `steer` over RPC). GitHub App trigger.

*Exit:* p50 agent start under 10s. A run that exceeds `usd_budget` halts and reports rather than
silently continuing.

### M5 — Plugin ecosystem (2 weeks)

`orc init` scaffolding, plugin test harness with recorded model responses, `examples/` covering
LLM-driven and code-driven styles, published `@orc/*` packages, docs.

*Exit:* someone outside the team writes and ships a working orchestration plugin from docs alone.

### M6 — Optional, demand-driven

Firecracker-on-EC2 runners if Fargate economics bite. Multi-region. BYO-cloud. Non-Pi harness
adapters — only if the runner's RPC bridge proves genuinely harness-agnostic.

---

## 6. Risks

| Risk | Assessment | Response |
| --- | --- | --- |
| **Pi is a fast-moving upstream; extension APIs shift** | Likely | Pin exact versions in the derived image layer. Keep our Pi surface area narrow (registerTool, registerProvider, `tool_call`, RPC) and behind an adapter in `@orc/pi`. Contract-test against upstream weekly in CI. |
| **Prompt injection drives an agent to abuse its *allowed* capabilities** | Certain to be attempted | Out of scope for prevention, by Pi's own honest admission. Contain it: narrow allowlists, per-role least privilege, human approval gates on irreversible actions (push to default branch, deploy), full audit. |
| **Sentinel leaks to an attacker outside the VPC** | Possible | It is worthless there: the broker is not internet-reachable, sentinels are run-bound with short TTL, and validation checks source. Rotate per run. |
| **TLS-intercepting egress proxy breaks tooling (pinned certs, mTLS upstreams)** | Likely in practice | Support CONNECT-passthrough for allowlisted hosts that must not be intercepted — policy decision per host, logged. Accept that no-inspection hosts get host-level allowlisting only. |
| **Fargate cold start makes fan-out feel sluggish** | Likely | Warm pools (M4). Measure before optimizing; a 45s start is irrelevant to a 20-minute agent task and fatal to a 30-second one. |
| **Cost runs away — parallel agents on frontier models** | Likely without controls | Hard `usd_budget` per run enforced in the broker, where token counts are already visible. Halt, don't warn. |
| **Orchestrator agents plan badly and burn the fleet on nothing** | Likely early | This is why `defineWorkflow` exists. Recommend code-driven orchestration for anything whose shape is known; reserve LLM-driven planning for genuinely open-ended work. |
| **We drift into forking Pi** | Moderate | Every upstream patch we want is a PR to Pi first. If we cannot do it through the extension API, that is a signal to reconsider the design, not to fork. |

## 7. Explicitly out of scope

- **A new agent harness.** Pi is the harness. If Pi is wrong, we replace it; we do not rebuild it.
- **A new plugin format.** Pi packages, as specified upstream.
- **A hosted multi-tenant SaaS.** v1 is single-tenant, deployed into the user's own AWS account.
  Multi-tenancy changes the isolation model substantially and should not be retrofitted casually.
- **A web UI.** CLI and API first. A UI is a client of the event stream, buildable later by anyone.
- **Preventing prompt injection.** Containing its blast radius is the whole security posture.

## 8. Decisions

### D1 — Workspaces: fresh clone per agent (decided)

Each agent gets its own workspace, materialized by the runner as a clone at a pinned ref through
the broker's git path. No shared filesystem between agents in v1.

This buys isolation for free: two agents cannot corrupt each other's working tree, a crashed
sandbox takes nothing with it, and every agent's starting state is exactly reproducible from a ref.
It costs clone time per agent — mitigated with a shared git cache in the image and `--depth`/partial
clone for large repos, both cheap and local.

The alternative, a shared EFS workspace, is faster to start and considerably harder to get right:
concurrent writes to one tree need a coordination protocol, and agents that block on each other
stop being independently schedulable. Revisit only if clone time measurably dominates run time,
which for multi-minute agent tasks it will not.

Fan-in happens through **artifacts and diffs**, not a shared tree — `orc_artifact` and the
`inputs:` field on a run are the supported channels for moving work between agents.

### D2 — TypeScript everywhere; no YAML (decided)

Orchestration logic is TypeScript. Configuration is TypeScript. There is no YAML in orc, and no
declarative graph format.

The reasoning is about expressiveness, not taste. Real agent lifecycles contain cycles that return
to earlier phases, escape hatches on accumulated state (attempt counts, spend), and branches taken
on the *content* of a previous result. Declarative formats cannot express those, so they acquire
`if:` expressions, `${{ }}` interpolation, and eventually a half-specified scripting language —
producing a bad programming language with no type checker, no debugger, and no tests. Starting from
TypeScript means loops, `try/catch`, and early returns are already there, correct, and tooled.

The security model still needs a policy that is fixed and reviewable before anything runs. That is
preserved by separating **when** code is evaluated rather than what format it is written in:

- **`orc.config.ts` is policy.** Evaluated once by the control plane in a sandboxed Node context
  with no network and no run state, then snapshotted to JSON, hashed, and frozen. It is a config
  file in the sense `vite.config.ts` is one: TypeScript that produces a value. Helper functions and
  shared constants are fine; branching on run state is impossible, because there is no run yet.
- **`.pi/extensions/*.ts` is logic.** Ordinary code, executed throughout the run.

Because policy is frozen before the first agent starts, a plugin cannot widen its own network or
secret policy mid-run — the property the discarded "yaml wins over code" rule existed to protect.
Runtime **narrowing** is allowed (a workflow may grant a step less than its role permits); widening
is rejected by the control plane.

What stays out of config: conditions, loops, phases, steps, retries, DAGs. Config answers "what is
this role allowed to do." Workflows answer "what happens, in what order, and when do we go back."

### D3 — Code-driven orchestration is the default (decided)

Workflows are TypeScript functions. The LLM-driven style — an orchestrator agent holding `orc_*`
spawn/await tools and planning its own delegation — is deferred past the POC entirely.

An LLM planning a fan-out of expensive agents is a reliability and cost risk worth taking only when
the work is genuinely open-ended. Where an agent's judgement is needed mid-run, it returns
*structured output* the workflow acts on (a senior returning `subslices: Slice[] | null`), rather
than being handed a spawn tool. Same outcome, decision visible in the workflow rather than buried in
a transcript, and no new capability surface.

### D4 — Human-in-the-loop is escalation plus attach (decided)

One mechanism for the human to intervene, one for the human to participate.

`orc.escalate(reason, context)` suspends the run, surfaces the question, and records the answer as
an artifact keyed to its step — so a resumed run does not re-ask. Options are `abort`, `proceed`
(risk recorded), or `amend` (edit the artifact and resume from that step). Every loop cap, failed
slice, unresolvable conflict and cycle escalates rather than failing silently or guessing.

For phases that need a human *in* the conversation, `orc attach <agent>` runs `pi --session <path>`
against that agent's live session, giving the real Pi TUI. No bespoke chat UI. Pi's
`extension_ui_request` over RPC is the path to routing prompts elsewhere later.

### D5 — Environments come from the repo's dev container (decided)

The sandbox image is built from the repository's own `.devcontainer/`, outside the sandbox, and the
sandbox installs nothing. Full design in [environments.md](environments.md).

An orc-owned image hand-built per target repo works for exactly one repo and puts orc permanently in
the business of knowing toolchains. The [Dev Container spec](https://containers.dev) already holds
that knowledge, usually written by whoever maintains the build, and its prebuild boundary
(`onCreateCommand` / `updateContentCommand` run at build; the container start does not) is exactly
the boundary the no-egress property needs.

Two consequences worth stating here rather than burying:

- **`devcontainer.json` is untrusted repository input**, not configuration we author. It is filtered
  through an allowlist at policy-resolution time and folded into the policy hash. `initializeCommand`
  is rejected unconditionally — it runs on the *host*, which here is the control plane holding the
  credentials.
- **Compose services become sidecars in the agent's network namespace**, never a Docker socket the
  agent controls. An ECS task is a compose project, so this maps to Fargate without changing the
  isolation model.

## 9. Open questions

Two remain, plus one the POC needs immediately:

1. **Model backend — Bedrock or direct API keys?** Bedrock + SigV4 in the broker removes long-lived
   model credentials from the system entirely and is the recommended default. Bedrock's catalog now
   covers open-weight models as well as frontier ones ([proxy-design.md](proxy-design.md) §3.4), so this
   choice no longer costs model selection. Direct keys remain for anything Bedrock doesn't carry.
   *This decides the model gateway's design.*
2. **What scale are we building for?** 10 concurrent agents and 100 concurrent agents are different
   schedulers. Assumed: tens, single-digit concurrent runs.
3. **Which repository is the POC target?** Blocking for the POC, not for the architecture. It
   determines the sandbox image contents, the toolchain, and the test command — see [poc.md](poc.md)
   §3, which pins the POC to a single pre-baked repo rather than pulling the egress gateway forward.
