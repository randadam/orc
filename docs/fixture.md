# The `tudu` fixture — what the target repository is

`randadam/tudu` is the prototype's target repository ([phases.md](phases.md) §15 Q1), seeded by hand
on 2026-09-21 at `592f4de` and **pinned at `bf25ac6`** since the author's pnpm fix landed on
2026-09-22.

**This document describes the repository as it exists. It contains no plans.** That is deliberate
([plan.md](plan.md) §8 D9): `tudu` is treated as an ordinary existing app that orc is pointed at,
and the plans, architecture and feature work that grow it are produced *through the framework* —
interviewed, planned, sliced and reviewed — because producing them is the thing being demonstrated.
A roadmap written here by hand is a demonstration deleted.

So this file is a record, updated when the repository changes, and nothing more. It is not the app's
design; the app is deliberately ordinary.

---

## 1. What it is

A to-do app. React 19 + Vite + TypeScript, no backend, no persistence, no auth — local component
state and a test suite over it.

| | |
| --- | --- |
| Language / manager | TypeScript, pnpm, Node 22 |
| UI | React 19, Vite 7 |
| Tests | vitest 3 + Testing Library + jsdom — 46 tests across 7 files |
| Lint | eslint 9, flat config |
| Size | 751 lines of source and tests |

Ordinary on purpose. The implementation tier is Haiku ([poc-v2.md](poc-v2.md) §8), and a weak model
does its best work in the stack it has seen most; clever framework choices cost turns-to-green and
confound the measurement phase 6 exists to take.

---

## 2. Layout

```
tudu/
  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
  .github/workflows/ci.yml   lint, typecheck, test:coverage, build — on PRs, and on main after merge
  .githooks/                 pre-commit: lint + typecheck; pre-push: the full suite
  scripts/check.sh           all four checks in CI's order, every one run, non-zero if any failed
  index.html  vite.config.ts  eslint.config.js  tsconfig*.json
  src/
    App.tsx                  + App.test.tsx
    main.tsx  index.css
    components/              TodoForm, TodoItem, TodoList, TodoFilters — each with a .test.tsx
    hooks/useTodos.ts        add / toggle / remove / filter over component state  (+ .test.ts)
    lib/todos.ts             the Todo type and the pure operations on it          (+ .test.ts)
    test/                    setup.ts, factories.ts
```

`src/lib/todos.ts` holds `Todo` (`id`, `title`, `completed`), `Filter`, and pure functions —
`createTodo`, `addTodo`, `toggleTodo`, `removeTodo`, `clearCompleted`, `filterTodos`,
`remainingCount`. `src/hooks/useTodos.ts` wraps them in state. Between them they are where logic
lives and where tests are densest.

Scripts, as seeded:

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

---

## 3. The baseline

Verified at `bf25ac6` on 2026-09-22, by running it:

1. `pnpm install --frozen-lockfile` succeeds.
2. **`pnpm test` exits 0 with no services running: 46 tests across 7 files, ~4s.** This is the fast
   suite prevalidation discovers and `testCmd` binds to.
3. `pnpm lint`, `pnpm typecheck` and `pnpm build` all exit 0; `pnpm check` runs all four in CI's
   order and reports every failure rather than only the first.

CI asserts the same on every pull request and on `main` after a merge, and the `pre-push` hook runs
them before a branch leaves the machine, so the baseline cannot silently rot.

---

## 4. What it does not have

Stated as facts about the repository, not as a list of things to build — how any of these arrives,
if it arrives, is planned through orc rather than here.

- No HTTP surface, no server, no storage beyond React state.
- No `.devcontainer/`.
- No integration or e2e tier; the Testing Library tests drive the rendered app, which for an SPA is
  the honest meaning of end-to-end.
- No `test:unit`, no `coverage` script emitting a machine-readable reporter, no `lint --format json`,
  no metrics module, no deploy script.
- No `engines.node` field. (`packageManager` is `pnpm@10.33.0`.)

Some phase acceptance criteria assume things in this list exist — phase 2 builds sandbox images from
a repository's `.devcontainer/` (D5), and phase 7 runs integration tests against a compose sidecar
([phases.md](phases.md) §10 criterion 4). Those are dependencies to resolve when the phase arrives,
and §5 item 2 is where that is tracked.

---

## 5. Open items

1. ~~**The repository is npm-driven, against the pnpm rule.**~~ **Fixed by the author at
   `bf25ac6`, 2026-09-22.** `package-lock.json` is gone, CI installs with
   `pnpm install --frozen-lockfile` and runs `pnpm` scripts, and `packageManager` pins
   `pnpm@10.33.0`. The guard list in [environments.md](environments.md) §6 now rests on pnpm
   semantics that actually hold. Re-pinned in [phases/phase-1.md](phases/phase-1.md) §1.3.
2. **Phases 2 and 7 assume repository features that do not exist** (§4). Neither affects phase 1.
   Under D9 the answer is not written here; it is planned when the phase is reached.
3. **`pnpm-workspace.yaml` carries `allowBuilds: { esbuild: false }`**, where
   [environments.md](environments.md) §6's guard list names `minimumReleaseAge` and
   `onlyBuiltDependencies`. Same intent, newer pnpm spelling. The guard list needs to name whichever
   form the pinned pnpm uses — that is an orc-side fix, not a `tudu` one.
