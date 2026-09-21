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

## 6. Package requests

An agent will discover mid-implementation that it needs something the environment does not have.
Ideally that is caught in planning; sometimes it is not, and "the agent cannot install anything" must
not mean "the agent gives up."

### The risk is not what it first appears

The instinct is that installing packages is dangerous because it executes untrusted code. But the
agent **already has arbitrary code execution** in its sandbox — that is the assumption the whole
isolation design starts from. An install grants no new execution capability.

Two things it does grant, and they are the ones to design against:

**It lands in the merged PR.** An agent-requested dependency ends up in the lockfile, in the diff,
and eventually in the user's production build. That is a supply-chain decision being made by an LLM
that may be acting on injected instructions. This is the serious risk, and it is not a sandbox
problem at all.

**It is a low-bandwidth egress channel.** The package name is attacker-influenced text that causes a
fetch to leave the network. `npm install evil-<encoded-data>` is a known exfiltration pattern, and
dependency confusion is its cousin. The damage is bounded here — the sandbox holds no credentials by
construction, so there is nothing high-value to encode — but the channel is real and gets rate
limited and audited rather than ignored.

### A package request is a code change

So it is handled the way a real team handles "I need to add a dependency": not as a runtime event,
but as a proposed change that goes through review.

```ts
// available to any agent; a request, not an installation
orc_request_package({
  ecosystem: "npm",
  name: "zod",
  version: "^3.23",
  justification: "Slice needs runtime schema validation at the API boundary",
})
```

The request is **data leaving the sandbox, never a command executed inside it.** Resolution happens
outside:

1. **Policy check.** `orc.config.ts` declares the ecosystems and registries allowed, and whether
   requests auto-approve. A request outside policy is refused with a reason the agent can read.
2. **Approval.** Auto-approve from an allowlist, or the principal decides, or a human does. The POC
   escalates to a human — consistent with every other unresolved decision (plan.md D4).
3. **Fetch, outside the sandbox.** The broker retrieves the artifact. The agent's container never
   gains a socket.
4. **Install offline, inside.** The runner installs from the local artifact with the index disabled
   (`npm install --offline`, `pip install --no-index --find-links`). Fetch and execute stay
   separated: the network step happens where there is network, the execution step happens where the
   blast radius is already accepted. Install scripts are disabled by default (`--ignore-scripts`)
   and enabling them is a policy decision.
5. **Write it back.** The manifest and lockfile change is part of the slice's diff, and
   `.devcontainer/` changes if a system package was needed. The principal reviews it with the rest of
   the code, which is the actual control — a human or a strong model reads "this slice added a
   dependency" before it merges.

Step 5 is the point. A dependency that exists only in a running container is both unreproducible and
unreviewed; one that lands in the lockfile is neither.

### POC constraint: TypeScript, pnpm, and exactly one allowed mutation

The general problem — any ecosystem, any package manager, system packages included — has too many
shapes to guard well on the first pass. So the POC assumes **every target project is TypeScript**,
and permits exactly one kind of environment mutation:

> **Adding a registry-hosted npm package as a `dependency` or `devDependency`, via an approved
> `orc_request_package`, installed with pnpm.**

Everything else is rejected. This has a large simplifying consequence worth stating plainly: a pnpm
package is a **workspace** change, not a **container** change. `node_modules` and the lockfile live
in the workspace; the image is untouched. Only system packages force a rebuild — and those are out
of scope here. **So the POC never rebuilds an image mid-run, and never restarts a sandbox to change
an environment.** The unplanned path is: fetch through the broker, install offline, continue in the
same session.

### What pnpm already guards

pnpm's own defaults cover more of this than expected, which is part of why it is the right choice:

- **Dependency lifecycle scripts do not run on install** (pnpm 10+). Packages needing a build must be
  listed in `pnpm.onlyBuiltDependencies`. This was a direct response to supply-chain attacks
  delivered through `postinstall`, and it means the default install path executes no third-party code.
- **`minimumReleaseAge` defaults to 1440 minutes** (pnpm 11), so a version published in the last day
  will not resolve. Most compromise campaigns depend on being installed before detection; a 24-hour
  delay defeats the common case.
- **`blockExoticSubdeps` defaults to true**, keeping non-registry transitive dependencies out.

orc's job is mostly to stop these from being *weakened*, not to reimplement them.

### The guard list

