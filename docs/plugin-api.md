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
├── orc.yaml                          # policy: roles, models, egress, secrets, limits
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

Nothing here is orc-specific except `orc.yaml`. A repo set up for orc is a repo set up for Pi,
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

### 2.1 Code-driven — `defineWorkflow`

For work whose shape is known. The orchestration is a TypeScript function; no planning LLM sits in
the loop deciding what to do next. Deterministic, testable, cheap, and debuggable.

```ts
import { defineWorkflow, z } from "@orc/plugin-sdk";

const Plan = z.object({
  tasks: z.array(z.object({ title: z.string(), prompt: z.string(), paths: z.array(z.string()) })),
});

export default defineWorkflow("ship-feature", async (orc, input: { issue: string }) => {
  // One-shot structured query — no session kept alive.
  const plan = await orc.agent("architect").ask(`Break down issue ${input.issue}`, {
    schema: Plan,
  });

  // Fan out. Each is its own sandbox, its own Pi session, its own workspace clone.
  const results = await orc.parallel(
    plan.tasks.map((task) => () =>
      orc.agent("backend").run(task.prompt, {
        workspace: { paths: task.paths },
        label: task.title,
      }),
    ),
    { maxConcurrency: 4 },
  );

  // Fan in. The reviewer sees the combined diff, not the chatter.
  const review = await orc.agent("reviewer").run("Review the combined diff for correctness.", {
    inputs: results.map((r) => r.diff),
    schema: z.object({ approved: z.boolean(), reason: z.string() }),
  });

  if (!review.approved) return orc.fail(review.reason);
  return orc.openPullRequest({ branch: `orc/${input.issue}`, results });
});
```

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

`orc_spawn` and `orc_await` are separate on purpose. A single blocking `spawn_and_wait` reads more
naturally but serializes the fleet — the split is what makes fan-out expressible.

---

## 4. `@orc/plugin-sdk` surface

```ts
// Roles — declared in code, merged with orc.yaml (yaml wins on security-relevant fields)
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

## 5. `orc.yaml`

The security-relevant surface, separated from plugin code on purpose: it is the file a reviewer
reads to understand what a run can reach.

```yaml
version: 1

defaults:
  image: ghcr.io/acme/pi-kit-node:20
  model: { provider: bedrock, id: anthropic.claude-opus-4-5 }
  timeout: 20m

roles:
  architect:
    tools: { allow: [read, grep, orc_*], deny: [write, edit, bash] }
    egress: { allow: [] }                       # reads the workspace; needs nothing else

  backend:
    skill: backend-engineer
    tools: { allow: [read, write, edit, bash, orc_*] }
    egress:
      allow: [github.com, api.github.com, registry.npmjs.org]
    secrets:
      - { name: GITHUB_TOKEN, scope: [github.com, api.github.com], mode: inject }
      - { name: NPM_TOKEN,    scope: [registry.npmjs.org],         mode: inject }

  reviewer:
    skill: strict-reviewer
    workspace: read-only
    tools: { allow: [read, grep, orc_*], deny: [write, edit, bash] }
    egress: { allow: [] }

limits:
  max_agents: 12
  wall_clock: 45m
  usd_budget: 25

approvals:
  # Irreversible actions stop and ask a human, via Pi's extension UI sub-protocol over RPC.
  require_human: [push_to_default_branch, deploy]
```

Three things to notice:

**No secret values.** `mode: inject` names a secret; the value is resolved only inside the broker,
on egress, for in-scope hosts. `orc.yaml` is committed to the repo and contains nothing sensitive.

**yaml wins over code.** `defineRole` in a plugin may set a model or a skill, but if `orc.yaml`
constrains `tools`, `egress`, or `secrets`, the yaml is authoritative. Security policy is not
overridable by the code it governs.

**Empty allowlists are common and correct.** The architect and reviewer roles reach nothing. Most
agents need less network than their authors assume, and the default should be nothing.

---

## 6. Trust and change control

Pi fires `project_trust` before loading project-local `.pi/` resources, and caches decisions in
`~/.pi/agent/trust.json`. orc binds its own approval to the same moment.

Every run resolves a **policy hash** over `orc.yaml` plus the content hashes of every loaded
extension. A run whose policy hash has not been approved for the target environment requires
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
