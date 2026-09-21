# Phase 1 — the SDK, on bare subprocesses, with traces

Detailed plan for [phases.md](../phases.md) §4. This is the execution authority for phase 1;
phases.md remains the order authority, [poc.md](../poc.md) the scope authority, and
[plugin-api.md](../plugin-api.md) the record of the API's intended final shape — phase 1 builds
the subset phases.md §4 names, and §5 below records where the built subset differs from that doc
and why.

**Everything from this phase is kept.** Four packages, one CLI, two examples, an acceptance suite.
Phase 2 puts the runner inside a container and phase 3 makes it durable; neither changes the
workflow-facing surface this phase fixes.

**Phase 0 has not run as of this writing.** §1.2 states the findings this plan assumes. Before
slice 1.1 starts, read `spikes/FINDINGS.md`, replace §1.2 with the actual finding lines, and re-cut
whatever they contradict. Nothing below is worth building on an assumption phase 0 falsified.

---

## 1. Assumptions

### 1.1 Answers to [phases.md](../phases.md) §15 assumed here

| Question | Assumed here | If the answer differs |
| --- | --- | --- |
| Q2 — where the prototype ends | Irrelevant to this phase. | — |
| Q4 — first empirical question | Irrelevant to this phase; nothing here is a measurement. | — |
| Q6 — environment | Node 22 (22.22 verified), pnpm 10 (10.33 verified), `git` on `PATH`. **No Docker.** | Nothing in this phase changes. |
| Q7 — credential | `ANTHROPIC_API_KEY` in the environment of the `orc` process, direct API. The runner **passes the environment through** to `pi` and never reads the key; no orc package imports a model SDK. Pi is the only model client, which is the discipline CLAUDE.md asks for stated for a phase that has no broker yet. | A different provider is a `--provider` flag and a model id in the config. |
| Q9 — who executes | Acceptance is executable: `pnpm accept:phase1` exits 0 or 1 (§10). | — |
| Q10 — single user | No identity anywhere. Escalation answers carry an action and a note, nothing about who. | — |

### 1.2 Phase 0 findings

Phase 0 ran on 2026-09-21. `spikes/FINDINGS.md` is the record; this table quotes it.

| Spike | Finding | What in this plan rests on it |
| --- | --- | --- |
| 01 veto | **Confirmed.** `{ block: true, reason }` from `tool_call` prevents execution, and the reason reaches the model. | The whole of `@orc/pi`'s gate (§6.3), acceptance 2. |
| 02 drive | **Confirmed.** `prompt` → `agent_end` works, and `abort` cuts a turn in **0.0s**, catching every in-flight tool call. Two cautions for the control loop: **`abort` on an already-settled session emits nothing** (wait on the response, not on `agent_end`), and **Pi runs sibling tool calls concurrently** (`tool_call` preflights them sequentially, then they execute in parallel — a gate assuming one in-flight tool is wrong). Resume is not used here; phase 1 never resumes, but `--session <path>` **is** honoured under `--mode rpc` when it does. | The runner's control loop (§6.1). |
| 03 submit | **Confirmed.** A registered tool with a schema was called **5/5** with valid arguments, and `terminate: true` skipped the follow-up call in all five. Median 5.3s. `ask()` costs one turn, not two. | `ask()` (§6.4), acceptance 1. |
| 04 attach | **`forked`** — two Pi processes on one session file do not share it. Phase 1 has no `orc attach`, so nothing here changes; it revised [plan.md](../plan.md) §8 D4's mechanism. | Nothing. |
| 05 events | **Confirmed, with two corrections.** `usage` also carries **`cacheWrite1h`** beyond the documented set, so read `cost.total` rather than enumerating fields. **`turn_end` carries `usage`, `model` and `provider` together**, once per turn — bill from it, not from the 58 `message_update`s of the same turn. Tool start/end pair on `toolCallId` and **tool timing is derived from the runner's clock**. `turnIndex` on `turn_start`/`turn_end` was **not** checked. | Turn counting, turn spans and provisional token counts (§7). |
| 06 trust | **Confirmed, and better than assumed.** Three mechanisms work; use **`--approve`**, which is per-run where `defaultProjectTrust` is per-machine. The default silently declines, loading none of the project's `.pi/` — so **the runner must assert the marker loaded**, since trust failing open on "no extensions" is otherwise invisible. | `@orc/pi` answers trust by policy (§6.3). |

One trap 05-events exposed that phase 1's telemetry will hit: **`message_start` fires for tool
result messages as well as assistant messages**, carrying `toolName` and `toolCallId`. Counting
assistant turns without reading `message.role` overcounts. It is what broke 03-submit.

Two Pi facts confirmed against the 0.86 docs on 2026-09-21 and relied on beyond phase 0's spikes:
`pi.registerTool()` works after startup, from any event handler, and new tools are visible
immediately; Pi's built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`,
`ls`.

### 1.3 The seed

`randadam/tudu` was seeded on 2026-09-21 and **this phase pins `592f4de`**. It is a React SPA,
barer than [fixture.md](../fixture.md) first specified and deliberately so ([plan.md](../plan.md)
§8 D9) — orc builds the rest. The sha is written in exactly three places: this line,
`examples/loop-and-escape/README.md`, and `accept/phase1/seed.ts`, and nowhere else.

**The fast suite is `pnpm test`, not `pnpm test:unit`** — the seed has no `test:unit`, and `test` is
46 tests across 7 files in **3.6s with no services**, verified at that commit. That is what
`testCmd` binds to throughout this plan. `pnpm lint`, `pnpm typecheck` and `pnpm build` also exit 0.

**Re-pin when the author's pnpm fix lands.** The seed currently commits a `package-lock.json` beside
`pnpm-lock.yaml` and its CI runs `npm ci`; the fix is in flight ([fixture.md](../fixture.md) §9
item 1) and moves the sha.