| Rejected | Why |
| --- | --- |
| Non-registry specifiers — `git:`, `github:`, `file:`, `link:`, tarball URLs | Git dependencies still execute `prepare` / `prepublish` / `prepack` during fetch, bypassing the lifecycle-script block entirely ([GHSA-379q-355j-w6rj](https://github.com/pnpm/pnpm/security/advisories/GHSA-379q-355j-w6rj)). This is the sharpest hole in the ecosystem's defenses. |
| Edits to `pnpm.onlyBuiltDependencies` or `dangerouslyAllowAllBuilds` | Re-enables arbitrary code execution at install time |
| Edits to `minimumReleaseAge` or `blockExoticSubdeps` | Weakens the supply-chain defaults above |
| Edits to `packageManager`, `engines`, or the Node version | Environment change, not a package change — needs a rebuild |
| Global installs (`pnpm add -g`) | Mutates container state outside the workspace; unreproducible |
| Any edit under `.devcontainer/**` | Environment change — rebuild path, out of POC scope |
| System packages (`apt-get`, …) | Same; escalates to a human instead |
| A `package-lock.json` or `yarn.lock` appearing | Signals a package-manager switch |

### Enforcement is two layers, and the first is free

**Prevention: there is no network.** An agent running `pnpm add foo` from bash simply cannot reach
the registry. The no-egress property is not just a security boundary here — it is what makes the
request tool the *only* path to a new package. Nothing needs to intercept or police the bash tool.

**Detection: the lockfile diff is reconciled at merge.** Every change to `package.json` and
`pnpm-lock.yaml` must correspond to an approved request, and the guarded fields above must be
unchanged. A mismatch fails the slice and escalates, with the diff attached. This catches hand-edited
manifests, packages pulled from a warm pnpm store, and any attempt to widen the install-time
execution surface.

Neither layer depends on the model behaving well, which is the point.

### Two tiers, by cost

**Planned (cheap, preferred).** The slice spec declares expected new dependencies during feasibility.
The environment is rebuilt once, before implementation starts, batched across slices. No restart, no
stall, and the principal reviews the dependency list as part of approving the spec.

**Unplanned (the escape hatch).** Mid-implementation, `orc_request_package` fires. In the POC this
always resolves in place — fetch through the broker, `pnpm install --offline`, continue in the same
session — because pnpm packages do not touch the image. Beyond the POC, system packages need a
rebuild and a sandbox restart, reusing the machinery already required for crash resume
([poc.md](poc.md) §8, criterion 4); the workspace and Pi session persist and the agent resumes with
the new environment.

The planning path exists because the unplanned one costs minutes. Making the senior declare
dependencies during feasibility is worth doing even though the escape hatch exists.

---

## 7. Build pipeline

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

## 8. In the POC

S0–S2 target a single repository, so this can be as simple as running `devcontainer build` once by
hand and pointing the runner at the resulting digest. The allowlist filter, the compose translation
and the cache keying are **S3 work**, arriving when multiple slices and real services do.

What matters now is that the *interface* is right from the start: the environment comes from the
repo, the build happens outside the sandbox, and the sandbox installs nothing. Those three
properties are what the rest depends on, and none of them require the full implementation to hold.

---

## 9. Open items

1. **Repos whose `postCreateCommand` cannot run at build.** The fallback is a documented failure
   telling the repo to move work into `onCreateCommand`. How common this is in practice is unknown.
2. **Feature allowlist scope.** Pinned digests are safest and highest friction. Where exactly to
   draw the line needs a real corpus of target repos.
3. **Image size versus cold start** is unmeasured, and interacts with the warm-pool work (plan.md
   M4).
4. **Non-Docker devcontainers.** The spec permits other orchestrators; orc assumes OCI images. Fine
   for now, worth not designing against.
5. ~~Does an environment change invalidate memoized steps?~~ **Decided: no.** A rebuild is an
   implementation detail and does not enter step cache keys. Completed artifacts are facts about what
   happened; new work simply uses the current environment. (In the POC the question does not arise at
   all — pnpm-only mutation means no mid-run rebuilds.)
6. **Request rate and batching.** Beyond the POC, if every slice triggers a rebuild the run stalls on
   image builds. Batching across concurrently-ready slices is the obvious mitigation, unmeasured.
7. **Ecosystems beyond TypeScript.** The guard list is pnpm-shaped. Python, Go and Rust each have a
   different install-time execution story (`setup.py`, build scripts, `build.rs`) and each needs its
   own pass. Deliberately deferred, not assumed to generalize.
