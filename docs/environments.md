# Sandbox environments — dev containers as the configuration

The environment an agent works in is **the repository's business, not orc's.** Which Node version,
which system packages, which database the integration tests need — the people who maintain the repo
already know, and in many repos they have already written it down in `.devcontainer/`.

orc consumes that. It does not invent a parallel format, and it does not maintain per-repo images of
its own.

---

## 1. Why this is the right pattern

The earlier design had `images/pi-kit/` — an orc-owned image, hand-built per target repo. That works
for exactly one repo and puts orc permanently in the business of knowing toolchains. It was the
weakest part of the plan.

The [Dev Container specification](https://containers.dev) is a better fit on four counts:

- **It already exists in the repo,** often authored by whoever understands the build.
- **It is an open spec with a reference CLI** (`devcontainer build`, `devcontainer up`) and an
  established prebuild story, rather than something we would design.
- **It models services**, not just a toolchain — a compose file bringing up postgres and redis is
  precisely what integration tests need, and something the old design hand-waved.
- **Its prebuild boundary is exactly the boundary orc needs.** More on this below; it is the reason
  the fit is genuinely good rather than merely convenient.

The instinct that images should be **built outside the sandbox** is the load-bearing part. That is
what lets the sandbox keep its most important property.

---

## 2. The build boundary is the security boundary

Agents run with no network except the broker. A test suite needs its dependencies. Those two facts
only coexist if **every network-dependent step happens at build time, outside the sandbox.**

```
   OUTSIDE the sandbox                    INSIDE the sandbox
   (control plane / CI, has network)      (no network but the broker)

   repo .devcontainer/                    ┌──────────────────────────┐
        │                                 │  orc-runner              │
        ├─ devcontainer build             │    │                     │
        ├─ features installed             │    ▼                     │
        ├─ onCreateCommand      ──────┐   │  pi (+ @orc/pi)          │
        ├─ updateContentCommand       │   │  /workspace              │
        │  (npm ci, pip install, …)   │   │  deps already present    │
        ▼                             └──▶│  services on localhost   │
   image pushed to registry              └──────────────────────────┘
```

Nothing inside reaches a registry, because nothing inside needs to install anything.

### The lifecycle mapping, and its one sharp edge

The spec splits lifecycle scripts by when they run, and the split is almost exactly what we want:

| Script | Runs | orc treatment |
| --- | --- | --- |
| `initializeCommand` | **on the host**, before the container exists | **Rejected outright** — see §3 |
| `onCreateCommand` | once, at prebuild creation | Run at build. Heavy installs belong here. |
| `updateContentCommand` | at prebuild creation and on content updates | Run at build. |
| `postCreateCommand` | after container creation — **not during prebuild** | Run at build where possible; see below |
| `postStartCommand` | every container start | Run in sandbox; must not need network |
| `postAttachCommand` | on attach | Ignored — nothing attaches |

**The sharp edge:** the spec deliberately excludes `postCreateCommand` from prebuilds, and plenty of
real repos put `npm install` there anyway. Guidance for prebuilds is to move heavy installs into
`onCreateCommand` and leave secret-dependent steps in `postCreateCommand` — but a repo that has not
done that will not prebuild its dependencies, and will fail in a no-network sandbox.

Worse, the two reasons a command lives in `postCreateCommand` can collide: it may need the network
*and* a running service (a migration against the compose database). orc cannot resolve that
automatically.

So the rule is explicit rather than magical: orc runs `postCreateCommand` **at build time**, with
the compose services up, and a repo whose `postCreateCommand` fails there must adjust its
devcontainer. That failure is loud, at build, before any agent starts — which is the right place
for it.

---

## 3. `devcontainer.json` is untrusted input

This is the part that needs care. Dev containers are a **developer convenience spec, not a security
model** — they assume a trusted developer on their own machine, and several properties exist
specifically to weaken isolation.

orc's threat model assumes the repository is hostile (prompt injection is expected and
unpreventable). A `devcontainer.json` is repository content. Honoring it verbatim would hand any
repo a configuration channel into the sandbox that contains it.

`initializeCommand` is the clearest case: **it runs on the host**, before the container exists. In
orc that host is the control plane. Honoring it would give any repository arbitrary code execution
in the plane that holds the credentials. It is rejected unconditionally, not sandboxed, not prompted.

The config is therefore filtered through an allowlist, evaluated outside the sandbox at policy
resolution time — the same place and lifecycle as `orc.config.ts` (plan.md D2), and folded into the
same policy hash:

