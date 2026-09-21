# The `tudu` fixture — seeding the target repository

`randadam/tudu` is the prototype's target repository ([phases.md](phases.md) §15 Q1). It is empty,
and it will be **seeded by hand** as a purpose-built fixture: a to-do app. Simple enough that the
seed is a day's work; open-ended enough that the benchmark set can keep adding features for as long
as the prototype needs.

This document is what the seed must contain so that **every phase has something real to exercise**,
and what it must *not* be. It is not the app's design. The app is deliberately ordinary.

---

## 1. Ordinary on purpose

The seed's job is to be a codebase agents can work in, not a showcase. Every choice below favours
the most conventional option, for one reason: **the implementation tier is Haiku**
([poc-v2.md](poc-v2.md) §8), and a weak model does its best work in the stack it has seen most.
Clever framework choices cost turns-to-green and confound the very measurement phase 6 exists to
take.

| Choice | Pick | Why this and not something better |
| --- | --- | --- |
| Language / manager | TypeScript, **pnpm**, Node 22 pinned via `packageManager` and `engines` | The guard list and image plan assume exactly this ([environments.md](environments.md) §6) |
| HTTP | **Express** | The most-trodden path for the model writing the code |
| Tests | **vitest**, plus `supertest` for HTTP | Fast, conventional, one runner for unit / integration / e2e |
| Storage | A `TodoStore` interface with **two implementations**: in-memory, and Postgres | See §3 — this seam is what lets phases 1–6 stay fast and phase 7 have a real sidecar |
| Lint / format | eslint + prettier, both with a JSON reporter | Custom-metric fodder for [observability.md](observability.md) §8 |

Target size at commit zero: **under ~600 lines of source and tests.** If it grows past that while
seeding, something is being built that a benchmark feature should build instead.

---

## 2. Layout

```
tudu/
  package.json               scripts below; packageManager: pnpm@<pinned>; engines.node: 22
  pnpm-lock.yaml
  pnpm-workspace.yaml        minimumReleaseAge and onlyBuiltDependencies stated explicitly (§5)
  .devcontainer/
    devcontainer.json        §5
    docker-compose.yml       app + postgres
  src/
    app.ts                   express app factory; takes a TodoStore
    server.ts                listens; reads DATABASE_URL to pick the store
    todos/
      model.ts               Todo type, validation
      service.ts             create / list / complete / delete
      routes.ts              HTTP surface
    storage/
      store.ts               the TodoStore interface
      memory.ts
      postgres.ts            + migrations/0001_init.sql
    metrics.ts               named counters (todos_created, todos_completed) — greppable by ops
  test/
    unit/                    service + model against MemoryStore; no services needed
    integration/             routes against PostgresStore; skip cleanly without DATABASE_URL
    e2e/                     full HTTP flows with supertest against a booted app
  benchmark/                 the feature requests, one file each (§4)
  scripts/
    deploy.sh                a no-op that prints the version and exits 0 (§3, phase 8)
```

`package.json` scripts — these names are what `testCmd`, the coverage gate and the custom metrics
bind to, so they are part of the contract:

```
test              vitest run                      (unit + integration + e2e; integration skips w/o DB)
test:unit         vitest run test/unit
test:integration  vitest run test/integration
test:e2e          vitest run test/e2e
coverage          vitest run --coverage --coverage.reporter=json
lint              eslint . --format json
build             tsc -p .
metrics           node -e "..." prints the metric names in src/metrics.ts, one per line
deploy            scripts/deploy.sh
```

---

## 3. What each phase needs from the seed

| Phase | Needs | How the seed provides it |
| --- | --- | --- |
| **1** — SDK on subprocesses | A real repo where two agents can do real, small work and a suite that says whether they broke it | The app plus `test:unit`, green in under 10s with no services |
| **2** — sandboxes | An image built from the repo's own devcontainer, with nothing needing the network at run time | `.devcontainer/` with installs in `onCreateCommand` and **no `postCreateCommand`** — the deliberate test of [environments.md](environments.md) §2's sharp edge |
| **3** — durability | Sessions worth recording and replaying | Any phase 1 workflow; nothing extra |
| **4** — walking skeleton | A `testCmd` for prevalidation to discover, a baseline to be green | `test` exits 0 at commit zero (§6) |
| **5** — real planning | A benchmark set of feature requests a PM can be interviewed about, with real dependency edges | `benchmark/` (§4), pinned by the seed commit |
| **6** — one real slice | Slice-local tests a senior can add; a coverage report; metric names ops can grep | `test:unit` / `test:integration` split; `coverage`; `metrics` |
| **7** — scheduler | A compose service so integration tests hit a **sidecar**; features that genuinely conflict | Postgres in `docker-compose.yml`; benchmark pairs that touch the same files (§4) |
| **8** — fan-out and sign-offs | Subslices small enough for Haiku; E2E tests for QA; a deploy target for the runbook | `test/e2e`; `scripts/deploy.sh` as the no-op deploy the runbook and rollback plan can name |

The storage seam is the one non-obvious decision. **Phases 1–6 never need Postgres running** — unit
tests use the memory store, and integration tests skip cleanly (not fail) when `DATABASE_URL` is
unset. **Phase 7's sidecar acceptance** ([phases.md](phases.md) §10 criterion 4) then has something
real to hit: the same integration tests, now against the compose service, no longer skipping. One
codebase, two speeds, no flag-flipping between phases.