Slices 1.0–1.10 do not need the seed: their tests run against a git repository the test itself
creates. Only slices 1.11–1.12 and the live acceptance runs need `tudu`.

### 1.4 Pins

| What | Pin | Why this one |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | **`0.86.1`** — the phase 0 pin, unchanged (§15 Q5) | Re-pinning re-runs the spikes; not this phase's business |
| Model | **`claude-sonnet-5`**, one model for every role (phases.md §4) | The Haiku split arrives in phase 6 |
| `zod` | `4.x` (4.6.5 current) | `z.toJSONSchema` is built in, which §2.3 needs |
| `@opentelemetry/api`, `@opentelemetry/sdk-trace-base` | `1.9.x` / `2.x` (2.11.0 current) | D6: the real SDK, from the first emitter |
| TypeScript, vitest, eslint, prettier | Current stable at scaffold time, exact in the lockfile | — |

Every pin is exact in `package.json`. No `^`, no `latest`, on anything.

---

## 2. Settled in this plan

These are the decisions phases.md §4 and §14 left to this document, plus the ones that surfaced
while cutting it. Each names what decided it.

### 2.1 Telemetry lands in the run directory

**An in-process OTEL `SpanExporter` writes `trace.jsonl` into the run directory. OTLP to a
collector is `orc run --otlp <url>`, additive, off by default.** This was phases.md §14's
recommended option and two things decide it: Q6 has no Docker, and a local Jaeger or collector is
a container; and phases.md §4 already settles that the run directory is the API every later reader
uses — putting telemetry anywhere else means two places to read. [observability.md](../observability.md)
§6 is updated to record this.

### 2.2 Structured output is the submit tool, with the schema delivered by file

`ask()` registers a `submit_result` tool whose parameters are the ask's schema, exactly as phase 0
spike 3 tested. The schema reaches the extension through the **agent file** (§4.4): the runner
writes `ask.schema` there, and `@orc/pi` reads the file in `before_agent_start` and registers (or
re-registers) the tool. One mechanism serves both one-shot `ask()` on a handle and `ask()` on a
live session. Whether re-registering with a new schema *replaces* the earlier registration is the
one thing spike 3 did not test; slice 1.8 checks it first (§9).

### 2.3 Schemas are Zod v4 in the SDK, JSON Schema on the wire

[plugin-api.md](../plugin-api.md) shows `z`; Pi's `registerTool` takes Typebox. Both are JSON
Schema underneath. The SDK takes a Zod schema, converts it once with `z.toJSONSchema`, writes the
JSON Schema into the agent file, and the extension hands that object to `registerTool` as-is.
Validation of the returned value happens in the SDK with the original Zod schema, not in the
extension — the boundary that matters is the workflow's.

### 2.4 The step cache key is over declared inputs

[poc-v2.md](../poc-v2.md) §3 gives the key as `id + hash(schema) + hash(prompt) + hash(inputs)`.
The SDK cannot see a prompt inside a closure, so the honest form of that rule is: **the key is
`sha256(canonical({ id, schema, inputs }))`, and the prompt is one of the inputs.** The API makes
this the natural way to write a step — `fn` receives the declared inputs, so building a prompt
from something undeclared is visibly odd:

```ts
const review = await orc.step("review:1", { schema: Review, inputs: { prompt, diff } },
  ({ prompt, diff }) => orc.agent("reviewer").ask(`${prompt}\n\n${diff}`, { schema: Review }));
```

Downstream invalidation follows from the same rule: a step that declares an upstream value as an
input re-runs when that value changes, and a step that does not is, correctly, untouched. This is
what acceptance 3 tests. The step record also stores the sha256 of every prompt actually sent
during its execution, *observed* rather than declared, so `orc show` can reveal a step whose
prompt changed without its key changing — a workflow bug made visible, not silently served stale.

### 2.5 Escalation ids, and what `amend` means here

`orc.escalate(reason, context)` keeps the two-argument signature from D4. Its id is
`slug(reason) + "-" + n`, where `n` counts escalations with the same reason in program order
within the run. Memoized steps replay deterministically up to the escalation, so the id is stable
across resume; a workflow edit that changes control flow changes ids, which is right.

`abort` and `proceed` are exactly D4. `amend` in phase 1 is `amend:<step-id>`: the answer is
recorded, that step's artifact is deleted, and the run stops so it can be resumed. An `amend`
answer is **consumed** on the resume that acts on it (`consumed: true` in the record), so if the
same escalation is reached again it is asked again rather than deleting the step in a loop. Editing
the artifact by hand and resuming, poc-v2's fuller meaning, works too: the artifact keeps its key,
so an edited value is served as a hit. Neither is more than that in this phase.

### 2.6 A policy field that is not enforced is not accepted

`defineConfig` in phase 1 accepts `roles.<name>.tools`, `roles.<name>.model`,
`roles.<name>.maxTurns`, `defaults`, and `limits`. An unknown key **throws at freeze time**. The
alternative — accepting `egress` and `secrets` now and ignoring them — is a config that claims a
policy nobody enforces, which is worse than a config that cannot say it. Each later phase widens
the accepted set exactly as far as it enforces.

### 2.7 One process per `ask()` and `run()`; sessions for everything longer

`orc.agent(role).run()` and `.ask()` spawn a fresh `pi`, prompt once, collect, and stop it.
`.session()` keeps the process for `send()` / `next()` / `ask()` / `close()`. `fork()` is not in
this phase (phases.md §4 does not list it; phase 3 owns session-tree work).

### 2.8 Every agent gets a private `HOME`

