# The `tudu` fixture — the target repository

`randadam/tudu` is the prototype's target repository ([phases.md](phases.md) §15 Q1). **It was
seeded by hand on 2026-09-21** at `592f4de`, and it is deliberately barer than this document
originally specified.

**The seed is a React SPA with no backend.** That is the decision ([plan.md](plan.md) §8 D9), not an
accident or a first cut: a fixture that already has the API, the storage seam and the sidecar is a
fixture where orc never has to build them. The interesting work — an HTTP surface, a store
interface with two implementations, a devcontainer, the compose service phase 7 needs — is now
**work for orc to do**, tracked in §4 alongside the feature requests. A benchmark that measures
whether agents can add a column to an app that already works is a weaker benchmark than one that
measures whether they can grow the app itself.

The cost is that several later phases now depend on orc having built something first, rather than on
the seed shipping it. §3 is the honest accounting of which, and §9 carries the one item that blocks
a phase rather than merely sizing it.

This document is the record of what the seed *is*, what it must not become, and what each phase
needs from it. It is not the app's design. The app is deliberately ordinary.

---

## 1. Ordinary on purpose

The seed's job is to be a codebase agents can work in, not a showcase. Every choice favours the most
conventional option, for one reason: **the implementation tier is Haiku**
([poc-v2.md](poc-v2.md) §8), and a weak model does its best work in the stack it has seen most.
Clever framework choices cost turns-to-green and confound the very measurement phase 6 exists to
take.

| Choice | As seeded | Why it holds |
| --- | --- | --- |
| Language / manager | TypeScript, **pnpm**, Node 22 | The guard list and image plan assume exactly this ([environments.md](environments.md) §6) |
| UI | **React 19 + Vite** | The most-trodden path for the model writing the code |
| Tests | **vitest** + Testing Library, `jsdom` | One runner; 46 tests, 3.6s, no services |
| Storage | **React state. None.** | The store seam is a thing orc builds (§4), not a thing the seed ships |
| Lint | **eslint** (flat config) | Custom-metric fodder for [observability.md](observability.md) §8, once it emits JSON |

751 lines of source and tests at `592f4de`. **If it grows much past that by hand, something is being
built that a benchmark feature should build instead.**

---

## 2. Layout, as seeded

```
tudu/
  package.json               scripts below
  pnpm-lock.yaml             also package-lock.json — see §9 item 1
  pnpm-workspace.yaml        allowBuilds: { esbuild: false }
  .github/workflows/ci.yml   lint, typecheck, test:coverage, build
  index.html  vite.config.ts  eslint.config.js  tsconfig*.json
  src/
    App.tsx                  + App.test.tsx
    main.tsx  index.css
    components/              TodoForm, TodoItem, TodoList, TodoFilters — each with a .test.tsx
    hooks/useTodos.ts        the state seam: add / toggle / remove / filter  (+ .test.ts)
    lib/todos.ts             the Todo type and the pure operations on it     (+ .test.ts)
    test/                    setup.ts, factories.ts
```

`package.json` scripts, as seeded:

```
dev            vite
build          tsc -b && vite build
preview        vite preview
lint           eslint .
typecheck      tsc -b --noEmit
test           vitest run
test:watch     vitest
test:coverage  vitest run --coverage
```

**`src/lib/todos.ts` and `src/hooks/useTodos.ts` are where the benchmark features land.** They are
the seed's only real seam, and they play the part `service.ts` plays in a backend fixture: pure
logic with its own tests, under a UI that exercises it.

**What the contract in phases 1–8 expects and the seed does not have:** `test:unit`, a `coverage`
script emitting the JSON reporter, `lint --format json`, `metrics`, `deploy`, `benchmark/`,
`.devcontainer/`. Each is accounted for in §3 and §4 rather than assumed away.

---

## 3. What each phase needs, and where it now comes from