---

## 4. Benchmark set v0

Five feature requests, phrased as a **user would ask for them** — not as specs — because phase 5's
PM interview turns them into PRDs and that transformation is part of what is measured. Sizes are
guesses to be corrected by phase 6's turns-to-green.

| ID | Request | Size | Depends on | Files it will touch |
| --- | --- | --- | --- | --- |
| **F1** | "I want to put tags on my to-dos and filter by them" | S | — | `model`, `service`, `routes`, migration |
| **F2** | "To-dos need due dates, and I want to see what's overdue" | M | — | `model`, `service`, `routes`, migration |
| **F3** | "Show me what's due in the next N days" | S | F2 | `service`, `routes` |
| **F4** | "Some to-dos repeat — weekly, monthly. When I complete one, the next should appear" | L | F2 | `model`, `service`, `routes`, migration |
| **F5** | "Let me complete or delete a bunch of to-dos at once" | S | — | `service`, `routes` |

Three properties are engineered in, and should be preserved when the set grows:

- **Real dependency edges.** F3 and F4 cannot start until F2 has merged — a capability dependency,
  not a file one ([poc-v2.md](poc-v2.md) §2).
- **Designed conflicts.** F1, F2 and F5 are independent and all touch `service.ts` and `routes.ts`.
  Run concurrently, at least one genuine merge conflict is near-certain — which is exactly what
  phase 7's acceptance criterion 2 requires and would otherwise have to wait for by luck.
- **A spread of sizes.** F1/F3/F5 are one-session slices; F4 is the one likely to fan out into
  subslices at phase 8, and the one most likely to show whether Haiku can carry implementation.

The canonical copy lives in `tudu/benchmark/F*.md`, committed with the seed, so a request is pinned
to the commit it was written against. orc's records reference them by id and commit.

---

## 5. The devcontainer, exactly

This file is the phase 2 image source and the first real exercise of D5, so its shape matters:

```jsonc
{
  "name": "tudu",
  "dockerComposeFile": "docker-compose.yml",
  "service": "app",
  "runServices": ["app", "db"],
  "workspaceFolder": "/workspace",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" }   // pinned digest at seed time
  },
  "onCreateCommand": "corepack enable && pnpm install --frozen-lockfile",
  "remoteEnv": { "DATABASE_URL": "postgres://tudu:tudu@db:5432/tudu" }
  // deliberately absent: postCreateCommand, initializeCommand, privileged, capAdd, mounts,
  // forwardPorts, runArgs — every field the allowlist rejects (environments.md §3)
}
```

Installation happens in `onCreateCommand`, which prebuilds; nothing runs at container start that
needs the registry. That is the whole reason the seed can be built once and run with no network.

`pnpm-workspace.yaml` states the two supply-chain settings **explicitly at their defaults** —
`minimumReleaseAge: 1440` and `onlyBuiltDependencies: []` — so the guard list in
[environments.md](environments.md) §6 has real fields to protect, and a diff that weakens them is
visible as a diff rather than as the appearance of a new key.

---

## 6. The baseline

"Green at commit zero" means, precisely:

1. `pnpm test` exits 0 with **no services running**: unit and e2e pass, integration reports
   *skipped* (not failed, not errored). Prevalidation treats skipped as green and records the count.
2. `pnpm test` exits 0 **with the compose db up**, integration included, in under 60s.
3. `pnpm lint`, `pnpm build`, `pnpm coverage` all exit 0.
4. `pnpm metrics` prints at least two names, and each appears in `src/metrics.ts`.

Item 1 is what phases 1–6 run against. Item 2 is what phase 7 runs against. Both are asserted by
the seed's own CI (a single GitHub Actions job) so the baseline cannot silently rot between phases.

---

## 7. What the seed must not be

- **Not a finished app.** Under ~600 lines. Features arrive through the benchmark set, or the
  benchmark set is measuring nothing.
- **Not clever.** No custom framework, no decorators, no code generation, no monorepo. Ordinary
  Express, ordinary vitest.
- **Not networked at test time.** Nothing in `test/` fetches anything. The sandbox has no network.
- **Not carrying secrets.** The Postgres credentials are the fixture's and appear in the compose
  file on purpose; nothing else credential-shaped exists in the repo.
- **Not pre-solving benchmark features.** No `tags` column "for later." The seed contains a to-do
  with a title and a done flag, and that is all.

---

## 8. Sizing and sequence

A day to write by hand, including the benchmark files and the CI job. It is the first piece of work
after phase 0 and before phase 1's first real run — phase 1's plan assumes it exists at the commit
it pins.

---

## 9. Open items

1. **Express versus something smaller.** Express is picked for model familiarity; if phase 6 shows
   Haiku handling it fine, the choice never matters. If a lighter framework would measurably help,
   that is a benchmark-set question, not a seed question.
2. **E2E means HTTP-level here.** `test/e2e` drives the booted app over HTTP with supertest. There is
   no browser. For a to-do API that is the honest meaning of end-to-end; if the app grows a UI, QA's
   E2E plan grows with it.
3. **Sizes in §4 are guesses.** Phase 6 corrects them; phase 8's fan-out decisions depend on F4
   actually being large.
4. **Migration tooling.** Plain SQL files applied by the Postgres store on connect is the
   conventional-and-tiny choice; whether the benchmark features need something more is unknown
   until F1 adds a column.