The runner sets `HOME` to `agents/<id>/home/` in the run directory, empty at spawn. The developer's
own `~/.pi/agent/` — settings, extensions, trust decisions, auth — never loads into a run. Two
reasons: the config hash is only honest if the loaded extensions are exactly the ones it hashed,
and phase 2's sandbox has no host `HOME` either, so nothing should start depending on one now.

### 2.9 A turn is Pi's `turn_start`, and caps are enforced by the runner

`maxTurns` counts `turn_start` events per agent process. On the cap the runner sends `abort`,
awaits `agent_end`, and the pending `run()` / `next()` / `ask()` rejects with `TurnCapError`. The
run-level cap (`limits.maxTurns`) is summed across agents by the SDK and enforced the same way on
the agent that crosses it. Defaults: 40 per agent, 200 per run — a runaway loop on Sonnet costs
dollars, not tens of dollars, before it stops.

### 2.10 The diff is read by the runner, never reported by the agent

`AgentResult.diff` is produced by the runner running `git add -N . && git diff HEAD` in the agent's
workspace after the turn settles. The reviewer in the loop-and-escape example reads a diff the
implementation agent could not have authored — the same principle as `verify`, applied to the one
other fact that crosses between agents in this phase. `git add -N` is intent-to-add so untracked
files appear in the diff; it changes the index and nothing else.

### 2.11 Naming

Packages are `@orc/sdk`, `@orc/runner`, `@orc/pi`, `@orc/cli` under `packages/sdk`,
`packages/runner`, `packages/pi`, `packages/cli`. [poc.md](../poc.md) §6's `orc-sdk/` spellings
are superseded by the scoped names phases.md already uses. Agent ids are `<role>-<nn>`, sequential
per run. Run ids are `<UTC basic timestamp>-<4 base36>`, e.g. `20260922T140311Z-k3f9`, so a
directory listing sorts by time.

---

## 3. Layout

```
package.json                 pnpm workspace; scripts: check, test, accept:phase1
pnpm-workspace.yaml
tsconfig.base.json
packages/
  sdk/                       @orc/sdk
    src/config.ts            defineConfig, role, freeze, canonical JSON, hash
    src/workflow.ts          defineWorkflow, the Orc object, step, escalate, verify, parallel, phase
    src/rundir.ts            the run directory: create, open, read, write every record in §4
    src/agent.ts             AgentHandle, AgentSession, AgentResult — over @orc/runner
    src/telemetry.ts         tracer setup, JSONL exporter, span helpers
    src/errors.ts            TurnCapError, AskError, EscalatedError, AbortedError
  runner/                    @orc/runner
    src/pi-process.ts        spawn pi, JSONL framing, send, awaitEvent, event tap, abort, timeout
    src/sandbox.ts           Sandbox interface
    src/local-process.ts     LocalProcessSandbox: clone, spawn, exec, diff, stop
    src/agent-file.ts        read/write the agent file (§4.4), shared with @orc/pi
    test/fake-pi.ts          a scripted process that speaks Pi's RPC framing (§9, slice 1.1)
  pi/                        @orc/pi — the extension loaded into every agent
    src/index.ts             registers the gate, submit_result, project_trust
    src/gate.ts              decide(policy, toolName): pure, unit-tested without Pi
    src/models.ts            resolveModels(): returns a constant
  cli/                       @orc/cli — the `orc` binary
    src/commands/{run,resume,runs,show,trace,answer}.ts
examples/
  loop-and-escape/           workflow.ts, README.md
  fan-out/                   workflow.ts, README.md
accept/phase1/               one test file per acceptance criterion (§10); seed.ts holds the sha
spikes/                      phase 0, untouched, imported by nothing
```

`@orc/pi` is loaded with `pi -e packages/pi/dist/index.js`. Its `package.json` carries the
`pi-package` keyword and `pi.extensions` so it is also installable the upstream way later; phase 1
uses the flag because the path is known and the hash needs the exact file.

---

## 4. The run directory

Version 1 of the layout phases.md §4 says this plan fixes. Every file is JSON or JSONL, UTF-8, LF.
Every JSON record carries `"version": 1`. Paths are relative to `<runs-dir>/<run-id>/`; the
default runs dir is `.orc/runs/` under the directory `orc run` was invoked from, overridable with
`--runs-dir` and `ORC_RUNS_DIR`.

```
run.json
config.json
steps/<encoded-step-id>.json
escalations/<escalation-id>.json
verify/<encoded-verify-id>.json
agents/<agent-id>/
  agent.json
  events.jsonl
  commands.jsonl
  pi.stderr.log
  session/                   Pi's --session-dir; Pi names the file inside
  home/                      Pi's HOME for this agent (§2.8)
  workspace/                 the agent's clone (D1)
trace.jsonl
log.jsonl
```