| Phase | Needs | Status against `592f4de` |
| --- | --- | --- |
| **1** — SDK on subprocesses | A real repo where two agents can do small work, and a suite that says whether they broke it | **Have it.** `pnpm test` is 46 tests in 3.6s with no services. There is no `test:unit`; phase 1 binds to `pnpm test`, which is the fast suite here |
| **2** — sandboxes | An image built from the repo's own devcontainer | **Missing, and blocking.** No `.devcontainer/`. See §9 item 2 — this is the one gap that stops a phase rather than sizing it |
| **3** — durability | Sessions worth recording and replaying | **Have it.** Any phase 1 workflow; nothing extra |
| **4** — walking skeleton | A `testCmd` for prevalidation to discover, and a green baseline | **Have it.** `test` exits 0 at `592f4de` (§6) |
| **5** — real planning | Feature requests with real dependency edges | **Have them**, in §4 — but they live here, not in `tudu/benchmark/`, until orc writes them there |
| **6** — one real slice | Slice-local tests; a coverage report; metric names to grep | **Partly.** Tests and `test:coverage` exist; the JSON reporters and `src/metrics.ts` are B2/B3 in §4 |
| **7** — scheduler | A compose service so integration tests hit a **sidecar**; features that genuinely conflict | **Conflicts yes, sidecar no.** Phase 7 criterion 4 depends on B1 having merged first — see §9 item 3 |
| **8** — fan-out and sign-offs | Subslices small enough for Haiku; E2E for QA; a deploy target | **Partly.** The component tests are the E2E analogue for an SPA; `scripts/deploy.sh` is B4 in §4 |

**The dependency this creates is the point and the risk in one.** The old fixture handed every phase
its props. This one makes phases 6, 7 and 8 depend on orc having successfully built something
first — which is a far better demonstration when it works, and a stalled prototype when it does not.
§4 orders the build-out so the blocking pieces come first, and §9 item 3 states plainly what happens
if orc cannot deliver B1.

---

## 4. The work: build-outs and features

Two kinds of request, in one list, because to orc they are the same kind of thing — a feature
request that a PM is interviewed about and slices are cut from. They are separated here only because
the **B** items are load-bearing for later phases while the **F** items are the measurement.

### 4.1 Build-outs — what later phases need orc to build

| ID | Request | Size | Depends on | Unblocks |
| --- | --- | --- | --- | --- |
| **B0** | "Set this repo up so it can run in a container the same way every time" — a `.devcontainer/` with installs at prebuild and nothing at start | S | — | **Phase 2.** See §5 for the shape it must land on, and §9 item 2 for why it may have to be hand-written instead |
| **B1** | "My to-dos vanish when I close the tab. I want them saved on a server so I can see them from my laptop too" | L | B0 | **Phase 7's sidecar.** An HTTP surface, a store interface, memory and Postgres implementations, a compose service |
| **B2** | "I want the CI to tell me how much of the code the tests cover, and fail if it drops" | S | — | Phase 6's coverage gate — needs `coverage` emitting the JSON reporter |
| **B3** | "I want to see counts of what the app is doing — how many to-dos get made, how many get finished" | S | B1 | Phase 6's custom metrics ([observability.md](observability.md) §8) — needs `src/metrics.ts` and a `metrics` script |
| **B4** | "Give me a one-command deploy, even if it does nothing yet" | S | — | Phase 8's runbook and rollback plan — `scripts/deploy.sh`, exits 0, prints the version |

**B0 and B1 are the two that matter.** Everything else is a convenience that a phase can work
around; those two are the difference between phase 2 running and not, and between phase 7's
criterion 4 being testable and being deleted.

### 4.2 Benchmark set v0 — the measurement

Five feature requests, phrased as a **user would ask for them** — not as specs — because phase 5's
PM interview turns them into PRDs and that transformation is part of what is measured. Sizes are
guesses to be corrected by phase 6's turns-to-green.

