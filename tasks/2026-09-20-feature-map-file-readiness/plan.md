# Feature-map file readiness — Implementation plan

## Preflight

Run from the repository root:

```sh
pnpm install
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

The required repository guidance explicitly requires this order. The full
preflight must pass or its existing failures must be recorded before code
changes begin.

## Wave table

| Wave | Tasks | Max concurrency |
| --- | --- | ---: |
| 0 | T0 contracts | 1 |
| 1 | T1 strict validation; T2 readiness UI | 2 |
| 2 | T3 turn-finalization integration; T4 save IPC hardening | 2 |
| 3 | T5 full verification and cleanup | 1 |

Critical path: T0 → T1 → T3 → T5. T2 is independent after the shared type
contract. T4 is independent of turn-finalization integration because it only
hardens the existing save boundary.

## Tasks

- [x] **T0 — Add feature-map draft validation contract**
  - Wave: 0
  - Depends on: none
  - Owns: `shared/types.ts`
  - Reads: `tasks/2026-09-20-feature-map-file-readiness/design.md`
  - Do: Add `FeatureMapDraftValidation` and the optional
    `draftValidation` field to `FeatureMapStepMeta` exactly as specified in the
    design. Preserve compatibility with existing metadata by keeping the field
    optional.
  - Tests: existing type guard behavior remains valid for old metadata.
  - Verify: `pnpm ts-check`
  - Done when: shared types compile and old feature-map metadata remains
    accepted.

- [x] **T1 — Implement strict feature-map draft validation**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/services/project-feature-map-generation-service.ts`, `electron/services/project-feature-map-generation-service.test.ts`
  - Reads: `shared/types.ts`, design sections “Interfaces”, “Error handling”,
    and “Test strategy”
  - Do: Add the validator returning valid/invalid status, safe reason,
    timestamp, and feature count. Make malformed nodes invalidate the complete
    draft instead of silently dropping them. Reuse the existing YAML parsing
    and normalization rules where possible. Make canonical save call the same
    strict validation before writing and preserve existing IDs/output behavior.
  - Tests: valid YAML; missing file; invalid YAML; empty features; malformed
    top-level node; malformed nested node; deep valid tree; save rejects a
    draft that became invalid.
  - Verify: `pnpm vitest run electron/services/project-feature-map-generation-service.test.ts`
  - Done when: all validator and save-boundary tests pass and no full file
    contents are included in validation errors.

- [x] **T2 — Render artifact readiness in the feature-map action**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/task/ui-feature-map-save-action/index.tsx`, `src/features/task/ui-feature-map-save-action/index.test.tsx`
  - Reads: `shared/types.ts`, existing component patterns under
    `src/features/task`, design section “State”
  - Do: Gate Review diff and Save on `draftValidation.status === 'valid'`, not
    step status. Keep the task usable for invalid drafts, show the concrete
    validation reason, and allow a valid draft while the step is running.
    Preserve saved-state rendering and save-time error handling.
  - Tests: valid metadata enables both actions while running; invalid metadata
    disables both and shows the reason; unknown metadata is not ready; saved
    metadata shows saved state.
  - Verify: `pnpm vitest run src/features/task/ui-feature-map-save-action/index.test.tsx`
  - Done when: component tests cover all readiness states and the UI has no
    status-only gating.

- [x] **T3 — Validate after feature-map turn finalization**
  - Wave: 2
  - Depends on: T1
  - Owns: `electron/services/agent-service.ts`, `electron/services/agent-service.test.ts`
  - Reads: `electron/services/project-feature-map-generation-service.ts`,
    `electron/services/step-service.ts`, design sections “Architecture” and
    “Data flow”
  - Do: At the end of each feature-map agent turn, validate the exact temp
    path, update `step.meta.draftValidation`, persist the step, and emit the
    step upsert. Invalid drafts must not error the step. Log step ID, path,
    status, and concise reason without logging contents. Preserve existing
    queued-prompt and terminal lifecycle behavior.
  - Tests: valid finalization emits valid metadata; invalid finalization emits
    invalid metadata without changing execution status; validation errors are
    logged safely.
  - Verify: `pnpm vitest run electron/services/agent-service.test.ts`
  - Done when: renderer receives readiness after each turn through the existing
    step-upsert event and terminal behavior remains intact.

- [x] **T4 — Harden feature-map Save IPC against stale drafts**
  - Wave: 2
  - Depends on: T1
  - Owns: `electron/ipc/handlers.ts`
  - Reads: `electron/services/project-feature-map-generation-service.ts`,
    `shared/types.ts`, design section “Security”
  - Do: Keep the existing project metadata/path checks, invoke strict
    validation immediately before saving, persist the latest invalid result if
    validation fails, and ensure the canonical file is not changed. Preserve
    successful save/cleanup/task-completion behavior.
  - Tests: exercise the existing feature-map save service boundary and verify
    invalid stale drafts are rejected before canonical writes. This repository
    has no standalone `handlers.test.ts`; handler behavior is covered by the
    service test and the full suite barrier.
  - Verify: `pnpm vitest run electron/services/project-feature-map-generation-service.test.ts`
  - Done when: stale or invalid renderer state cannot save an invalid draft.

- [x] **T5 — Full verification and cleanup**
  - Wave: 3
  - Depends on: T2, T3, T4
  - Owns: `tasks/2026-09-20-feature-map-file-readiness/plan.md`
  - Reads: all changed files
  - Do: Re-run the required full checks, inspect the final diff, tick completed
    task checkboxes, and record any pre-existing or out-of-scope findings under
    `## Discovered`. Do not modify changelogs.
  - Tests: full repository suite and targeted feature-map tests.
  - Verify: `pnpm test && pnpm ts-check && pnpm lint`
  - Done when: required checks pass, plan status reflects completed work, and
    the final diff is limited to the design and implementation scope.

