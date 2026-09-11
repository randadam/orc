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
  orc.yaml                      <- agent roles, model policy, egress allowlist, secret scopes
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
3. **Orchestration is code in your repo.** Plugins are ordinary Pi packages — extensions,
   skills, prompt templates — reviewed, versioned, and tested like the rest of your code.

## Documentation

| Document | What's in it |
| --- | --- |
| [docs/plan.md](docs/plan.md) | The development plan: architecture, components, milestones, risks |
| [docs/proxy-design.md](docs/proxy-design.md) | The broker — sentinel credentials, egress policy, threat model |
| [docs/plugin-api.md](docs/plugin-api.md) | Writing orchestration plugins, the SDK surface, `orc.yaml` |

Status: **design phase.** Nothing is implemented yet. `docs/plan.md` is the thing to read first.