| Honored | Rejected or overridden |
| --- | --- |
| `image`, `build.*` (dockerfile, context, args) | `initializeCommand` — host execution |
| `features` (from a pinned allowlist) | `privileged`, `capAdd`, `securityOpt` |
| `containerEnv`, non-secret `remoteEnv` | `runArgs` — arbitrary docker flags |
| `onCreateCommand`, `updateContentCommand` | `mounts` — host bind mounts |
| `postCreateCommand` (at build, see §2) | `forwardPorts` — no host exposure |
| `postStartCommand` (no network) | `remoteUser`/`containerUser` set to root |
| `workspaceFolder` | docker-in-docker and docker-outside-of-docker features |
| `dockerComposeFile`, `service`, `runServices` (translated, §4) | |

A rejected property is a **build-time error naming the property**, not a silent drop. A repo that
needs `privileged` should be told why it cannot have it.

**Features are a supply-chain surface.** They are remote OCI artifacts whose install scripts run as
root. They run at build time, outside the sandbox, in an isolated builder with no access to
credentials — but they still end up in the image the agent runs. v1 pins them to an allowlist of
digests; the POC allows the well-known `ghcr.io/devcontainers/features/*` set at pinned versions.

---

## 4. Compose becomes sidecars, never a daemon

A devcontainer with `dockerComposeFile` needs several containers. The sandbox design gives agents
**no Docker socket** (plan.md §2.3), and that is not negotiable — a socket is a trivial escape.

So compose is not passed through to a daemon the agent controls. The **runner** brings the services
up *outside* the agent's container, in the same network namespace:

```
┌─ one network namespace ────────────────────────────┐
│  agent container        postgres        redis      │
│  (pi + runner)          (sidecar)       (sidecar)  │
│      │                      │               │      │
│      └── localhost:5432 ────┴── localhost:6379     │
└────────────────────────────────────────────────────┘
         only egress: the broker
```

The agent reaches services on `localhost` exactly as the devcontainer intends, holds no Docker
access, and the services inherit the same no-egress policy.

This maps cleanly onto the AWS target: **an ECS task is a compose project.** Multiple containers in
one task definition share a network namespace and lifecycle natively, so `runServices` becomes the
container list and nothing about the isolation model changes between local Docker and Fargate.

`service` names the container the agent runs in; the others are started and stopped with it.

---

## 5. The orc layer

The repo's devcontainer knows nothing about orc, and needs pi, the runner, and the internal CA. Two
options:

**Derived image (POC).** Two-stage build: `FROM <built devcontainer image>`, then copy in the pinned
pi, the runner, and the CA. No authoring, no publishing, works against any devcontainer.

**A dev container Feature (later).** `ghcr.io/orc/features/pi:1` — more idiomatic, lets a repo opt
in explicitly and control ordering, and composes with the repo's own features.

Start with the derived image; it has fewer moving parts and does not require repos to change
anything. Move to a Feature when repos want to declare orc support deliberately.

**Repos without a `.devcontainer/`** get a default image chosen by language detection, with the same
lifecycle rules. The devcontainer is the preferred input, not a requirement.

---

## 6. Build pipeline

```bash
devcontainer build --workspace-folder <repo> --image-name <registry>/<repo>:<sha> --push
```

Keyed by a hash of `.devcontainer/**` plus the lockfiles, so an image is rebuilt only when the
environment actually changes — not on every commit. Built in CI or by the control plane, never by a
sandbox. `--cache-from` against the previous digest keeps incremental builds cheap.

Agents pull by digest, never by tag, so a run is reproducible and a retag cannot change what an
agent executes.

**Image size is the cost.** Full toolchain images are large, and every agent sandbox pulls one. With
fan-out that is real cold-start time. Registry-local pulls and layer caching cover the POC; ECR
pull-through cache and lazy loading are the v1 answers if it bites.

---

## 7. In the POC

S0–S2 target a single repository, so this can be as simple as running `devcontainer build` once by
hand and pointing the runner at the resulting digest. The allowlist filter, the compose translation
and the cache keying are **S3 work**, arriving when multiple slices and real services do.

What matters now is that the *interface* is right from the start: the environment comes from the
repo, the build happens outside the sandbox, and the sandbox installs nothing. Those three
properties are what the rest depends on, and none of them require the full implementation to hold.

---

## 8. Open items

1. **Repos whose `postCreateCommand` cannot run at build.** The fallback is a documented failure
   telling the repo to move work into `onCreateCommand`. How common this is in practice is unknown.
2. **Feature allowlist scope.** Pinned digests are safest and highest friction. Where exactly to
   draw the line needs a real corpus of target repos.
3. **Image size versus cold start** is unmeasured, and interacts with the warm-pool work (plan.md
   M4).
4. **Non-Docker devcontainers.** The spec permits other orchestrators; orc assumes OCI images. Fine
   for now, worth not designing against.
