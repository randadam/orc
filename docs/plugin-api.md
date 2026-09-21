# Orchestration plugins

An orchestration plugin is a **Pi package**. Not a Pi-like format, not a format inspired by Pi —
the actual upstream convention, loaded by the actual upstream loader. This document covers how
orchestration is expressed, what `@orc/plugin-sdk` adds on top, and how policy is declared.

See [plan.md](plan.md) for the system architecture and [proxy-design.md](proxy-design.md) for how
policy is enforced.

---

## 1. Layout in your repo

Pi discovers project-local resources under `.pi/`, searching up the directory tree, gated by its
`project_trust` mechanism. orc uses that directly:

```
your-repo/
├── orc.config.ts                     # policy: roles, models, egress, secrets, limits (a value, not logic)
├── .pi/
│   ├── extensions/
│   │   └── orchestrate.ts            # your orchestration plugin
│   ├── skills/
│   │   ├── backend-engineer/SKILL.md # role instructions for spawned agents
│   │   └── strict-reviewer/SKILL.md
│   └── prompts/
│       └── triage.md                 # reusable prompt templates
└── src/ ...
```

Nothing here is orc-specific except `orc.config.ts`. A repo set up for orc is a repo set up for Pi,
which means the same skills work when a developer runs `pi` locally, and orchestration plugins are
developed with the ordinary Pi toolchain.

To share a plugin, publish it as a Pi package and install it the way Pi already supports:

```jsonc
// package.json
{
  "name": "@acme/orc-ship",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

```bash
pi install npm:@acme/orc-ship
pi install git:github.com/acme/orc-ship@v1.2.0
```

---

## 2. Two authoring styles

### 2.1 Code-driven — `defineWorkflow` (the default)

The orchestration is a TypeScript function. Control flow is ordinary control flow: `while`, `if`,
`try/catch`, early `return`. Loops back to earlier phases, escape hatches, and conditional bail-outs
need no special support because they are just code.

```ts
import { defineWorkflow, z } from "@orc/plugin-sdk";

const Review = z.object({
  approved: z.boolean(),
  blocking: z.array(z.string()),
  needsRedesign: z.boolean(),
});