| ID | Request | Size | Depends on | Files it will touch |
| --- | --- | --- | --- | --- |
| **F1** | "I want to put tags on my to-dos and filter by them" | S | — | `lib/todos`, `hooks/useTodos`, `TodoFilters`, `TodoItem` |
| **F2** | "To-dos need due dates, and I want to see what's overdue" | M | — | `lib/todos`, `hooks/useTodos`, `TodoForm`, `TodoItem` |
| **F3** | "Show me what's due in the next N days" | S | F2 | `lib/todos`, `TodoFilters` |
| **F4** | "Some to-dos repeat — weekly, monthly. When I complete one, the next should appear" | L | F2 | `lib/todos`, `hooks/useTodos`, `TodoForm`, `TodoItem` |
| **F5** | "Let me complete or delete a bunch of to-dos at once" | S | — | `hooks/useTodos`, `TodoList`, `TodoItem` |

Three properties are engineered in, and **all three survived the move from a backend fixture to this
one** — which is some evidence the set was measuring the right things rather than the old layout:

- **Real dependency edges.** F3 and F4 cannot start until F2 has merged — a capability dependency,
  not a file one ([poc-v2.md](poc-v2.md) §2). B1 → B3 is a second, and a coarser one.
- **Designed conflicts.** F1, F2 and F5 are independent and all touch `lib/todos.ts` and
  `hooks/useTodos.ts`. Run concurrently, at least one genuine merge conflict is near-certain —
  which is exactly what phase 7's acceptance criterion 2 requires and would otherwise have to wait
  for by luck.
- **A spread of sizes.** F1/F3/F5 are one-session slices; F4 is the one likely to fan out into
  subslices at phase 8, and the one most likely to show whether Haiku can carry implementation.

**These live here, not in `tudu/`.** The old plan put the canonical copy in `tudu/benchmark/F*.md`
so a request was pinned to the commit it was written against. The seed does not carry them, so this
document is canonical until orc writes them into the repo; orc's records reference them by id plus
the `tudu` commit they were run against.

---

## 5. The devcontainer, exactly

**This does not exist in the seed.** It is B0, and it is the first real exercise of D5, so its shape
matters whether orc writes it or a person does:

```jsonc
{
  "name": "tudu",
  "dockerComposeFile": "docker-compose.yml",
  "service": "app",
  "runServices": ["app", "db"],
  "workspaceFolder": "/workspace",
  "features": {
    "ghcr.io/devcontainers/features/node:1": { "version": "22" }   // pinned digest
  },
  "onCreateCommand": "corepack enable && pnpm install --frozen-lockfile",
  "remoteEnv": { "DATABASE_URL": "postgres://tudu:tudu@db:5432/tudu" }
  // deliberately absent: postCreateCommand, initializeCommand, privileged, capAdd, mounts,
  // forwardPorts, runArgs — every field the allowlist rejects (environments.md §3)
}
```

Installation happens in `onCreateCommand`, which prebuilds; nothing runs at container start that
needs the registry. **That is the whole reason the image can be built once and run with no network**,
and it is the deliberate test of [environments.md](environments.md) §2's sharp edge.

The `db` service and `DATABASE_URL` only become real with B1. Until then the compose file is the app
service alone, and B1 adds the second — which makes B0 a smaller, safer first agent task than it
looks.

`pnpm-workspace.yaml` should state the two supply-chain settings **explicitly at their defaults** —
`minimumReleaseAge: 1440` and `onlyBuiltDependencies: []` — so the guard list in
[environments.md](environments.md) §6 has real fields to protect, and a diff that weakens them is
visible as a diff rather than as the appearance of a new key. The seed instead carries
`allowBuilds: { esbuild: false }`, which is the same intent in pnpm 11's newer spelling; the guard
list needs to name whichever form the pinned pnpm uses.

---

## 6. The baseline

"Green at `592f4de`" means, precisely, and **verified on 2026-09-21**:

1. `pnpm install --frozen-lockfile` succeeds, and `pnpm test` exits 0 with **no services running**:
   46 tests across 7 files in 3.6s. Prevalidation treats this as the fast suite and records the
   count.
2. `pnpm lint`, `pnpm typecheck` and `pnpm build` all exit 0.

