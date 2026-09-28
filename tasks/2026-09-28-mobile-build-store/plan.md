# Mobile Build Store — Implementation Plan

## Preflight

- Install: `pnpm install`
- Tests: `pnpm test`
- Auto-fix lint: `pnpm lint --fix`
- Typecheck: `pnpm ts-check`
- Final lint: `pnpm lint`
- No commits requested; leave changes uncommitted.

## Wave table

| Wave | Tasks | Max concurrency |
| --- | --- | ---: |
| 0 | T0 contracts and migration | 1 |
| 1 | T1 fingerprint/discovery utilities; T2 store persistence/service | 2 |
| 2 | T3 IPC/preload/API wiring; T4 renderer Build Store UI | 2 |
| 3 | T5 integration tests and final verification | 1 |

## Tasks

- [x] **T0 — Build Store contracts and migration**
  - Wave: 0
  - Depends on: none
  - Owns: `shared/mobile-build-store.ts`, `electron/database/schema.ts`, `electron/database/migrations/NNN_mobile_build_store.ts`, `electron/database/migrator.ts`
  - Reads: `shared/mobile-simulator-types.ts`, existing migration numbering, `electron/database/schema.ts`
  - Do: add shared DTOs and request types, database table types, additive migration, and migration registration. Keep implementation-free contracts.
  - Tests: migration creates indexes and can be rolled back; shared types compile.
  - Verify: `pnpm vitest run electron/database --passWithNoTests`
  - Done when: all later IPC/service/UI work has typed shared seams.