export default defineWorkflow("ship-feature", async (orc, input: { issue: string }) => {
  const plan = await orc.agent("architect").ask(`Break down ${input.issue}`, { schema: Plan });

  // Long-lived sessions: looping back to an agent keeps its context rather than rebuilding it.
  const impl = await orc.agent("backend").session({ workspace: { paths: plan.paths } });
  const reviewer = await orc.agent("reviewer").session({ workspace: "read-only" });

  await impl.send(plan.prompt);
  let attempt = 0;

  while (true) {
    const work = await impl.next();
    const review = await reviewer.ask(`Review this diff:\n${work.diff}`, { schema: Review });

    if (review.approved) break;

    // Escape hatch: bounded retries, then hand it to a human rather than burning budget.
    if (++attempt >= 3) {
      return orc.escalate("Three review rounds without approval", { work, review });
    }

    // Escape hatch: a design problem is not fixable by iterating on the implementation,
    // so jump back to an *earlier* phase instead of looping in place.
    if (review.needsRedesign) {
      const revised = await orc.agent("architect").ask(`Revise the plan: ${review.blocking}`, {
        schema: Plan,
      });
      await impl.send(`The plan changed. Start from: ${revised.prompt}`);
      continue;
    }

    // Ordinary loop back: same session, incremental correction.
    await impl.send(`Address these blocking issues:\n${review.blocking.join("\n")}`);
  }

  return orc.openPullRequest({ branch: `orc/${input.issue}` , from: impl });
});
```

Three things this shows that a declarative graph cannot express:

**Loops that return to an earlier phase.** The `needsRedesign` branch goes back to the architect,
then re-enters implementation. That is a cycle in the graph, with the decision to take it made from
the content of a result.

**Escape hatches on accumulated state.** `attempt >= 3` depends on how many times the loop has run,
which is not a property of any single node.

**Cheap re-entry.** `impl` is a live Pi session, so looping back is a `send()`, not a re-spawn.
The agent keeps its context, its workspace, and its understanding of what it already tried — the
single biggest cost difference between an imperative orchestrator and a DAG runner that rebuilds
state at every node.

Sessions also `fork()`, so a workflow can explore a branch speculatively and abandon it without
polluting the main line — Pi's session tree makes this nearly free.

Run it:

```bash
orc run ship-feature --input '{"issue":"ENG-4711"}'
```

### 2.2 LLM-driven — orchestrator as a Pi agent

For open-ended work where the plan is not known in advance. The orchestrator is itself a Pi session
with fleet-control tools registered, deciding its own delegation.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineRole, registerOrchestrationTools } from "@orc/plugin-sdk";

export default function (pi: ExtensionAPI) {
  defineRole(pi, "backend",  { skill: "backend-engineer", model: "claude-opus-4-5" });
  defineRole(pi, "frontend", { skill: "frontend-engineer" });
  defineRole(pi, "reviewer", { skill: "strict-reviewer", workspace: "read-only" });

  // Registers orc_spawn, orc_send, orc_await, orc_cancel, orc_artifact, orc_list
  registerOrchestrationTools(pi);

  pi.registerCommand("ship", {
    description: "Implement and review a feature across parallel agents",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await pi.sendUserMessage(
        `Implement: ${args}\n` +
        `Delegate with orc_spawn. Do not write code yourself. ` +
        `Await all agents before reviewing.`,
      );
    },
  });

  // Keep the orchestrator honest: it delegates, it does not implement.
  pi.on("tool_call", async (event, ctx) => {
    if (["write", "edit"].includes(event.toolName)) {
      return { block: true, reason: "Orchestrator must delegate file edits to a worker agent." };
    }
  });
}
```

Both styles compile to identical control-plane calls. `orcd` cannot tell them apart, and mixing
them in one run is supported — a code-driven workflow can spawn an LLM-driven sub-orchestrator for
the one branch that genuinely needs judgment.

**Recommendation:** code-driven by default. An LLM planning a fan-out of expensive agents is a
reliability and cost risk that is only worth taking when the work is genuinely open-ended.

---

## 3. The orchestration tools

Registered into the orchestrator's Pi session by `registerOrchestrationTools(pi)`. They are ordinary
Pi tools — Typebox schemas, streaming progress, custom TUI rendering — that bridge over a unix
socket to `orc-runner`, which authenticates to `orcd`. The agent process never holds a control-plane
credential.

| Tool | Purpose |
| --- | --- |
| `orc_spawn` | Start an agent: role, prompt, workspace spec, optional structured-output schema. Returns an agent id immediately. |
| `orc_await` | Block on one or more agent ids. Supports `any` / `all`, with a timeout. Returns results or failures. |
| `orc_send` | Send a message to a running agent. Maps to Pi's `steer` (interrupt at the next tool boundary) or `follow_up` (deliver when idle). |
| `orc_cancel` | Abort an agent and release its sandbox. |
| `orc_list` | Current fleet state: ids, roles, status, tokens spent, wall clock. |
| `orc_artifact` | Read or write a run-scoped artifact in S3. The channel for passing large outputs between agents without stuffing them through the context window. |
| `orc_request_package` | Request a dependency the environment lacks. Emits a *request* resolved outside the sandbox; the resulting manifest change lands in the slice's diff for review ([environments.md](environments.md) §6). Available to any agent, not just orchestrators — it is a capability, not orchestration. |

`orc_spawn` and `orc_await` are separate on purpose. A single blocking `spawn_and_wait` reads more
naturally but serializes the fleet — the split is what makes fan-out expressible.

---

## 4. `@orc/plugin-sdk` surface

