# orc

An agent orchestration framework built on [Pi](https://github.com/earendil-works/pi) as the agent harness.

`orc` runs fleets of Pi agents in isolated sandboxes on AWS, behind a proxy layer that
holds every secret so agents never do. Orchestration logic is written as Pi-style
plugins that live in your repo and version with your code.

## The shape of it

```
your-repo/
  .pi/
    extensions/orchestrate.ts   <- your orchestration plugin (a Pi extension)
    skills/                     <- role instructions for the agents you spawn
  orc.config.ts                 <- agent roles, model policy, egress allowlist, secret scopes
```

```bash
orc dev              # run the whole stack locally against Docker
orc run ship-feature # run it on AWS
```

## Three properties, by design

1. **Agents never hold secrets.** Sandboxes receive sentinel credentials. The broker
   swaps in real ones at network egress and never returns them inward.
2. **Egress is deny-by-default.** An agent reaches exactly the hosts its run policy
   names, and nothing else. There is no NAT gateway to leak through.
3. **Orchestration is TypeScript in your repo.** No YAML, no DAG format. Plugins are ordinary Pi
   packages — extensions, skills, prompt templates — reviewed, versioned, and tested like the rest
   of your code. Loops, escape hatches and conditional re-entry are just control flow.

## Documentation

| Document | What's in it |
| --- | --- |
| [docs/plan.md](docs/plan.md) | The development plan: architecture, components, milestones, risks |
| [docs/proxy-design.md](docs/proxy-design.md) | The broker — sentinel credentials, egress policy, threat model |
| [docs/plugin-api.md](docs/plugin-api.md) | Writing orchestration plugins, the SDK surface, `orc.config.ts` |
| [docs/phases.md](docs/phases.md) | The build order: nine playable phases with acceptance criteria |
| [docs/poc.md](docs/poc.md) | POC v1: what's in, what's deliberately deferred |
| [docs/poc-v2.md](docs/poc-v2.md) | POC v2: the feature-delivery workflow, scheduling, gates |
| [docs/environments.md](docs/environments.md) | Sandbox environments from the repo's dev container |
| [docs/observability.md](docs/observability.md) | OTEL metrics, and how to compare configurations |
| [docs/console.md](docs/console.md) | The console and connectors: intake, interaction, observation |
| [docs/decision-layer.md](docs/decision-layer.md) | Fast typed decisions (Jev) behind an LLM-backed interface |
| [docs/fixture.md](docs/fixture.md) | The `tudu` seed: what the target repo must contain per phase |

## Working on it

```bash
pnpm install          # pnpm only, never npm or npx — see CLAUDE.md
pnpm check            # build, typecheck, lint, test: what CI runs on every pull request
pnpm test             # vitest; no model key and no seed repo required
ORC_LIVE=1 pnpm test  # also the live checks: needs ANTHROPIC_API_KEY, spends cents
```

The workspace is `packages/sdk`, `packages/runner`, `packages/pi` and `packages/cli`.
`spikes/` sits outside it, frozen at phase 0 and imported by nothing.

Status: **design complete; phase 0 spikes run and closed out; phase 1 is under way.** Slice 1.0 —
the workspace scaffold and the CI gate — and slice 1.1 — `PiProcess`, the RPC bridge to Pi, with
its scripted test double — have landed. `@orc/sdk`, `@orc/pi` and `@orc/cli` are still skeletons.

**New here (or starting a fresh session)? Read [CLAUDE.md](CLAUDE.md) first** — reading order, the
nine decisions and what they rest on, what was rejected and why, and the triage of what is still
open (nothing of which blocks starting).