- [x] **T1 — Fingerprinting and artifact discovery**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/services/mobile-build-store-fingerprint.ts`, `electron/services/mobile-build-store-fingerprint.test.ts`, `electron/services/mobile-build-store-discovery.ts`, `electron/services/mobile-build-store-discovery.test.ts`
  - Reads: `shared/mobile-build-store.ts`, mobile project detector path conventions, platform adapter validation.
  - Do: implement deterministic project fingerprinting with exclusions and standard Android/iOS simulator artifact discovery with diagnostics and ambiguity rejection.
  - Tests: stable ordering, source/config changes, excluded generated files, one/no/multiple/stale candidates, path containment.
  - Verify: `pnpm vitest run electron/services/mobile-build-store-fingerprint.test.ts electron/services/mobile-build-store-discovery.test.ts`
  - Done when: discovery never guesses between equally valid artifacts and diagnostics explain every failure.

- [x] **T2 — Persistent Build Store service**
  - Wave: 1
  - Depends on: T0, T1
  - Owns: `electron/services/mobile-build-store-service.ts`, `electron/services/mobile-build-store-service.test.ts`, `electron/database/repositories/mobile-build-artifact-repository.ts`
  - Reads: T0 contracts, T1 utilities, `electron/services/run-command-service.ts`, Android/iOS install adapters, repository patterns.
  - Do: implement list/build/install/delete, metadata persistence, userData artifact root, atomic copies, package-scoped serialization, and structured diagnostics. Use existing command-runner logs and adapters.
  - Tests: metadata lifecycle, fingerprint freshness, atomic failure, path safety, install dispatch, delete isolation, missing artifact handling.
  - Verify: `pnpm vitest run electron/services/mobile-build-store-service.test.ts`
  - Done when: service owns all filesystem/process orchestration and never trusts renderer paths.

- [x] **T3 — IPC, preload, and renderer API wiring**
  - Wave: 2
  - Depends on: T2
  - Owns: `src/lib/api.ts`, `electron/preload.ts`, `electron/ipc/handlers.ts`
  - Reads: T0 contracts, T2 service, neighboring IPC registrations.
  - Do: expose typed list/build/install/delete methods and validate/delegate in IPC handlers.
  - Tests: handler request validation and delegation; preload/API shape compile.
  - Verify: `pnpm vitest run electron/ipc --passWithNoTests`
  - Done when: renderer has no direct filesystem/process access and all methods are typed end to end.

- [x] **T4 — Build Store UI in Mobile Dev pane**
  - Wave: 2
  - Depends on: T3
  - Owns: `src/features/task/ui-task-panel/mobile-dev-pane/index.tsx`, `src/features/task/ui-task-panel/mobile-dev-pane/ui-build-store/index.tsx`, `src/features/task/ui-task-panel/mobile-dev-pane/ui-build-store/index.test.tsx`, `src/features/task/ui-task-panel/mobile-dev-pane/utils-build-store.ts`, `src/features/task/ui-task-panel/mobile-dev-pane/utils-build-store.test.ts`
  - Reads: T0 contracts, T3 API, current mobile-dev pane/build button tests and UI conventions.
  - Do: add Build Store panel, artifact freshness/metadata display, build-then-offer-install behavior, device compatibility handling, delete confirmation, loading/error/empty states, and preserve current Build/log flow.
  - Tests: current/stale rows, build success, install/delete actions, empty/loading/error states, no device selected.
  - Verify: `pnpm vitest run src/features/task/ui-task-panel/mobile-dev-pane/ui-build-store/index.test.tsx src/features/task/ui-task-panel/mobile-dev-pane/utils-build-store.test.ts`
  - Done when: the pane makes cached reuse visible and never silently changes device state after build.

- [x] **T5 — Integration coverage and final verification**
  - Wave: 3
  - Depends on: T3, T4
  - Owns: `electron/services/mobile-build-store-integration.test.ts`, `tasks/2026-09-28-mobile-build-store/plan.md`
  - Reads: all implementation files.
  - Do: add the narrow integration coverage for IPC-to-service-to-adapter seams, run required repository checks, tick completed tasks, and record discoveries.
  - Tests: one Android and one iOS simulator happy path with mocked command/discovery/adapter boundaries; failure diagnostics.
  - Verify: `pnpm test`
  - Done when: `pnpm ts-check`, `pnpm lint`, and `pnpm test` pass after `pnpm install` and `pnpm lint --fix`.

## Critical path

`T0 → T1/T2 → T3 → T4 → T5`.

T1 and T2 can be parallel in a real multi-agent run, but this environment has no agent dispatch capability, so they will be executed serially while preserving ownership boundaries.

## File ownership check

Each file is owned by exactly one task. T5 owns the plan only to tick checkboxes and record discoveries; it does not modify implementation files.

## Do not parallelize

- Migration registration and dependency installation.
- Repository-wide lint auto-fix and full test/typecheck barriers.
- Any operation that binds a fixed device/build process or mutates the artifact store root.

## Risk list

- Arbitrary custom build commands may not emit standard outputs. Fallback: fail with searched roots/candidates and keep the future explicit output-path extension out of V1.
- Existing command runner status may not expose a clean completion callback. Fallback: add a service-level wait/poll seam around the existing status rather than spawning a second runner.
- iOS `.app` bundles are directories and can be large. Fallback: copy to a unique temp directory and atomically rename only after completion.

## Out of scope

- Signed iOS device IPA support.
- Remote/cloud artifact storage.
- Automatic eviction.
- Global package-manager/build-cache management.
- Arbitrary custom output templates in V1.

## Coverage check

| Design section | Tasks |
| --- | --- |
| Problem and success criteria | T4, T5 |
| Architecture and interfaces | T0, T2, T3 |
| Data model and migration | T0, T2 |
| Fingerprinting | T1, T2 |
| Artifact discovery | T1, T2 |
| Error handling and observability | T1, T2, T4, T5 |
| Security and safety | T2, T3 |
| Test strategy | T1, T2, T4, T5 |
| Rollout and out of scope | T5 |

## Discovered

- Baseline/full-suite environment failure: `electron/services/ssh-askpass-broker.test.ts` cannot run its real `ssh-agent` case because the sandbox rejects creation of the SSH agent socket. The suite otherwise passed: 487 files passed, 6,495 tests passed, 5 skipped.
- The repository's lint command exits successfully but retains import-order warnings in existing files and some new files; `pnpm lint --fix` was run as required.
- Review fixes: normalized device-specific commands before fingerprinting, made artifact promotion atomic with orphan cleanup, rejected iOS device bundles for simulator installs, and added delete confirmation.
- Final full-suite run: 486 files passed, 2 failed, 1 skipped; 6,495 tests passed, 1 failed, 5 skipped. The failures are the sandbox-restricted `ssh-agent` case and a focus-restoration test that passes when run in isolation.
- UI refinement: normal Mobile Dev builds now persist successful artifacts automatically; the pane uses a compact Build + chevron control, and Build Store management opens in a modal.