Ids for steps and verifies match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`; the file name is
`encodeURIComponent(id) + ".json"`, so `arbitrate:3` lives at `steps/arbitrate%3A3.json`. Agent
and escalation ids are generated by orc and need no encoding.

The workspace clone lives inside the run directory on purpose: `tudu` is small, a failed run's
tree is the first thing to look at, and there is nothing to clean up separately. Phase 2 moves it
into the container and `agent.json`'s `workspace` field becomes the container path.

### 4.1 `run.json`

```jsonc
{
  "version": 1,
  "id": "20260922T140311Z-k3f9",
  "workflow": { "name": "loop-and-escape", "file": "examples/loop-and-escape/workflow.ts" },
  "input": { "task": "..." },
  "workspace": { "source": "/path/or/url", "ref": "<sha>" },
  "configHash": "sha256:…",
  "status": "running" | "completed" | "failed" | "aborted" | "escalated",
  "startedAt": "2026-09-22T14:03:11.000Z",
  "endedAt": null,
  "result": null,                // the workflow's return value on completion
  "error": null,                 // { name, message, stack } on failure
  "turns": 0,                    // run-level turn count, updated as agents finish turns
  "pi": { "version": "0.86.1" },
  "orc": { "version": "0.1.0" }
}
```

Written at creation, rewritten atomically (write to `run.json.tmp`, rename) on every status change.
`orc resume` rejects a run whose status is `running` unless the recorded pid is dead.

### 4.2 `config.json`

The frozen config snapshot plus what went into the hash:

```jsonc
{
  "version": 1,
  "config": { /* the defineConfig value, canonical */ },
  "hash": "sha256:…",
  "hashInputs": {
    "config": "sha256:…",
    "extensions": { "packages/pi/dist/index.js": "sha256:…" },
    "skills": {}
  }
}
```

**`hash = sha256(canonical(hashInputs))`.** Canonical JSON is: keys sorted, no whitespace,
numbers as shortest round-trip, strings as JSON escapes; the one implementation lives in
`@orc/sdk/config.ts` and every hash in this phase uses it. Phase 1 loads exactly one extension and
no skills; the shape is the one [observability.md](../observability.md) §1 needs from the first
run.

### 4.3 `steps/`, `escalations/`, `verify/`

```jsonc
// steps/<id>.json
{
  "version": 1,
  "id": "review:1",
  "key": "sha256:…",             // sha256(canonical({ id, schema, inputs }))
  "inputs": { /* as declared */ },
  "value": { /* validated against schema */ },
  "createdAt": "…", "durationMs": 1234,
  "observed": { "agents": ["reviewer-02"], "prompts": ["sha256:…"] },
  "amended": false
}
// escalations/<id>.json
{
  "version": 1,
  "id": "three-review-rounds-without-approval-1",
  "reason": "Three review rounds without approval",
  "context": { /* as given */ },
  "askedAt": "…",
  "answer": null | { "action": "abort" | "proceed" | "amend", "step": "review:3", "note": "", "answeredAt": "…" },
  "consumed": false
}
// verify/<id>.json
{
  "version": 1,
  "id": "tests:2",
  "cmd": "pnpm test", "cwd": "agents/backend-01/workspace",
  "exitCode": 1, "signal": null,
  "stdout": "…", "stderr": "…", "truncated": false,     // each capped at 1 MiB
  "sha": "<git HEAD in cwd>", "dirty": true,
  "startedAt": "…", "durationMs": 8123
}
```

A step lookup reads the file for the id; the key matches → hit, the value is returned without
running `fn`; the key differs or the file is absent → miss, `fn` runs, the record is overwritten.
`context` in an escalation is stored as given but truncated to 64 KiB with `"truncated": true`
— it is for a human to read, not a channel for data.

### 4.4 `agents/<id>/`

`agent.json` is the **agent file**: written by the SDK before spawn, read by `@orc/pi` through
`ORC_AGENT_FILE`, updated by the runner as the agent progresses. It is the only channel from orc
to the extension in this phase.

```jsonc
{
  "version": 1,
  "id": "reviewer-02", "role": "reviewer",
  "model": { "provider": "anthropic", "id": "claude-sonnet-5" },
  "policy": { "tools": { "allow": ["read", "grep", "find", "ls"], "deny": [] }, "maxTurns": 40 },
  "ask": null | { "schema": { /* JSON Schema */ }, "description": "…" },
  "workspace": "agents/reviewer-02/workspace",
  "sessionFile": null | "agents/reviewer-02/session/<name>.jsonl",
  "pid": 12345,
  "status": "starting" | "idle" | "running" | "stopped" | "failed" | "turn_cap",
  "turns": 0,
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0, "provisional": true },
  "startedAt": "…", "endedAt": null
}
```

`events.jsonl` holds every RPC event received, one per line, wrapped as `{ "t": <receive ms>,
"event": { … } }` — Pi's event verbatim, per [poc.md](../poc.md) §5. `commands.jsonl` holds every
command sent, same wrapping. Together they are the raw material `orc trace` and phase 3's replay
read; nothing derived is stored that could not be recomputed from them.

### 4.5 `trace.jsonl` and `log.jsonl`

`trace.jsonl`: first line `{ "resource": { "service.name": "orc", "orc.run.id": …,
"orc.config.hash": … } }`; every following line one finished span:
`{ traceId, spanId, parentSpanId, name, startUnixNano, endUnixNano, attributes, status, events }`.
Span names and attributes are in §7. `log.jsonl` is `orc.log` output: `{ t, level, msg, ...fields }`.

---

## 5. The SDK surface, phase 1

The subset of [plugin-api.md](../plugin-api.md) §4 this phase builds, made exact. Differences from
that document are marked ▲ and are either phase-1 scoping or a correction to record there when
the surface stabilizes at phase 3.

```ts
// @orc/sdk
export function defineConfig(c: ConfigInput): FrozenConfig;   // deep-frozen; unknown keys throw (§2.6)
export function role(r: RoleInput): RoleInput;                // identity with types; exists so a config reads as plugin-api.md shows

interface ConfigInput {
  defaults?: { model?: string; maxTurns?: number };
  roles: Record<string, RoleInput>;
  limits?: { maxAgents?: number; maxTurns?: number };
}
interface RoleInput {
  model?: string;                                             // default "claude-sonnet-5"
  tools: { allow?: string[]; deny?: string[] };               // names, or a trailing-* glob
  maxTurns?: number;
}

export function defineWorkflow<I, O>(
  name: string, fn: (orc: Orc, input: I) => Promise<O>,
): Workflow<I, O>;