```ts
// Roles — may narrow what orc.config.ts grants, never widen it
defineRole(pi, name, { skill?, model?, tools?, workspace?, image?, timeout? }): void

// Workflows
defineWorkflow<I, O>(name, (orc: Orc, input: I) => Promise<O>): Workflow<I, O>

interface Orc {
  agent(role: string): AgentHandle;
  parallel<T>(fns: (() => Promise<T>)[], opts?: { maxConcurrency?: number }): Promise<T[]>;
  artifact(key: string): Artifact;
  openPullRequest(opts: PullRequestOptions): Promise<PullRequestResult>;
  fail(reason: string): never;
  log: Logger;
}

interface AgentHandle {
  // One-shot: spawn, prompt, collect, tear down.
  run(prompt: string, opts?: RunOptions): Promise<AgentResult>;
  // One-shot with structured output, validated against the schema.
  ask<T>(prompt: string, opts: RunOptions & { schema: Schema<T> }): Promise<T>;
  // Long-lived: keep the session open for multi-turn interaction.
  session(opts?: RunOptions): Promise<AgentSession>;
}

interface AgentSession {
  send(text: string, opts?: { mode?: "steer" | "followUp" }): Promise<void>;
  next(): Promise<AgentResult>;          // await the next settled turn
  events(): AsyncIterable<AgentEvent>;   // Pi's event stream, forwarded
  fork(atEntryId?: string): Promise<AgentSession>;
  close(): Promise<void>;
}
```

`fork` maps onto Pi's own session-tree forking. Because Pi persists sessions as JSONL with
`id`/`parentId` entries, branching a run at an arbitrary point costs nothing and needs no support
from us beyond plumbing the entry id through.

`events()` yields Pi's native event types (`message_update`, `tool_execution_start`, `agent_end`),
forwarded verbatim from the RPC stream. We do not invent a parallel event vocabulary.

---

## 5. `orc.config.ts` — policy as a value, not a language

**orc has no YAML.** Orchestration logic is TypeScript, and so is configuration. Nothing about a
run is expressed in a declarative graph format.

This is a deliberate rejection of the YAML-harness pattern. Real agent lifecycles have loops that
return to earlier phases, escape hatches on iteration count or cost, branches taken on the content
of a previous result, and early bail-outs. Declarative formats cannot express those, so they grow
`if:` expressions, `${{ }}` interpolation, and a half-specified scripting language — at which point
you have a bad programming language with no types, no debugger, and no tests. We start from the
good one.

The security model still needs a fixed, reviewable policy, and it gets one without YAML, by
separating **when** things are evaluated rather than **what file format** they use:

| | Evaluated | By whom | Can it branch on run state? |
| --- | --- | --- | --- |
| **Policy** (`orc.config.ts`) | Once, before any agent starts | Control plane, in a plain sandboxed Node context with no network | **No** — it produces a value |
| **Logic** (`.pi/extensions/*.ts`) | Throughout the run | The orchestrator agent | **Yes** — it is ordinary code |

Policy is a config file in the sense `vite.config.ts` or `eslint.config.js` is one: TypeScript that
*evaluates to a static value*. You get types, autocomplete, shared constants, and helper functions
to build role sets — while the control plane still gets a single frozen JSON snapshot it can hash,
diff, and enforce.

```ts
// orc.config.ts
import { defineConfig, role } from "@orc/sdk";

const readOnly = { allow: ["read", "grep", "orc_*"], deny: ["write", "edit", "bash"] } as const;

export default defineConfig({
  defaults: {
    // Environment comes from the repo's .devcontainer/, built outside the sandbox.
    // Set `image` only to pin something different for a role.
    model: { provider: "bedrock", id: "anthropic.claude-opus-4-5" },
    timeout: "20m",
  },

  roles: {
    architect: role({ tools: readOnly, egress: [] }),

    backend: role({
      skill: "backend-engineer",
      tools: { allow: ["read", "write", "edit", "bash", "orc_*"] },
      egress: ["github.com", "api.github.com", "registry.npmjs.org"],
      secrets: [
        { name: "GITHUB_TOKEN", scope: ["github.com", "api.github.com"], mode: "inject" },
        { name: "NPM_TOKEN", scope: ["registry.npmjs.org"], mode: "inject" },
      ],
    }),

    reviewer: role({ skill: "strict-reviewer", workspace: "read-only", tools: readOnly, egress: [] }),
  },

  limits: { maxAgents: 12, wallClock: "45m", usdBudget: 25 },
  approvals: { requireHuman: ["push_to_default_branch", "deploy"] },
});
```