What the old baseline asked for and this one cannot yet: an integration tier that reports *skipped*
without `DATABASE_URL` and passes with the compose db up (B1), `coverage` emitting JSON (B2), and
`metrics` printing names from `src/metrics.ts` (B3). **Each is a build-out, so each becomes part of
the baseline the moment it merges** — and the seed's CI is what stops the baseline rotting between
phases, once it runs the same commands orc does (§9 item 1).

---

## 7. What the seed must not become

- **Not a finished app.** 751 lines at `592f4de`. Features arrive through §4, or §4 is measuring
  nothing.
- **Not built by hand from here on.** This is the sharp edge of D9: every temptation to "just add
  the API quickly" is a benchmark feature deleted. The exception is a piece that blocks a phase
  outright and that orc cannot yet build — today that is B0, and §9 item 2 is where that call gets
  made rather than made quietly in a commit.
- **Not clever.** No custom framework, no decorators, no code generation, no monorepo. Ordinary
  React, ordinary vitest, and ordinary Express if and when B1 lands.
- **Not networked at test time.** Nothing in the tests fetches anything. The sandbox has no network.
- **Not carrying secrets.** If B1 brings Postgres credentials, they are the fixture's and appear in
  the compose file on purpose; nothing else credential-shaped exists in the repo.
- **Not pre-solving benchmark features.** No `tags` field "for later". The seed's `Todo` has a
  title and a done flag, and that is all.

---

## 8. Sizing and sequence

**Seeding is done** — a day's work, landed 2026-09-21. What follows is no longer seeding: B0 before
phase 2, B1 before phase 7, and the F set as the phases that measure them arrive. Phase 1 needs
nothing more than what is already there.

---

## 9. Open items

1. **The seed is npm-driven, against the pnpm rule.** `package-lock.json` is committed beside
   `pnpm-lock.yaml`, and `.github/workflows/ci.yml` runs `npm ci` and `npm run`. This matters beyond
   tidiness: [environments.md](environments.md) §6's guard list assumes pnpm semantics — lifecycle
   scripts blocked on install, `minimumReleaseAge` holding back same-day versions — and an agent
   that reaches for npm inside the sandbox gets none of them, silently. `packageManager` and
   `engines.node` are also absent. **Being fixed by the author; re-pin §8's commit when it lands.**
2. **No `.devcontainer/`, and phase 2 cannot start without one.** It is B0, and there is a
   chicken-and-egg problem worth naming: phase 2 is the phase that runs agents in sandboxes, so
   using orc to write the devcontainer means using the un-sandboxed phase 1 runner to do it. That is
   fine and is probably the right first real task for phase 1's `orc run` — but if it does not work,
   B0 gets hand-written, and that is a deliberate exception to §7 rather than a quiet one.
3. **Phase 7's sidecar acceptance now depends on B1.** [phases.md](phases.md) §10 criterion 4 wants
   integration tests hitting a compose service; there is no service and no integration tier until
   orc builds one. If B1 has not merged by phase 7, the options are to hand-write B1, to run phase 7
   without criterion 4, or to reorder so B1 is phase 6's real slice. **Phase 6's slice being B1 is
   the interesting answer** — it is exactly the size phase 6 wants, and it makes the Haiku-versus-
   Sonnet comparison run on work that later phases actually need. Not decided here.
4. **E2E means component-level here.** The seed's Testing Library tests drive the rendered app, and
   for an SPA that is the honest meaning of end-to-end. If B1 lands, QA's E2E plan grows an HTTP
   tier with supertest; a browser tier is not planned.
5. **Sizes in §4 are guesses.** Phase 6 corrects them; phase 8's fan-out decisions depend on F4
   actually being large, and on B1 being larger still.
6. **The benchmark set lives in this document, not in `tudu/`.** That breaks the property that a
   request is pinned to the commit it was written against. Writing them into `tudu/benchmark/` is
   itself a small orc task, and the first one where the output is prose rather than code.