interface Orc {
  agent(role: string): AgentHandle;
  parallel<T>(fns: (() => Promise<T>)[], opts?: { maxConcurrency?: number }): Promise<T[]>;
  step<T, In extends Record<string, unknown>>(
    id: string,
    opts: { schema: ZodType<T>; inputs?: In; description?: string },
    fn: (inputs: In) => Promise<T>,
  ): Promise<T>;                                              // ▲ inputs are the key (§2.4)
  escalate(reason: string, context?: unknown): Promise<EscalationAnswer>;
  verify(id: string, opts: { cmd: string; cwd: Workspace | string; timeoutMs?: number }): Promise<VerifyResult>;
                                                              // ▲ on orc, not ctx: no slice context exists yet
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;   // ▲ span-only grouping; nothing else
  fail(reason: string): never;
  log: { info(msg: string, fields?: object): void; warn(...): void; error(...): void };
}

interface AgentHandle {
  run(prompt: string, opts?: RunOptions): Promise<AgentResult>;
  ask<T>(prompt: string, opts: RunOptions & { schema: ZodType<T>; description?: string }): Promise<T>;
  session(opts?: RunOptions): Promise<AgentSession>;
}
interface RunOptions { maxTurns?: number }                     // may narrow the role's cap, never widen it

interface AgentSession {
  readonly id: string;
  readonly workspace: Workspace;
  send(text: string, opts?: { mode?: "steer" | "followUp" }): Promise<void>;
  next(): Promise<AgentResult>;                               // resolves at the next agent_end
  ask<T>(prompt: string, opts: { schema: ZodType<T>; description?: string }): Promise<T>;
                                                              // ▲ present if slice 1.8's re-registration check passes
  events(): AsyncIterable<PiEvent>;                           // Pi's events, verbatim
  close(): Promise<void>;
}

interface AgentResult {
  text: string;                                               // last assistant text
  diff: string;                                               // runner-read (§2.10)
  turns: number;
  usage: Usage;                                               // provisional: true
}
interface VerifyResult { id; exitCode; signal; stdout; stderr; durationMs; sha; dirty }
type EscalationAnswer = { action: "abort" | "proceed" } | { action: "amend"; step: string };
```

Semantics that are not obvious from the types:

- **`escalate` never returns `abort`.** An `abort` answer throws `AbortedError`, which the CLI turns
  into status `aborted`, exit 2. A workflow that wants to handle abort itself has no reason to; the
  human just said stop. `proceed` returns. `amend` throws `EscalatedError` after deleting the step,
  so the process stops for resume.
- **`escalate` without an answer** (non-TTY, or the human declined to answer) throws
  `EscalatedError`; status `escalated`, exit 3, with the `orc answer` command printed.
- **`ask` validates with the Zod schema.** No `submit_result` call, or an invalid one, gets one
  retry prompt naming the problem; a second failure throws `AskError` carrying the last text. Both
  attempts count as turns.
- **`parallel` defaults `maxConcurrency` to `limits.maxAgents`** (default 4). It is the only
  concurrency primitive; nothing stops a workflow from `Promise.all`, and nothing caps it either.
- **`verify` runs in the workflow process**, with `child_process.spawn` through the `Sandbox`'s
  `exec`, never through Pi's RPC `bash` command — that command runs inside the agent's process and
  lands in the agent's session, which is exactly the property `verify` exists to avoid.

---

## 6. The runner and the extension

### 6.1 `PiProcess` — the RPC bridge

Rewrites phase 0's `lib/rpc.ts` with tests. Spawns

```
pi --mode rpc --provider anthropic --model <model> --session-dir <agent>/session -e <orc-pi entry>
  cwd:  <agent>/workspace
  env:  the orc process's env, plus HOME=<agent>/home, ORC_AGENT_FILE=<agent>/agent.json