Four properties hold:

**No secret values.** `mode: "inject"` names a secret; the value is resolved only inside the broker,
on egress, for in-scope hosts. The config is committed and contains nothing sensitive.

**Policy is frozen before agents run.** It is evaluated once, in a context with no network and no
run state, then snapshotted and hashed. An orchestration plugin cannot widen its own network
policy mid-run, because by the time any plugin code executes the policy is already immutable. This
is the property the old "yaml wins over code" rule was protecting, preserved without the YAML.

**Narrowing at runtime is allowed; widening is not.** A workflow may hand an agent *less* than its
role permits (`orc.agent("backend", { egress: [] })` for a step that should not touch the network).
The reverse is rejected by the control plane, not by convention.

**Empty egress is common and correct.** Architect and reviewer reach nothing. Most agents need less
network than their authors assume, and the default is nothing.

### What does *not* belong here

No conditions, no loops, no phases, no DAG, no step definitions, no retry logic, no branching. If
you find yourself wanting any of it in `orc.config.ts`, it belongs in a workflow. The config answers
"what is this role allowed to do"; the workflow answers "what happens, in what order, and when do
we go back."

---

## 6. Trust and change control

Pi fires `project_trust` before loading project-local `.pi/` resources, and caches decisions in
`~/.pi/agent/trust.json`. orc binds its own approval to the same moment.

Every run resolves a **policy hash** over the evaluated `orc.config.ts` snapshot plus the content
hashes of every loaded extension. A run whose policy hash has not been approved for the target environment requires
explicit promotion:

```bash
orc policy diff          # what changed since the last approved hash
orc policy approve --env prod
```

An orchestration plugin can spawn agents, reach the network, and cause credentials to be injected
into requests. It is privileged code, and a change to it is a privilege change — treated like a
change to an IAM policy, not like a change to a README.

---

## 7. Testing plugins

Plugins are ordinary TypeScript, and they should be testable without spending money or leaving the
machine.

```ts
import { testWorkflow, mockAgent } from "@orc/plugin-sdk/testing";
import shipFeature from "../.pi/extensions/ship-feature";

test("fans out one agent per planned task", async () => {
  const result = await testWorkflow(shipFeature, {
    input: { issue: "ENG-1" },
    agents: {
      architect: mockAgent.respond({ tasks: [{ title: "a", prompt: "p", paths: ["src/a"] }] }),
      backend: mockAgent.respond({ diff: "--- a/src/a" }),
      reviewer: mockAgent.respond({ approved: true, reason: "ok" }),
    },
  });

  expect(result.spawned).toHaveLength(1);
  expect(result.spawned[0].role).toBe("backend");
});
```

Three levels, in increasing cost:

1. **Mocked** — agents return canned values. Tests orchestration logic. Runs in CI, free, fast.
2. **Recorded** — real Pi sessions replayed from captured JSONL. Tests prompt and schema handling
   against real model behavior without re-spending tokens. Pi's session format makes this
   straightforward: the JSONL *is* the recording.
3. **Live** — `orc dev` against local Docker with a local broker. Tests the real thing, including
   the credential isolation, before anything touches AWS.

Level 2 is the one that earns its keep: model behavior changes under you, and a recorded suite
catches it as a diff rather than as a production surprise.