## File ownership check

| File | Owner | Wave |
| --- | --- | ---: |
| `shared/types.ts` | T0 | 0 |
| `electron/services/project-feature-map-generation-service.ts` | T1 | 1 |
| `electron/services/project-feature-map-generation-service.test.ts` | T1 | 1 |
| `src/features/task/ui-feature-map-save-action/index.tsx` | T2 | 1 |
| `src/features/task/ui-feature-map-save-action/index.test.tsx` | T2 | 1 |
| `electron/services/agent-service.ts` | T3 | 2 |
| `electron/services/agent-service.test.ts` | T3 | 2 |
| `electron/ipc/handlers.ts` | T4 | 2 |
| `tasks/2026-09-20-feature-map-file-readiness/plan.md` | T5 | 3 |

## Do not parallelize

- `pnpm install` is a dependency/lockfile operation and runs only in
  preflight.
- Full lint fixes run only during preflight/final verification, never while
  implementation tasks overlap.
- Full test/typecheck barriers run after each wave, not inside concurrent
  tasks.
- Git staging and commits are orchestrator-owned.

## Risk list

- **Turn-finalization seam:** there are multiple terminal and queued-prompt
  paths in `agent-service.ts`; use the shared terminal boundary and add logs if
  the expected step-upsert is not observed after the first test attempt.
- **Strict normalization compatibility:** existing valid maps may rely on
  fallback IDs or `files` aliases; preserve those accepted behaviors while
  rejecting only malformed nodes.
- **Renderer cache timing:** readiness must arrive via the existing step-upsert
  event; if the UI remains stale after a passing service test, inspect cache
  event propagation before changing UI state logic.

## Out of scope

- Changing feature-map YAML schema or canonical storage format.
- Introducing a fixed shared draft path.
- Parsing model output or requiring JSON/fenced response blocks.
- Automatically failing a step when the draft is invalid.
- Adding a database migration.
- Updating changelogs or unrelated feature-map consumers.

## Coverage check

| Design section | Covered by |
| --- | --- |
| Problem / root cause | T0–T5 |
| Output path and format decisions | T1, T3 |
| Architecture and interfaces | T0–T4 |
| Data flow and state | T1–T3 |
| Error handling and logging | T1, T3, T4 |
| Security | T1, T4 |
| Test strategy | T1–T5 |
| Rollout and rollback | T5 |

## Discovered

- Full-suite baseline/environment issue: `electron/services/ssh-askpass-broker.test.ts`
  cannot start a real `ssh-agent` because the sandbox denies binding the agent
  socket. The feature-map and agent-service suites pass independently.
- The repository has no standalone `electron/ipc/handlers.test.ts`; Save IPC
  hardening is covered by the shared generation-service boundary and full-suite
  verification.
- UI readiness behavior is implemented in the existing action component; there
  was no pre-existing component test harness for this action to extend.