```

and speaks JSONL both ways under the two framing rules from phase 0: LF is the only record
delimiter, and no generic line reader that splits on U+2028/U+2029. Readiness is a `get_state`
round-trip. Surface: `send(cmd)`, `awaitEvent(type, pred?, timeoutMs)`, `on(event)`, `abort()`,
`stop()` (abort, then SIGTERM, then SIGKILL after 5s). Every event is appended to `events.jsonl`
with its receive time before any handler sees it; every command to `commands.jsonl`.

### 6.2 `Sandbox` and `LocalProcessSandbox`

```ts
interface Sandbox {
  start(spec: { agentDir: string; source: string; ref: string }): Promise<SandboxHandle>;
}
interface SandboxHandle {
  readonly workspace: string;
  spawnPi(opts: { model: string; extension: string }): Promise<PiProcess>;
  exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<ExecResult>;
  diff(): Promise<string>;
  stop(): Promise<void>;
}
```

`LocalProcessSandbox.start` does `git clone --no-hardlinks <source> <agent>/workspace && git
checkout <ref>` (a local path or a URL; `tudu` is a path on this machine in phase 1), creates
`home/` and `session/`, and returns the handle. Phase 2's `LocalDockerSandbox` implements the same
four methods against a container. Nothing above the interface knows the difference — that is the
seam, and this phase is the one that fixes its shape.

### 6.3 `@orc/pi`

Loaded into every agent. Three registrations and one export:

- **`session_start`**: read `ORC_AGENT_FILE`; cache `policy`. If the file is missing or unreadable,
  **throw** — an agent running without its policy is the silent failure spike 6 warned about.
- **`tool_call`**: `decide(policy, toolName)` → allow, or `{ block: true, reason: "orc: tool
  '<name>' is not permitted for role '<role>'" }`. `decide` is pure: `submit_result` is always
  allowed; a name in `deny` is blocked; if `allow` is set, a name not in it is blocked; otherwise
  allowed. Globs are a trailing `*` only.
- **`before_agent_start`**: re-read the agent file; if `ask` is set, `registerTool("submit_result",
  { parameters: ask.schema, description: ask.description })` whose `execute` returns `{ content:
  [{ type: "text", text: "recorded" }], terminate: true }`. The runner finds the args in the
  `tool_execution_start` event, not in the tool's return.
- **`project_trust`**: `{ trusted: "yes", remember: false }`. The workspace is a clone orc chose.
- **`resolveModels()`**: returns `[{ provider: "anthropic", id: "claude-sonnet-5" }]`. Called by
  the CLI at config freeze to reject a role naming a model not in the list. One implementation,
  a constant, per [poc.md](../poc.md) §4.

The reason string's `orc:` prefix is how the runner recognises a blocked call in
`tool_execution_end` and sets `orc.tool.blocked` on the span — confirm against spike 1's finding
what event a blocked call actually produces.

### 6.4 An `ask()` end to end

1. SDK allocates `agents/<role>-<nn>/`, writes `agent.json` with `policy` and `ask`.
2. `Sandbox.start` clones; `spawnPi` starts Pi with the extension; readiness round-trip.
3. SDK sends `prompt` with the user's text plus one fixed trailer: *"When you are done, call
   `submit_result` with your answer. Do not answer in prose."* The trailer is part of the prompt
   hash observed on the enclosing step.
4. Runner counts `turn_start`, records `usage` from each `message_update`, opens and closes turn
   and tool spans, enforces the cap.
5. On `agent_end`: the last `tool_execution_start` with `toolName === "submit_result"` supplies the
   args; Zod validates; on failure, one retry prompt, then `AskError`.
6. `stop()`; `agent.json` gets `status`, `turns`, `usage`, `endedAt`; the agent span closes.

`run()` is steps 1–2, 4, 6 with the raw prompt and `AgentResult` assembled from the last assistant
text and `diff()`. `session()` is steps 1–2 once, then 3–5 per `send`/`next`/`ask`, and 6 at
`close()`.

---

## 7. Telemetry

One tracer, one trace per run, spans opened and closed by the SDK and runner, exported by the
JSONL exporter (§2.1). Attribute names follow [observability.md](../observability.md) §4: borrowed
`gen_ai.*` where the convention has the concept, `orc.*` otherwise. The resource carries
`orc.run.id` and `orc.config.hash`, so every span carries them.

| Span | Parent | Attributes |
| --- | --- | --- |
| `orc.run` | — | `orc.workflow.name`, `orc.run.status` |
| `orc.phase` | run | `orc.phase.name` |
| `orc.step` | run or phase | `orc.step.id`, `orc.step.cache` = `hit` \| `miss` |
| `orc.escalate` | run or phase | `orc.escalation.id`, `orc.escalation.action` |
| `orc.verify` | run, phase or step | `orc.verify.id`, `orc.verify.exit_code`, `orc.verify.sha` |
| `orc.agent` | run, phase or step | `gen_ai.operation.name` = `invoke_agent`, `gen_ai.agent.name` = role, `orc.agent.id`, `gen_ai.request.model`, `orc.agent.turns`, `orc.agent.status` |
| `orc.turn` | agent | `orc.turn.index`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `orc.usage.cache_read_tokens`, `orc.usage.cache_write_tokens`, `orc.usage.cost_usd`, `orc.usage.provisional` = `true` |
| `orc.tool` | turn | `gen_ai.operation.name` = `execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `orc.tool.blocked`, `error.type` when `isError` |

Turn spans open on `turn_start` and close on `turn_end`; tool spans on `tool_execution_start` /
`_end` paired by `toolCallId`; durations are the runner's clock, per spike 5. Usage is summed from
`message_update` deltas within the turn and labelled provisional, because it is Pi's arithmetic on
Pi's price table and the broker replaces it in phase 2. **No metrics pipeline in this phase**:
totals live on spans and in `agent.json`, and there is nothing yet to aggregate across runs.

`orc trace <run>` prints the span tree from `trace.jsonl` as indented text — name, duration, and
the attributes worth a glance (cache hit, exit code, turns, blocked) — and nothing more. `--otlp
<url>` adds an OTLP/HTTP exporter alongside the JSONL one for the runs where Jaeger is wanted.

---

## 8. The examples

### 8.1 `loop-and-escape`

The workflow phases.md §4 names, against `tudu`, structured as [plugin-api.md](../plugin-api.md)
§2.1 with the phase-1 surface:

```ts
export const config = defineConfig({
  roles: {
    backend:   role({ tools: { allow: ["read", "write", "edit", "bash", "grep", "find", "ls"] } }),
    reviewer:  role({ tools: { allow: ["read", "grep", "find", "ls"], deny: ["write", "edit", "bash"] } }),
    architect: role({ tools: { allow: ["read", "grep", "find", "ls"] } }),
  },
  limits: { maxTurns: 150 },
});

export default defineWorkflow("loop-and-escape", async (orc, input: { task: string }) => {
  const impl = await orc.agent("backend").session();
  await impl.send(`${input.task}\n\nRun \`pnpm test\` yourself before you stop.`);

  let work: AgentResult;
  for (let round = 1; ; round++) {
    work = await impl.next();
    const tests = await orc.verify(`tests:${round}`, { cmd: "pnpm test", cwd: impl.workspace });
    const review = await orc.step(`review:${round}`,
      { schema: Review, inputs: { diff: work.diff, green: tests.exitCode === 0 } },
      ({ diff, green }) => orc.agent("reviewer").ask(reviewPrompt(diff, green), { schema: Review }));

    if (review.approved && tests.exitCode === 0) break;

    // Bounded retries, then a human — not more budget.
    if (round >= 3) {
      await orc.escalate("Three review rounds without approval", { review, tests: tests.exitCode });
      break;                                          // proceed: risk recorded
    }
    // A design problem is not fixed by iterating on the implementation: go back a phase.
    if (review.needsRedesign) {
      const plan = await orc.step(`replan:${round}`, { schema: Plan, inputs: { blocking: review.blocking } },
        ({ blocking }) => orc.agent("architect").ask(replanPrompt(input.task, blocking), { schema: Plan }));
      await impl.send(`The approach changed. Start again from this plan:\n${plan.text}`);
      continue;
    }
    await impl.send(`Address these blocking issues:\n${review.blocking.join("\n")}`);
  }

  const final = await orc.verify("tests:final", { cmd: "pnpm test", cwd: impl.workspace });
  await impl.close();
  return { green: final.exitCode === 0, diff: work.diff };
});
```

The example's `README.md` states the pinned `tudu` sha and the task the acceptance run uses. The
task must be real, small, and **not one of the benchmark features or build-outs** in
[fixture.md](../fixture.md) §4: the suggested one is *"Cap to-do titles at 200 characters, with a
unit test."* It lands in `src/lib/todos.ts` beside `createTodo`, and `pnpm test` is the gate.

The previously suggested task — rejecting empty or whitespace-only titles — **is already true at
`592f4de`**: `createTodo` trims and returns `null`. That is the check this paragraph asks for,
performed. Do it again if the pin moves.

Acceptance 1 says this must read like ordinary TypeScript to someone who has not seen orc. The
test is: every comment in the file is about the task or the control flow, and none explains an
`orc.*` call. A `Plan` and `Review` schema and two prompt builders live beside it.

### 8.2 `fan-out`

Three `reader` agents (read-only tools) answer one question each about `tudu` — what
`src/lib/todos.ts`, `src/hooks/useTodos.ts` and `src/components/TodoList.tsx` do — via `ask()` with
a small schema, under `orc.parallel` with `maxConcurrency: 2`, then one `orc.step` assembles the
answers. Cheap, and exercises concurrency,
per-role policy, and `parallel`'s cap in one run.

---

## 9. Slices

Cut per CLAUDE.md's rule: each merges on its own, is verified by something that exits 0 or 1, and
fits one session. Build in numeric order except where the dependency column allows otherwise.
Every slice adds its tests to `pnpm test`, which runs with **no key and no seed**; live checks are
gated by `ORC_LIVE=1` and skipped otherwise.

| # | Slice | Delivers | Verified by | Depends on |
| --- | --- | --- | --- | --- |
| 1.0 | Scaffold | pnpm workspace, four package skeletons, `tsconfig.base.json`, vitest, eslint + prettier, `pnpm check` = build + lint + test | `pnpm check` exits 0 with one placeholder test per package | — |
| 1.1 | RPC bridge | `PiProcess` (§6.1); `test/fake-pi.ts` | Unit tests against fake-pi: framing (CRLF stripped, U+2028 inside a string survives), `prompt`→`agent_end`, `abort` mid-turn, timeout rejects, events/commands logged in order. `ORC_LIVE` smoke: one Haiku turn | 1.0 |
| 1.2 | Config and hash | `defineConfig`, `role`, deep freeze, unknown-key rejection, canonical JSON, `hash` | Mutation throws; hash identical under key reordering; a golden hash for a fixture config; `egress:` in a role throws | 1.0 |
| 1.3 | Run directory | `rundir.ts`: create, open, every record in §4; `orc runs`, `orc show` | A scripted writer produces a run dir whose `find . -type f \| sort` equals a checked-in listing (byte-level layout); each record round-trips through its reader; id encoding test | 1.2 |
| 1.4 | `orc run`, `orc resume`, `orc.step` | CLI loads a workflow file, freezes config, creates the run dir, runs it, sets status and exit code; `step` with lookup, key, observed prompts | **Acceptance 3** on an agentless workflow: run once, resume → every step hit; change one step's declared input → that step and its declared dependents miss, nothing else | 1.3 |
| 1.5 | Escalation | `orc.escalate`, TTY prompt, non-TTY exit 3, `orc answer`, `amend` consumption | **Acceptance 4**: non-TTY run exits 3; `orc answer … proceed`; resume completes without asking; a second resume still does not ask. `amend` deletes the step and is consumed | 1.4 |
| 1.6 | Sandbox seam and verify | `Sandbox`, `LocalProcessSandbox` minus `spawnPi`, `orc.verify` | **Acceptance 5** on a repo the test creates with `git init`: `exit 3` yields `exitCode: 3`; stdout captured; `sha` equals `git rev-parse HEAD`; record on disk; a 1 MiB+ output is truncated with the flag | 1.3 |
| 1.7 | `@orc/pi` | The extension (§6.3), `decide()`, `resolveModels()` | `decide()` table test with no Pi. `ORC_LIVE`: **acceptance 2** — a `deny: ["bash"]` role is prompted to `touch` a file; the file does not exist after `agent_end` and the blocked reason appears in `events.jsonl` | 1.0 |
| 1.8 | Agent handles | `spawnPi`, `AgentHandle`, `AgentSession`, ask validation and retry, turn caps, `agent.json` lifecycle, `diff()` | Fake-pi: `run()` returns text and a diff the fake wrote; `session` `send`/`next` twice; cap at 3 turns → `abort` sent and `TurnCapError`; ask parses `submit_result` args; invalid args → one retry then `AskError`. `ORC_LIVE`: `ask()` 3/3 valid on Haiku; **first**, the re-registration check for `session.ask()` (§2.2) — if it fails, `session.ask` is removed from §5 and this row | 1.1, 1.4, 1.6, 1.7 |
| 1.9 | `parallel` | Semaphore, `limits.maxAgents` default | Fake-pi: six agents under `maxConcurrency: 2`; the fake records overlap; peak ≤ 2 | 1.8 |
| 1.10 | Telemetry | Tracer, JSONL exporter, every span in §7, `orc trace`, `--otlp` | Agentless run: `trace.jsonl` parses, resource line carries the hash, step spans nest under run. Fake-pi run: run → agent → turn → tool nesting, blocked flag set. `--otlp` against a local HTTP listener receives a request | 1.4, 1.8 |
| 1.11 | Examples | `loop-and-escape`, `fan-out`, READMEs with the pinned sha | `ORC_LIVE` against `tudu`: both complete (**acceptance 1**), read by a person for the comment rule | 1.5, 1.9, 1.10 |
| 1.12 | Acceptance suite | `accept/phase1/`, `pnpm accept:phase1` | Exits 0 with a key and the seed present; exits 1, not skip, without them | 1.11 |

`fake-pi.ts` is a scripted process: it reads a scenario file naming, per prompt, the events to
emit in order with delays (Pi's real event names and shapes, nothing invented), honours `abort`
and `get_state`, and can write files into its cwd so `diff()` has something to read. It exists so
CI needs neither a key nor a model. It is **not** a recording format — phase 3's replay of real
session JSONL supersedes it for everything above the protocol layer, and it stays only as
`@orc/runner`'s unit-test double.

---

## 10. Acceptance suite

`pnpm accept:phase1` runs `accept/phase1/*.test.ts` with `ORC_LIVE=1` forced, against `tudu` at
`seed.ts`'s sha, and **fails rather than skips** when the key or the seed is absent. One file per
criterion in phases.md §4:

| # | Criterion | Test |
| --- | --- | --- |
| 1 | Loop-and-escape runs end to end and reads as the task | `01-loop.test.ts`: `orc run examples/loop-and-escape` exits 0 or 3, `run.json` status is `completed` or `escalated`, at least one `review:*` step and one `tests:*` verify exist. The readability half is a checklist in the README, ticked by a person — the one non-executable line in this phase, kept because poc.md §8 says it is the criterion most worth being strict about |
| 2 | A deny-listed tool never executes | `02-deny.test.ts`: slice 1.7's live test |
| 3 | Memoization and invalidation | `03-memo.test.ts`: slice 1.4's test, run through the CLI on the agentless workflow |
| 4 | Escalation answered once is not re-asked | `04-escalate.test.ts`: slice 1.5's test |
| 5 | `verify` returns an exit code the agent did not produce | `05-verify.test.ts`: slice 1.6's test, plus one live check that a `backend` agent told to make `pnpm test` pass by editing the test command cannot affect `verify`'s record |
| 6 | A trace exists with the nesting and the hash | `06-trace.test.ts`: on the run from test 1, `trace.jsonl` has an `orc.run` span with `orc.agent` → `orc.turn` → `orc.tool` descendants and the resource hash equals `config.json`'s |

---

## 11. Exit criteria

1. `pnpm check` exits 0: every package builds, lints, and its no-key tests pass.
2. `pnpm accept:phase1` exits 0 against `tudu` at the pinned sha with a real key.
3. A person has run `orc run examples/loop-and-escape`, then `orc show` and `orc trace` on it, and
   ticked the readability checklist.
4. `docs/phases.md` §4's "left open" block records §2.1, and
   [observability.md](../observability.md) §6 says where telemetry lands.
5. Every ▲ in §5 is either resolved in [plugin-api.md](../plugin-api.md) or listed in §13.
6. Spend for the phase, from the provisional usage in every run's `agent.json`, is under $15.

---

## 12. Sizing and budget

**Two to three weeks for one person.** Slices 1.0–1.6 and 1.10 are pure plumbing and go fast;
1.8 is the one that will take longer than it looks, because it is where the RPC bridge, the
sandbox, the extension and the agent file meet for the first time.

**Model spend is bounded by construction**: `pnpm test` spends nothing; live tests run Haiku turns
that cost cents; a loop-and-escape run on Sonnet against `tudu` is on the order of a dollar. Ten
such runs plus development is the $15 in exit criterion 6, well inside the $50 month
([phases.md](../phases.md) §15 Q3). If a run ever costs more than a few dollars, the turn caps
are wrong before anything else is.

---

## 13. Open items

1. **§1.2 is assumed.** Replace it with `FINDINGS.md`'s lines before slice 1.1; re-cut what they
   contradict.
2. **`session.ask()` depends on re-registering `submit_result` with a new schema replacing the
   old.** Checked first in slice 1.8; removed from the surface if it does not hold.
3. **What event a blocked tool call produces.** §6.3 assumes `tool_execution_end` with the reason
   in `result`; spike 1's finding says which, and `orc.tool.blocked` follows it.
4. **Pi's version is not in the config hash.** observability.md §1 lists what a configuration is
   and Pi's version is not on it, so the hash follows the doc and `run.json` records the version
   beside it. If a re-pin ever needs to be compared across, `orc compare` groups by both. Promote
   to the hash if that ever happens.
5. **`amend` is minimal** (§2.5): delete the step, stop, resume. The "edit the artifact" reading is
   supported by accident of the key mechanism, not by a UI. Enough until the console.
6. **Workspaces inside the run directory** are fine for `tudu` and would not be for a large repo.
   Phase 2 moves them into the container anyway.
7. **Provisional cost is Pi's arithmetic.** `usage.cost` comes from Pi's price table for
   `claude-sonnet-5`; it is labelled provisional everywhere it appears and the broker replaces it
   in phase 2. Do not compare configurations on it.
8. **The suggested task in §8.1 may already be true at the seed commit.** Check before pinning.
9. **`resolveModels()` is a constant the CLI checks against**, not yet wired to Pi's model list.
   Wiring it as the argument to Pi's model refresh is the phase 6 change that opens the seam.
