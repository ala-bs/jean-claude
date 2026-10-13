# Model Profiles & Project Policy — Implementation Plan

Design: `docs/plans/2026-09-19-model-profiles-and-project-policy-design.md`

## Preflight

```sh
pnpm install
pnpm test                 # vitest run
pnpm ts-check             # tsc --noEmit -p tsconfig.web.json && -p tsconfig.node.json
pnpm lint --fix           # oxlint --fix
pnpm lint                 # oxlint
```

Scoped test command per task: `pnpm vitest run <path>`.
Whole-program typechecking (`pnpm ts-check`) runs **at wave barriers only** — `tsc` is
whole-program, so a scoped typecheck does not exist and agents mid-wave will see transient
errors from siblings.

Next free migration number: **092** (last is `091_project_work_item_display_config.ts`).

## Wave table

| Wave | Tasks | Concurrency |
| --- | --- | --- |
| 0 | T0 | 1 (serial) |
| 1 | T1 T2 T3 T4 T5 T6 T7 | 7 |
| 2 | T8 T9 T10 T11 T12 T18 | 6 |
| 3 | T13 T14 T15 T20 T21 | 5 |
| 4 | T16 T17 T22 | 3 |
| 5 | T23 T24 T25 | 3 |
| 6 | T26 | 1 |
| 7 | T27 | 1 (serial) |
| 8 | T28 T29 T30 T31 | 4 |
| 9 | T32 | 1 |
| 10 | T33 | 1 (serial) |
| 11 | T34 T35 | 2 |

Critical path: **T0 → T1 → T8 → T13 → T16** (5 deep). Everything else hangs off T0 or T1.
The depth comes from: contracts → resolver → main-process consumers → UI pickers → docs.
It cannot be flattened further because the resolver is genuinely shared by both processes.

---

## Wave 0 — contracts

- [x] **T0 — Contracts: types, settings definitions, migration, module skeletons**
  - Wave: 0
  - Depends on: —
  - Owns: `shared/model-profiles.ts`, `shared/types.ts`, `electron/database/schema.ts`, `electron/database/migrations/092_model_profiles_and_project_policy.ts`, `electron/database/migrator.ts`, `electron/services/model-profile-service.ts`, `shared/model-policy-file.ts`, `src/lib/api.ts`, `electron/preload.ts`
  - New files: `shared/model-profiles.ts`, `shared/model-policy-file.ts`, `electron/services/model-profile-service.ts` (stubs only), migration 092
  - Reads: the design doc, `shared/agent-backend-types.ts`, `shared/thinking-settings.ts`
  - Do:
    - In `shared/model-profiles.ts` declare: `ModelRole` (the 12 roles from design §2),
      `ROLE_DEFINITIONS` (id, label, `canBeOff`, `slotId?`), `RoleBinding = string | 'inherit' | 'off'`,
      `ModelProfile { id, name, roles: Partial<Record<ModelRole, RoleBinding>> }`,
      `ProjectModelPolicy { mode, allowedBackends?, allowedPresetIds?, pinnedProfileId? }`,
      `ResolvedModel { backend, model, thinkingEffort, source, blocked? }`, and the
      signature of `resolveModelForRole(...)` with `throw new Error('not implemented')`.
    - In `shared/types.ts`: add `SETTINGS_DEFINITIONS` entries `modelProfiles`,
      `activeModelProfileId`, `modelFallbackOrder` with validators. Mark
      `backends.defaultBackend`, `backendDefaultModels`, `thinkingSettings`, `summaryModels`,
      `prReviewAgent`, `agentMemory.extraction*`, `rateLimitSwap` as `@deprecated` — do **not**
      delete them yet (T16 does, after every consumer has moved).
    - Migration 092: add `projects.modelPolicy` (text, nullable); drop
      `projects.defaultAgentBackend` and `projects.defaultAgentModelPreference` using the
      table-recreation pattern from AGENTS.md (`PRAGMA foreign_keys = OFF`, transaction,
      `PRAGMA foreign_key_check`). Register in `migrator.ts`.
    - `model-profile-service.ts`: exported function signatures only, stub bodies.
    - `model-policy-file.ts`: `readPolicyFile(cwd): Promise<ProjectModelPolicy | null>` stub.
    - `src/lib/api.ts` + `electron/preload.ts`: declare the new IPC surface
      (`settings` keys are generic so only `modelProfiles.resolve` /
      `modelProfiles.activate` / `projects.getEffectivePolicy` need adding), stubs throwing.
  - Tests: none (contracts only).
  - Verify: `pnpm ts-check`
  - Done when: `pnpm ts-check` is clean, every later task's imports resolve, no logic added.

---

## Wave 1 — independent implementations against T0

- [x] **T1 — `resolveModelForRole` resolver + policy clamping**
  - Wave: 1
  - Depends on: T0
  - Owns: `shared/model-profiles.ts`, `shared/model-profiles.test.ts`
  - Reads: `shared/thinking-settings.ts`, `shared/agent-backend-types.ts`
  - Do: implement the design §3 chain — role → project policy (clamp/pin/reject) → active
    profile → preset → triple. Resolve `'inherit'` to the `agent` role (guard against cycles),
    `'off'` to a disabled result. Apply `normalizeThinkingEffortForModel` at the end. Pure
    function, no IO, usable from both processes.
  - Tests: inherit chain; `off` on a non-`canBeOff` role rejected; `enforce` blocks a
    disallowed backend and returns `blocked.reason`; `prefer` pins but allows override;
    unknown role id treated as `inherit`; missing preset id falls back without throwing.
  - Verify: `pnpm vitest run shared/model-profiles.test.ts`
  - Done when: tests green, function is pure, no `any`.

- [x] **T2 — Settings repository: normalizers + migration of legacy keys**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/database/repositories/settings.ts`, `electron/database/repositories/settings.test.ts`
  - Reads: `shared/model-profiles.ts`, `shared/types.ts`
  - Do: add `normalizeModelProfilesSetting` and `migrateLegacyModelSettingsToProfiles`,
    following the existing `migrateRateLimitSwapSetting` (line 370) and
    `migrateLegacyMemorySettingToAgentMemory` (201-232) patterns. Implement design §6
    migration steps 1-5: dedupe triples into presets, build a `Default` profile, one profile
    per additional enabled backend, set `activeModelProfileId`, derive `modelFallbackOrder`
    from old `rateLimitSwap`. Idempotent — re-running must not duplicate presets.
  - Tests: legacy fixture with all 8 old keys → expected presets/profiles; idempotency
    (run twice, same result); empty/corrupt legacy value falls back to defaults.
  - Verify: `pnpm vitest run electron/database/repositories/settings.test.ts`
  - Done when: tests green, migration idempotent.

- [x] **T3 — Projects repository: `modelPolicy` column**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/database/repositories/projects.ts`, `electron/database/repositories/projects.test.ts`
  - Reads: `electron/database/schema.ts`, `shared/model-profiles.ts`
  - **T0 contract:** expose `ProjectRepository.setModelPolicy(id, policy)` (JSON.stringify on
    write, parse in `parseProjectRow` into `Project.modelPolicy`). `modelPolicy` is
    deliberately NOT on `NewProject`/`UpdateProject` — those spread `...rest` into Kysely and
    an object field breaks until the repo serializes it. Do not add it to `shared/types.ts`
    (you don't own that file); use `setModelPolicy`.
  - **Do NOT remove** `defaultAgentBackend`/`defaultAgentModelPreference` handling — the
    columns still exist until T16's migration 093 and other tasks' files still read them.
  - Do: parse/serialize `modelPolicy` JSON following the `aiSkillSlots` pattern (lines
    109-113, 167, 222/243, 271/301-303). Remove all `defaultAgentBackend` /
    `defaultAgentModelPreference` handling. Default to `{ mode: 'inherit' }` when null.
  - Tests: setModelPolicy/read round-trip; null → `inherit`; malformed JSON → `inherit`.
  - Verify: `pnpm vitest run electron/database/repositories/projects.test.ts`
  - Done when: tests green, `modelPolicy` round-trips.

- [x] **T4 — Repo policy file reader**
  - Wave: 1
  - Depends on: T0
  - Owns: `shared/model-policy-file.ts`, `shared/model-policy-file.test.ts`
  - Reads: `shared/model-profiles.ts`
  - Do: read `<cwd>/.jean-claude/model-policy.json`, validate, return `null` when absent or
    invalid (never throw into callers). Per design §8, intersect `allowedBackends` with the
    caller-supplied `enabledBackends` so a repo file can only restrict, never grant.
  - Tests: absent file → null; valid file parsed; malformed JSON → null + no throw; a backend
    not in `enabledBackends` is dropped from `allowedBackends`.
  - Verify: `pnpm vitest run shared/model-policy-file.test.ts`
  - Done when: tests green, never throws.

- [x] **T5 — Model profile service (main process)**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/services/model-profile-service.ts`, `electron/services/model-profile-service.test.ts`
  - Reads: `shared/model-profiles.ts`, `shared/model-policy-file.ts`, `electron/database/repositories/settings.ts`
  - Do: load profiles/presets/active id from settings, compute effective policy (repo file
    via T4 if present, else project row per design §2), and expose
    `resolveForRole({ role, projectId })` delegating to T1. Cache per-project policy with
    invalidation on project update. Inject dependencies (settings getter, policy reader) so
    tests need no DB — mirror `createAgentMemoryExtractionService`.
  - Tests: repo file wins over DB policy; `enforce` + disallowed profile → blocked result;
    cache invalidated on update.
  - Verify: `pnpm vitest run electron/services/model-profile-service.test.ts`
  - Done when: tests green, no direct DB import (all injected).

- [x] **T6 — Profiles Zustand store + React Query hooks**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/hooks/use-model-profiles.ts`, `src/hooks/use-model-profiles.test.ts`
  - Reads: `src/hooks/use-settings.ts`, `src/lib/api.ts`, `shared/model-profiles.ts`
  - Do: `useModelProfilesSetting`, `useActiveModelProfile`, `useActivateModelProfile`
    (optimistic), `useResolvedModelForRole(role, projectId)`. Follow the existing
    `use-settings.ts` optimistic-update pattern. Per AGENTS.md: stable selectors, no
    new-object-per-call, `EMPTY_ARRAY` over `[]`.
  - Tests: activate is optimistic and rolls back on error; selector identity is stable across
    unrelated setting changes.
  - Verify: `pnpm vitest run src/hooks/use-model-profiles.test.ts`
  - Done when: tests green, no unstable selector.

- [x] **T7 — Keyboard bindings + command palette entries**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/common/hooks/use-commands/model-profile-commands.ts`, `docs/keyboard-shortcuts.md`
  - Reads: `src/common/context/keyboard-bindings/index.tsx`, `src/hooks/use-model-profiles.ts`
  - Do: register `cmd+.` (cycle profiles) and `cmd+1..9` (jump to profile N) via
    `useCommands` with `label` + `section` so they appear in the palette.
    **Before writing:** run `node scripts/list-shortcuts.mjs --check`, read
    `docs/keyboard-shortcuts.md`, and confirm neither key is already bound or OS-reserved. If
    `cmd+1..9` collides with existing navigation, use `cmd+shift+1..9` and say so in the task
    notes — do not shadow an existing binding (dispatch is LIFO with no layer precedence).
    Finish with `node scripts/list-shortcuts.mjs --write`.
  - Tests: none (binding registration; covered by the generated table).
  - Verify: `node scripts/list-shortcuts.mjs --check`
  - Done when: `--check` passes and the regenerated table is committed in this task.

---

## Wave 2 — consumers move onto the resolver

Each task re-points one consumer from its deprecated settings key to
`modelProfileService.resolveForRole`. Disjoint file sets.

- [x] **T8 — Agent service + rate-limit swap → profiles**
  - Wave: 2
  - Depends on: T1, T5
  - Owns: `electron/services/agent-service.ts`, `electron/services/agent-service.test.ts`,
    `electron/services/rate-limit-swap-service.ts`, `electron/services/rate-limit-swap-service.test.ts` *(new)*,
    `electron/services/agent-session-update.ts`
  - Reads: `shared/model-profiles.ts`, `electron/services/model-profile-service.ts`
  - Do:
    - `resolveRunModelSettings` (agent-service.ts:520-538): resolve the `agent` role instead
      of reading the step triple directly; keep the step's explicit override when the policy
      allows it. **Stop dropping model/effort to `undefined` on a cross-backend swap.**
    - Enforce the policy at `createSession` (~line 1457): a blocked result throws a visible
      error rather than silently spawning.
    - `rate-limit-swap-service.ts`: `resolveBackend` now activates the next **profile** in
      `modelFallbackOrder` rather than returning a per-entry triple. Per design §4, running
      steps keep their model — only new sessions pick up the switch. Per design §8, a project
      in `enforce` mode whose permitted backend is limited gets a blocking error and **no**
      fallback.
  - Tests: swap preserves model+effort; `enforce` project blocks instead of falling back;
    running session unchanged after a profile switch; new session picks the new profile.
  - Verify: `pnpm vitest run electron/services/agent-service.test.ts electron/services/rate-limit-swap-service.test.ts`
  - Done when: tests green; `rate-limit-swap-service` gains its first test file.

- [x] **T9 — Summary + PR review + memory → roles**
  - Wave: 2
  - Depends on: T1, T5
  - Owns: `electron/services/step-service.ts`, `electron/services/step-service.test.ts`,
    `electron/services/pr-review-agent-service.ts`, `electron/services/pr-review-agent-service.test.ts`,
    `electron/services/agent-memory-scheduler-service.ts`, `electron/services/agent-memory-scheduler-service.test.ts`,
    `electron/services/agent-memory-dashboard-service.ts`, `electron/services/agent-memory-dashboard-service.test.ts`,
    `electron/services/agent-memory-extraction-service.ts`
  - Reads: `electron/services/model-profile-service.ts`, `shared/model-profiles.ts`
  - Do: replace `SettingsRepository.get('summaryModels')` (step-service.ts:677) with the
    `summary` role; `prReviewAgent` (pr-review-agent-service.ts:217-225) with `pr-review`;
    `agentMemory.extraction*` (scheduler 218-220 / 309-311, dashboard 246-247, extraction
    329-332) with `memory`. Keep the existing injected-dependency shape — swap the injected
    getter, don't import the service directly.
  - Tests: each service resolves via the role; `off` binding disables the feature cleanly.
  - Verify: `pnpm vitest run electron/services/step-service.test.ts electron/services/pr-review-agent-service.test.ts electron/services/agent-memory-scheduler-service.test.ts electron/services/agent-memory-dashboard-service.test.ts`
  - Done when: tests green, no `summaryModels`/`prReviewAgent`/`extractionBackend` reads left.

- [x] **T10 — AI skill slot resolver → per-slot roles + `ai-generation` catch-all**
  - Wave: 2
  - Depends on: T1, T5
  - Owns: `electron/services/ai-skill-slot-resolver.ts`, `electron/services/ai-skill-slot-resolver.test.ts`,
    `electron/services/ai-generation-service.ts`, `electron/services/ai-generation-service.test.ts`
  - Reads: `shared/model-profiles.ts`
  - Do: rewrite the fallback chain (resolver lines 46-70) per design §2 — project slot →
    global slot → named role for that slot (one of the six) → `ai-generation` → `agent` via
    `inherit`. Delete the `backends` / `backendDefaultModels` fallback (lines 16, 26).
    In `ai-generation-service.ts`, update the swap hook at line 52 to the profile-based swap.
  - Tests: each of the six slots maps to its role; an unknown slot id uses `ai-generation`;
    explicit per-slot config still wins over the profile.
  - Verify: `pnpm vitest run electron/services/ai-skill-slot-resolver.test.ts electron/services/ai-generation-service.test.ts`
  - Done when: tests green, no reference to `backendDefaultModels` remains.

- [x] **T11 — Completion services → `completion` / `ai-generation` roles**
  - Wave: 2
  - Depends on: T1, T5
  - Owns: `electron/services/completion-service.ts`, `electron/services/completion-service.test.ts`,
    `electron/services/completion-context-generation-service.ts`
  - Reads: `shared/model-profiles.ts`
  - Do: `completion-service.ts` honours the `completion` role, including `'off'` (return no
    completion, do not construct the Mistral client). Replace the hardcoded `model: 'haiku'`
    in `completion-context-generation-service.ts:19-70` with the `ai-generation` role, per
    the design decisions log.
  - Tests: `off` short-circuits before client construction; role triple reaches the client.
  - Verify: `pnpm vitest run electron/services/completion-service.test.ts`
  - Done when: tests green; `completion-service` gains its first test file.

- [x] **T12 — IPC handlers: profile + policy surface**
  - Wave: 2
  - Depends on: T0, T5
  - Owns: `electron/ipc/handlers.ts`, `electron/ipc/model-profiles.test.ts`
  - Reads: `electron/services/model-profile-service.ts`, `src/lib/api.ts`
  - Do: implement the handlers T0 declared — `modelProfiles:resolve`,
    `modelProfiles:activate`, `projects:getEffectivePolicy`. Rewrite the rate-limit handlers
    (5465-5480, 5594-5596) onto the profile-based swap. Remove `project.defaultAgentBackend`
    reads at 1845 and 7056 and the backend validation at 1555-1556.
  - **Added after T5:** T5 exposes `ModelProfileService.invalidateProjectPolicyCache({ projectId })`
    because T0's contract had no way to express cache invalidation. Call it from every project
    write path in `handlers.ts` (create / update / setModelPolicy), or the effective policy
    goes stale after a project edit and an `enforce` change won't take effect until restart.
  - Tests: activate persists + broadcasts; resolve returns a blocked result under `enforce`;
    a project update invalidates the policy cache.
  - Verify: `pnpm vitest run electron/ipc/model-profiles.test.ts`
  - Done when: tests green, no reference to the dropped project columns.

- [x] **T18 — Run the legacy settings migration at startup**
  - Wave: 2
  - Depends on: T2
  - Owns: `electron/database/index.ts`, `electron/database/model-settings-migration.test.ts`
  - Reads: `electron/database/repositories/settings.ts`, `shared/model-profiles.ts`
  - **Why this task exists:** T2 built `migrateLegacyModelSettingsToProfiles` but flagged that
    *nothing calls it*. As planned, no user's settings would ever actually migrate — profiles
    would be empty on every existing install and the whole feature would look broken on
    upgrade. This gap was invisible until T2 reported it.
  - Do: after `migrator.migrateToLatest()` succeeds in `electron/database/index.ts:33`, read the
    8 legacy keys, call `migrateLegacyModelSettingsToProfiles`, and persist `modelProfiles`,
    `activeModelProfileId`, `modelFallbackOrder` and any new `backendModelPresets` — only when
    `modelProfiles` is currently unset/empty, so a user who has since edited their profiles is
    never overwritten. T2's ids are content-derived and the function is idempotent, so a
    re-run is safe, but the emptiness guard is still required.
  - Tests: fresh DB with legacy settings → profiles created; second startup → unchanged;
    startup with user-edited profiles → left alone; no legacy settings → no-op.
  - Verify: `pnpm vitest run electron/database/model-settings-migration.test.ts`
  - Done when: tests green, migration runs exactly once per install.

---

## Wave 3 — UI

- [x] **T13 — Profile switcher (header + composer)**
  - Wave: 3
  - Depends on: T6, T7, T12
  - Owns: `src/features/agent/ui-model-profile-switcher/index.tsx`,
    `src/features/agent/ui-model-profile-switcher/index.test.tsx` *(new)*,
    `src/features/agent/ui-backend-preset-selector/index.tsx`,
    `src/features/agent/utils-backend-model-selection/index.ts`
  - Reads: `src/hooks/use-model-profiles.ts`, `shared/model-profiles.ts`
  - Do: build the design §5 dropdown — profile list with active marker and shortcut hints,
    `Override this step only…` submenu wrapping the existing backend/model/thinking pickers,
    `Edit profiles…`. Under `enforce`, disabled profiles show the policy reason and the
    override entry is hidden. Replace `resolveBackendModelSelection`'s four-source
    reconciliation with a call to the T1 resolver.
  - Tests: renders active profile; enforce hides override; selecting a profile calls activate.
  - Verify: `pnpm vitest run src/features/agent/ui-model-profile-switcher/index.test.tsx`
  - Done when: tests green, no model/thinking logic left in `utils-backend-model-selection`.

- [x] **T14 — Settings: profile & preset editor**
  - Wave: 3
  - Depends on: T6, T12
  - Owns: `src/features/settings/ui-model-profiles-settings/index.tsx`,
    `src/features/settings/ui-model-profiles-settings/index.test.tsx` *(new)*,
    `src/features/settings/ui-model-presets-settings/index.tsx`,
    `src/features/settings/ui-general-settings/index.tsx`,
    `src/features/settings/ui-rate-limit-swap-settings/index.tsx`,
    `src/features/settings/ui-settings-overlay/index.tsx`
  - Reads: `src/hooks/use-model-profiles.ts`, `shared/model-profiles.ts`
  - Do: new panel — profile CRUD, role→preset table with `inherit` / `off`, per-profile role
    rows. Strip from `ui-general-settings` the default-backend radio (1318-1343), per-backend
    default model, the thinking-effort editor (1413-1575), the summary models section
    (2208-2225) and the PR review agent section (869-880) — all now profile-driven. Rewrite
    `ui-rate-limit-swap-settings` as an ordered profile list.
  - Tests: create/edit/delete a profile; `off` unavailable on `agent`; reordering fallback.
  - Verify: `pnpm vitest run src/features/settings/ui-model-profiles-settings/index.test.tsx`
  - Done when: tests green, deleted sections gone.

- [x] **T15 — Project settings: model policy editor**
  - Wave: 3
  - Depends on: T6, T12
  - Owns: `src/features/project/ui-project-model-policy/index.tsx`,
    `src/features/project/ui-project-model-policy/index.test.tsx` *(new)*,
    `src/features/project/ui-project-settings/index.tsx`
  - Reads: `src/hooks/use-model-profiles.ts`, `shared/model-policy-file.ts`
  - Do: mode selector (`inherit` / `prefer` / `enforce`), allowed-backends multi-select,
    pinned-profile picker. When a repo `.jean-claude/model-policy.json` exists, render
    read-only with a "defined in `.jean-claude/model-policy.json`" note. Remove the old
    `global | project` backend/model toggle (`ui-project-settings/index.tsx` 800-1000,
    1691-1730).
  - Tests: repo-file-present renders read-only; enforce requires at least one allowed backend.
  - Verify: `pnpm vitest run src/features/project/ui-project-model-policy/index.test.tsx`
  - Done when: tests green, old toggle removed.

- [x] **T20 — Effective-profile accessor (fixes T10's pinned-profile gap)**
  - Wave: 3
  - Depends on: T5, T10
  - Owns: `electron/services/model-profile-service.ts`, `electron/services/model-profile-service.test.ts`, `electron/services/ai-skill-slot-resolver.ts`, `electron/services/ai-skill-slot-resolver.test.ts`
  - Reads: `shared/model-profiles.ts`
  - **Why this task exists:** T10 reported that choosing between a slot's named role and
    the `ai-generation` catch-all reads the *globally active* profile via `getActiveProfile()`,
    because `ModelProfileService` exposes no "effective profile for this project" accessor.
    A project that pins a different profile (`prefer`/`enforce` + `pinnedProfileId`) therefore
    picks the role binding from the wrong profile. The resolved triple is still policy-correct
    (that goes through `resolveForRole`), so the blast radius is only the role-vs-catch-all
    choice — but it is wrong, and it is wrong exactly in the org-policy case this design exists
    to serve.
  - Do: add `getEffectiveProfile({ projectId })` to `ModelProfileService`, returning the pinned
    profile when policy mode is `prefer`/`enforce` and a `pinnedProfileId` is set, else the
    globally active profile. Re-point `ai-skill-slot-resolver` at it. Pass `projectId` through.
  - Tests: pinned project uses the pinned profile's role binding; unpinned uses the active one;
    `inherit` mode ignores `pinnedProfileId`.
  - Verify: `pnpm vitest run electron/services/model-profile-service.test.ts electron/services/ai-skill-slot-resolver.test.ts`
  - Done when: tests green, `getActiveProfile()` no longer used for a project-scoped decision.

- [x] **T21 — Wire the rate-limit reaction, banner and auto-revert**
  - Wave: 3
  - Depends on: T8, T12
  - Owns: `src/features/agent/ui-rate-limit-banner/index.tsx`, `src/features/agent/ui-rate-limit-banner/index.test.tsx`, `src/hooks/use-rate-limit-fallback.ts`, `src/hooks/use-rate-limit-fallback.test.ts`
  - Reads: `electron/services/rate-limit-swap-service.ts`, `src/hooks/use-model-profiles.ts`, `src/lib/api.ts`
  - **Why this task exists:** T8 reported that `resolveBackend`'s `activate: true` option is
    passed **nowhere outside its own tests**. Production only ever *probes* for a fallback and
    never activates one — deliberately, because the status probe loops over every backend and
    flipping the active profile as a side effect of a probe would be a bug. The result is that
    design §4 — the single use case that motivated this whole feature — is not actually wired
    end to end. No wave-3 task covered the banner or auto-revert either.
  - Do: add the renderer reaction — on a real rate-limit event (not the status probe) call the
    resolve path with `activate: true` and the current `projectId` so §8 blocking applies; show
    the design §5 banner ("Claude limit reached — switched to Codex fallback · revert"); revert
    when the quota resets or on click. Per design §4 running steps keep their model; only new
    steps pick up the switch — do not restart anything.
  - Tests: activates exactly once per limit event; banner reverts; an `enforce` project shows a
    blocking error instead of switching.
  - Verify: `pnpm vitest run src/hooks/use-rate-limit-fallback.test.ts src/features/agent/ui-rate-limit-banner/index.test.tsx`
  - Done when: tests green, `activate: true` reachable from production code.

---

## Wave 4 — cleanup & docs

- [x] **T16 — Delete deprecated settings keys and duplicate registries**
  - Wave: 4
  - Depends on: T8, T9, T10, T11, T12, T13, T14, T15
  - Owns: `electron/database/migrations/093_drop_project_default_backend.ts`,
    `shared/types.ts`, `shared/types.test.ts`, `shared/thinking-settings.ts`,
    `src/features/agent/ui-backend-selector/index.tsx`, `src/features/agent/ui-model-selector/index.tsx`,
    `src/hooks/use-settings.ts`, `src/hooks/use-settings.test.ts`
  - Reads: everything from waves 2-3
  - **Added after T0:** write migration **093** dropping `projects.defaultAgentBackend` and
    `projects.defaultAgentModelPreference` (table-recreation pattern), and register it in
    `migrator.ts`. T0 deliberately did NOT drop them: the project-settings UI still *wrote*
    both through `ProjectRepository.update`, so dropping them in 092 would have caused a
    runtime "no such column" on save and broke `ts-check` in six files T0 doesn't own. By
    wave 4 every reader and writer has moved, so the drop is safe. Note `migrator.ts` is
    owned by T0 in wave 0 — no conflict, different waves.
  - Do: now that no consumer reads them, delete `backends.defaultBackend`,
    `backendDefaultModels`, `thinkingSettings`, `summaryModels`, `prReviewAgent`,
    `agentMemory.extraction*`, `rateLimitSwap` and their hooks/validators. Collapse the
    duplicate registries the scan found: the backend list appears in 4 places
    (`AgentBackendType`, `SETTINGS_DEFINITIONS` literals, `settings.ts` normalizers,
    `AVAILABLE_BACKENDS`) and the Claude model list in 3 — including a stale
    `claude-opus-4-5` in `ui-model-selector`. Derive all from one `BACKENDS` registry.
  - Tests: no stale key remains (`pnpm vitest run shared/types.test.ts`).
  - Verify: `pnpm vitest run shared/types.test.ts src/hooks/use-settings.test.ts`
  - Done when: tests green, `rg 'backendDefaultModels|defaultBackend|thinkingSettings'` returns
    only the migration in `settings.ts`.

- [x] **T22 — Mount the switcher, banner and shortcuts**
  - Wave: 4
  - Depends on: T13, T21, T7
  - Owns: `src/routes/__root.tsx`, `src/features/task/ui-task-panel/index.tsx`,
    `src/features/new-task/ui-new-task-overlay/index.tsx`,
    `src/features/task/ui-task-panel/add-step-dialog.tsx`
  - Reads: `src/features/agent/ui-model-profile-switcher/index.tsx`,
    `src/features/agent/ui-rate-limit-banner/index.tsx`,
    `src/common/hooks/use-commands/model-profile-commands.ts`
  - **Why this task exists:** a grep after wave 3 found three orphans — `ModelProfileSwitcher`,
    `RateLimitBanner` and `useModelProfileCommands` are referenced by nothing outside their own
    folders. The switcher is the primary UI of this entire feature, the banner is design §4's
    visible output, and the unused commands hook means `cmd+.` and `cmd+alt+1..9` do nothing.
    Root cause: every wave-3 task owned its own component folder, but **no task owned the mount
    points**, so each agent correctly built a component and correctly declined to edit a file
    outside its `Owns`. Integration was never assigned.
  - Do: render `<ModelProfileSwitcher />` where the old backend/model pickers live (task panel
    composer, new-task overlay, add-step dialog); render `<RateLimitBanner />` in
    `__root.tsx` near the existing `RateLimitSwapBridge` (line ~542) and decide whether the
    bridge's toast is now redundant — do not ship both a toast and a banner for one event;
    call `useModelProfileCommands()` from `__root.tsx` alongside the other root-level
    `useCommands` callers so the shortcuts actually register.
  - Tests: the existing task-panel and new-task-overlay suites must still pass; add one test
    asserting the switcher renders in the task panel.
  - Verify: `pnpm vitest run src/features/task/ui-task-panel/index.test.tsx`
  - Done when: tests green, and `grep -rl ModelProfileSwitcher src/` shows a mount point
    outside the component's own folder.

- [x] **T17 — Docs**
  - Wave: 4
  - Depends on: T13, T14, T15
  - Owns: `docs/plans/2026-09-19-model-profiles-and-project-policy-design.md`,
    `AGENTS.md`
  - Reads: the whole diff
  - Do: mark the design's decisions log as shipped; add a short "Model profiles" bullet to
    the AGENTS.md Key Concepts list. **Do not touch `changelogs/`** — per AGENTS.md, only on
    explicit request.
  - Tests: none.
  - Verify: `pnpm lint`
  - Done when: AGENTS.md documents the profile concept.

---

---

## Wave 5 — finish the consumer migration

**Why this wave exists.** T16 could not delete a single deprecated settings key: every one
still has live readers. A check after wave 4 confirmed the consequence is not cosmetic — the
new-task submit path still computes `agentBackend` / `modelPreference` from
`backends.defaultBackend` + `backendDefaultModels` via `resolveDefaultBackend` /
`getDefaultModelForBackend`, so **activating a profile does not change what a new task runs.**
The switcher is mounted and the services resolve roles correctly, but the draft/creation path
in the renderer was never migrated. Waves 2-3 covered the services and the new UI; nobody
owned the existing draft logic.

- [x] **T23 — New-task creation path → resolver**
  - Wave: 5
  - Depends on: T13, T16
  - Owns: `src/features/new-task/ui-new-task-overlay/index.tsx`, `src/routes/projects/$projectId/tasks/new.tsx`, `src/lib/default-models.ts`, `src/lib/default-models.test.ts`
  - Reads: `shared/model-profiles.ts`, `src/hooks/use-model-profiles.ts`
  - Do: delete `resolveDefaultBackend` and `getDefaultModelForBackend`; derive the submitted
    `agentBackend` / `modelPreference` / `thinkingEffort` from the `agent` role via the
    resolver, honoring an explicit per-step override. No reads of `backends.defaultBackend`,
    `backendDefaultModels` or `thinkingSettings` may remain.
  - Tests: creating a task uses the active profile's agent triple; switching profile changes it;
    an explicit override still wins.
  - Verify: `pnpm vitest run src/lib/default-models.test.ts src/features/new-task`
  - Done when: tests green, no legacy key read in these files.

- [x] **T24 — Task panel / step creation path → resolver**
  - Wave: 5
  - Depends on: T13, T16
  - Owns: `src/features/task/ui-task-panel/index.tsx`, `src/features/task/ui-task-panel/index.test.tsx`, `src/features/task/ui-task-panel/add-step-dialog.tsx`, `src/features/agent/ui-review-comments/review-submit-overlay.tsx`, `src/features/agent/ui-backend-model-preset-picker/index.tsx`
  - Reads: `shared/model-profiles.ts`, `src/hooks/use-model-profiles.ts`
  - Do: same migration for the step-level paths. The picker keeps working as the
    "override this step only" surface, but its defaults come from the resolver.
  - Tests: adding a step uses the active profile; override persists on the step.
  - Verify: `pnpm vitest run src/features/task/ui-task-panel/index.test.tsx`
  - Done when: tests green, no legacy key read in these files.

- [x] **T25 — Settings and onboarding leftovers → resolver**
  - Wave: 5
  - Depends on: T14, T16
  - Owns: `src/features/settings/ui-general-settings/index.tsx`, `src/features/settings/ui-ai-generation-settings/index.tsx`, `src/features/settings/ui-model-presets-settings/index.tsx`, `src/features/project/ui-project-skills-settings/index.tsx`, `src/routes/onboarding/setup.tsx`, `src/lib/onboarding-setup-state.test.ts`
  - Reads: `shared/model-profiles.ts`, `src/hooks/use-model-profiles.ts`
  - Do: drop the `defaultBackend` pass-through in `BackendsSettings`, remove the
    `SummaryModelSettings` import in `ui-ai-generation-settings`, and point onboarding at the
    profile instead of picking a default backend. These are T16's blockers 1 and 2.
  - Tests: existing suites pass; onboarding produces a usable profile.
  - Verify: `pnpm vitest run src/lib/onboarding-setup-state.test.ts`
  - Done when: tests green, no legacy key read in these files.

- [x] **T26 — Final key deletion (supersedes T16's blocked half)**
  - Wave: 6
  - Depends on: T23, T24, T25
  - Owns: `shared/types.ts`, `shared/types.test.ts`, `electron/database/repositories/settings.ts`, `electron/database/repositories/settings.test.ts`
  - Do: now that no consumer reads them, delete the `backends.defaultBackend`,
    `backendDefaultModels`, `thinkingSettings`, `summaryModels`, `prReviewAgent`,
    `rateLimitSwap` and `agentMemory.extraction*` definitions and validators. Keep
    `migrateLegacyModelSettingsToProfiles` and its legacy *parsing* — that is the upgrade path
    and must survive. Retire `VALID_AGENT_BACKENDS` in favor of `AGENT_BACKEND_IDS`.
  - Verify: `pnpm vitest run shared/types.test.ts electron/database/repositories/settings.test.ts`
  - Done when: the only remaining references are inside the migration.

---

## Waves 7-8 — design Revision 1 (inline role triples, per-profile presets)

See the design's `# Revision 1`. Roles stop pointing at a global preset id and hold their
own `{backend, model, thinkingEffort}`; presets move inside the profile as named shortcuts;
the global quick switcher becomes `profile.quickPresetIds`; policy enforces profiles rather
than preset ids.

- [x] **T27 — Contracts for Revision 1**
  - Wave: 7
  - Depends on: —
  - Owns: `shared/model-profiles.ts`, `shared/model-profiles.test.ts`
  - Do: introduce `ModelTriple`, `ProfilePreset`, `RoleBinding = ModelTriple | 'inherit' | 'off'`,
    `ModelProfile { id, name, presets, quickPresetIds, roles }`; replace
    `ProjectModelPolicy.allowedPresetIds` with `allowedProfileIds` (keep `allowedBackends` —
    a step-level override can still name a backend directly and must be refusable under
    `enforce`). Reimplement `resolveModelForRole` without its `presets` parameter: a binding
    is already a triple, so the lookup and the missing-preset fallback both disappear.
    Keep `isModelTriple` / normalization helpers exported for the migration and UI.
  - Tests: inline triple resolves; `inherit` chain unchanged; `off` unchanged; unknown role
    still treated as `inherit`; `enforce` + `allowedProfileIds` blocks; `allowedBackends`
    still blocks a step override.
  - Verify: `pnpm vitest run shared/model-profiles.test.ts`
  - Done when: tests green, `resolveModelForRole` takes no preset list.

- [x] **T28 — Settings migration to Revision 1**
  - Wave: 8
  - Depends on: T27
  - Owns: `electron/database/repositories/settings.ts`, `electron/database/repositories/settings.test.ts`, `electron/database/index.ts`, `electron/database/model-settings-migration.test.ts`
  - Do: migrate stored profiles in place — replace each `presetId` binding with that preset's
    triple (drop bindings whose preset is gone; they were already dead), copy the global
    `backendModelPresets` into every profile's `presets`, seed `quickPresetIds` from presets
    whose `showInQuickSwitcher !== false`. Then stop reading the two global keys. Idempotent:
    a profile whose bindings are already triples is untouched. Keep the wave-1 legacy
    migration working for users upgrading from before profiles existed.
  - Tests: preset ids inlined; dangling binding dropped; quick list seeded; idempotent;
    pre-profiles legacy path still produces a usable profile.
  - Verify: `pnpm vitest run electron/database/repositories/settings.test.ts electron/database/model-settings-migration.test.ts`
  - Done when: tests green, migration idempotent.

- [x] **T29 — Profile editor: triple rows, per-profile presets, quick list**
  - Wave: 8
  - Depends on: T27
  - Owns: `src/features/settings/ui-model-profiles-settings/index.tsx`, `src/features/settings/ui-model-profiles-settings/index.test.tsx`
  - Do: each role row becomes backend + model + thinking selectors (reuse the existing
    pickers) plus an "apply preset" affordance listing this profile's presets; add preset
    CRUD scoped to the selected profile; add the quick-list toggle per preset. `toggleOnly`
    roles keep their Switch. Keep the inherit label showing the resolved agent triple.
  - Tests: editing a role writes a triple; applying a preset fills the triple and does not
    store a reference; preset CRUD is per-profile; quick list toggles.
  - Verify: `pnpm vitest run src/features/settings/ui-model-profiles-settings/index.test.tsx`
  - Done when: tests green, no `presetId` stored in a role binding.

- [x] **T30 — Composer / overlay consumers on profile presets**
  - Wave: 8
  - Depends on: T27
  - Owns: `src/features/agent/ui-model-profile-switcher/index.tsx`, `src/features/agent/ui-model-profile-switcher/index.test.tsx`, `src/features/agent/utils-backend-model-selection/index.ts`, `src/features/agent/utils-backend-model-selection/index.test.ts`, `src/features/new-task/ui-new-task-overlay/index.tsx`, `src/stores/new-task-form.ts`
  - Do: quick chips come from the active profile's `quickPresetIds`; drop
    `useModelQuickSwitcherSetting` and the global preset list. Per-task override still stores
    a triple on the step.
  - Tests: chips follow the active profile; switching profile changes them; override still wins.
  - Verify: `pnpm vitest run src/features/agent/ui-model-profile-switcher/index.test.tsx src/features/agent/utils-backend-model-selection`
  - Done when: tests green, no global preset read.

- [x] **T31 — Remaining preset consumers**
  - Wave: 8
  - Depends on: T27
  - Owns: `src/features/task/ui-task-panel/add-step-dialog.tsx`, `src/features/agent/ui-backend-model-preset-picker/index.tsx`, `src/features/agent/ui-backend-preset-selector/index.tsx`, `src/features/agent/ui-review-comments/review-submit-overlay.tsx`, `src/features/common/ui-ai-skill-slot/index.tsx`, `src/features/settings/ui-ai-generation-settings/index.tsx`
  - Do: same migration for the remaining pickers. Anything that offered the global preset
    list now offers the active profile's presets.
  - Verify: `pnpm vitest run src/features/common/ui-ai-skill-slot`
  - Done when: tests green, no `useBackendModelPresetsSetting` callers left here.

- [x] **T32 — Policy on profiles + final key deletion**
  - Wave: 9
  - Depends on: T28, T29, T30, T31
  - Owns: `shared/types.ts`, `shared/types.test.ts`, `electron/services/model-profile-service.ts`, `electron/services/model-profile-service.test.ts`, `src/features/project/ui-project-model-policy/index.tsx`, `src/features/project/ui-project-model-policy/index.test.tsx`, `src/hooks/use-settings.ts`, `src/features/settings/ui-model-presets-settings/index.tsx`, `src/features/settings/ui-settings-overlay/index.tsx`
  - Do: enforce `allowedProfileIds` in the service; swap the policy UI's preset multi-select
    for a profile multi-select; delete the `backendModelPresets` and `modelQuickSwitcher`
    settings, `BackendModelPreset`, `BackendModelPresetsSetting`, `ModelQuickSwitcherSetting`
    and their hooks; delete the now-empty global presets settings panel and its nav entry.
  - Verify: `pnpm vitest run shared/types.test.ts electron/services/model-profile-service.test.ts src/features/project/ui-project-model-policy/index.test.tsx`
  - Done when: `rg 'backendModelPresets|showInQuickSwitcher|modelQuickSwitcher'` returns only the migration.

---

## Wave 10 — image roles + the feature-map role

**Why.** The "Project logos" row was a dead control. `project-logo-service.ts` posts straight
to `api.openai.com/v1/images/generations` with its own key and a model validated by
`isOpenAiImageModel` (`gpt-image*`), and it never calls `resolveAiSkillSlot` — so nothing read
the `project-logo` role, and a `(backend, model, thinking)` triple could not have been used
even if it had. Separately `project-feature-map` is a real, resolved AI skill slot with no
named role, so it silently rode the `ai-generation` catch-all.

- [x] **T33 — Contracts: image bindings + feature-map role**
  - Wave: 10
  - Depends on: —
  - Owns: `shared/model-profiles.ts`, `shared/model-profiles.test.ts`
  - Do: add `ImageModelBinding = { imageModel: string }` to `RoleBinding`; add
    `RoleDefinition.modelKind?: 'chat' | 'image'` (absent = chat); mark `project-logo` as
    `modelKind: 'image'`; add a `project-feature-map` role (chat, `slotId: 'project-feature-map'`).
    Add `resolveImageModelForRole({ role, profiles, activeProfileId, policy, fallbackModel })`
    → `{ imageModel, off, blocked? }`, so image roles never pretend to be a triple.
    An image role has no meaningful `inherit` (the agent role is a chat model): unset means
    "use the AI Generation default".
  - Tests: image binding resolves; unset falls back to the supplied default; `off` disables;
    a chat binding on an image role is rejected rather than coerced; feature-map role exists
    and maps to its slot.
  - Verify: `pnpm vitest run shared/model-profiles.test.ts`
  - Done when: tests green, `resolveModelForRole` still refuses to return an image binding.

- [x] **T34 — Profile editor: image role row**
  - Wave: 11
  - Depends on: T33
  - Owns: `src/features/settings/ui-model-profiles-settings/index.tsx`, `src/features/settings/ui-model-profiles-settings/index.test.tsx`
  - Do: render `modelKind: 'image'` rows as a GPT-image model input (validated with
    `isOpenAiImageModel`) plus `Off`, with an explicit "Default (from AI Generation settings)"
    state — no backend or thinking selector, no `Apply preset` (presets are chat triples).
    The new `project-feature-map` row needs nothing special; it appears from `ROLE_DEFINITIONS`.
  - Tests: image row offers no backend/thinking/preset controls; writes an `imageModel`
    binding; rejects a non-`gpt-image` value; `off` works.
  - Verify: `pnpm vitest run src/features/settings/ui-model-profiles-settings/index.test.tsx`
  - Done when: tests green.

- [x] **T35 — Wire logo generation and the feature-map slot**
  - Wave: 11
  - Depends on: T33
  - Owns: `electron/services/project-logo-service.ts`, `electron/services/project-logo-service.test.ts`, `electron/services/ai-skill-slot-resolver.ts`, `electron/services/ai-skill-slot-resolver.test.ts`
  - Do: make the logo service consult the `project-logo` role — `off` skips generation
    cleanly (no OpenAI call, no thrown error), a bound `imageModel` overrides
    `setting.openAiImageModel`, unset keeps today's behaviour. Point the
    `project-feature-map` slot at its new named role instead of the `ai-generation` catch-all.
  - Tests: `off` makes no HTTP call; bound image model reaches the request; unset uses the
    setting; feature-map slot resolves via its own role.
  - Verify: `pnpm vitest run electron/services/project-logo-service.test.ts electron/services/ai-skill-slot-resolver.test.ts`
  - Done when: tests green, logo generation is genuinely profile-controlled.

## File ownership check

| File | Owner |
| --- | --- |
| `shared/model-profiles.ts` | T0 (skeleton) → T1 (bodies) — different waves |
| `shared/model-policy-file.ts` | T0 (skeleton) → T4 (bodies) — different waves |
| `shared/types.ts` | T0 → T16 — different waves |
| `shared/thinking-settings.ts` | T16 |
| `electron/database/schema.ts` | T0 |
| `electron/database/migrations/092_*.ts` | T0 |
| `electron/database/migrations/093_*.ts` | T16 |
| `electron/database/migrator.ts` | T0 (w0) → T16 (w4) — different waves |
| `electron/database/repositories/settings.ts` | T2 |
| `electron/database/repositories/projects.ts` | T3 |
| `electron/services/model-profile-service.ts` | T0 → T5 |
| `electron/services/agent-service.ts` | T8 |
| `electron/services/rate-limit-swap-service.ts` | T8 |
| `electron/services/agent-session-update.ts` | T8 |
| `electron/services/step-service.ts` | T9 |
| `electron/services/pr-review-agent-service.ts` | T9 |
| `electron/services/agent-memory-scheduler-service.ts`, `electron/services/agent-memory-dashboard-service.ts`, `electron/services/agent-memory-extraction-service.ts` | T9 |
| `electron/services/ai-skill-slot-resolver.ts` | T10 |
| `electron/services/ai-generation-service.ts` | T10 |
| `electron/services/completion-service.ts`, `electron/services/completion-context-generation-service.ts` | T11 |
| `electron/ipc/handlers.ts` | T12 |
| `electron/database/index.ts` | T18 |
| `electron/preload.ts` | T0 |
| `src/lib/api.ts` | T0 |
| `src/hooks/use-model-profiles.ts` | T6 |
| `src/hooks/use-settings.ts` | T16 |
| `src/common/hooks/use-commands/model-profile-commands.ts` | T7 |
| `docs/keyboard-shortcuts.md` | T7 |
| `src/features/agent/ui-model-profile-switcher/index.tsx` | T13 |
| `src/features/agent/ui-backend-preset-selector/index.tsx` | T13 |
| `src/features/agent/utils-backend-model-selection/index.ts` | T13 |
| `src/features/agent/ui-backend-selector/index.tsx` | T16 |
| `src/features/agent/ui-model-selector/index.tsx` | T16 |
| `src/features/settings/ui-model-profiles-settings/index.tsx` | T14 |
| `src/features/settings/ui-model-presets-settings/index.tsx` | T14 |
| `src/features/settings/ui-general-settings/index.tsx` | T14 |
| `src/features/settings/ui-rate-limit-swap-settings/index.tsx` | T14 |
| `src/features/settings/ui-settings-overlay/index.tsx` | T14 |
| `src/features/project/ui-project-model-policy/index.tsx` | T15 |
| `electron/services/model-profile-service.ts` | T0 (w0) → T5 (w1) → T20 (w3) |
| `electron/services/ai-skill-slot-resolver.ts` | T10 (w2) → T20 (w3) |
| `src/features/agent/ui-rate-limit-banner/index.tsx` | T21 |
| `src/hooks/use-rate-limit-fallback.ts` | T21 |
| `src/features/project/ui-project-settings/index.tsx` | T15 |
| `AGENTS.md`, design doc | T17 |
| `src/routes/__root.tsx` | T22 |
| `src/features/task/ui-task-panel/index.tsx` | T22 |
| `src/features/new-task/ui-new-task-overlay/index.tsx` | T22 |
| `src/features/task/ui-task-panel/add-step-dialog.tsx` | T22 |

No file has two owners in the same wave.

## Do not parallelize

- **Migration 092** — T0 only, wave 0, alone. Never run alongside another migration author.
- **`pnpm install`** — preflight only (lockfile).
- **`pnpm lint --fix`** — repo-wide formatter; run at wave barriers, never inside a task.
- **`pnpm ts-check`** — whole-program; wave barriers only.

## Risk list

1. **T2 legacy migration** — most likely to silently lose a user's settings. Fallback: keep
   the old keys in the DB (T16 deletes the *code*, not the rows) so a bad migration can be
   re-run after a fix. Test idempotency hard.
2. **T8 rate-limit rewrite** — `rate-limit-swap-service` has no existing tests, and the
   enforce-vs-fallback interaction is the subtlest rule in the design. Fallback: land the
   profile switch first and keep the old per-entry chain behind a flag if tests get hairy.
3. **T14 settings surgery** — deletes five sections from a 2000+ line file that other tasks
   read. Fallback: if `ui-general-settings` proves too tangled, leave the sections rendering
   read-only with a "moved to Profiles" note and delete in a follow-up.
4. **T7 shortcut collision** — `cmd+1..9` is very likely already bound to project/tab
   navigation. The task is instructed to check first and fall back to `cmd+shift+1..9`.

## Out of scope

- Cross-backend model *equivalence tiers* (sonnet → gpt-5 mapping). Profiles make this
  unnecessary; do not build a tier table.
- Per-project profile *definitions*. Projects pin an existing global profile, never own one.
- Restarting running steps on a profile switch — explicitly rejected in design §4.
- Changelog entries (AGENTS.md forbids without explicit request).

## Coverage check

| Design section | Tasks |
| --- | --- |
| §2 Preset / Role / Profile | T0, T1, T6, T14 |
| §2 Skill slots and roles | T10, T20 |
| §2 Project policy + repo file | T0, T3, T4, T5, T15 |
| §3 Resolution chain | T1, T5 |
| §4 Rate-limit fallback | T8, T12, T14, T21 |
| §5 Switching UX | T7, T13, T22 |
| §6 Data model + migration | T0, T2, T3, T18 |
| §7 Cleanup / duplicate registries | T16 |
| §8 Risks (unknown roles, repo trust, enforce conflict) | T1, T4, T8 |
| §9 Decisions log | T17 |

## Discovered

- **`ReviewSubmitOverlay` (`src/features/agent/ui-review-comments/review-submit-overlay.tsx`)
  has zero call sites** anywhere in the repo — dead code. T24 migrated it to the resolver
  anyway rather than leave an inconsistent file, but it should probably be deleted.
- **T16's migration-093 justification cited false precedent.** It claimed "ample precedent in
  this repo (026, 037, 046, 056, 064, 089)" for `ALTER TABLE ... DROP COLUMN`; in fact its own
  file is the only migration using it. The *reasoning* was still sound (recreating `projects`
  risks cascading away tasks), so the approach was kept and a test was added to prove children
  survive rather than trusting the claim.

- **`vitest.config.ts` uses an explicit per-folder include allowlist.** Test files in new
  component folders are collected by nothing and silently never run — T13 and T15 both hit
  this. Four folders were added by the orchestrator (`63fbccea`). Any future component folder
  must be registered there or its tests are dead weight.

- **Pre-existing dead code:** `electron/services/agent-service.ts` hardcodes
  `const swapModel = undefined` / `const swapThinkingEffort = undefined` (lines ~1454-1455).
  The per-session swap override has therefore never actually been reachable, before or after
  this work. Confirmed present on the pre-change tree. Not fixed here — T21 wires the real
  reaction at the profile level instead.
- **`rate-limit-swap-service.test.ts` already existed** contrary to the plan's claim that it
  had no tests; T8 replaced the old chain-model suite rather than creating the first one.
  Same for `completion-service.test.ts`, which T11 did genuinely create.
- **`list-shortcuts.mjs --check` exits non-zero on a clean tree** — verified identical
  before and after wave 1. Pre-existing known collisions documented in
  `docs/keyboard-shortcuts.md`; not introduced here.

- **Pre-existing, unrelated:** `electron/database/migrations/078_pr_workspace_support.test.ts`
  > "rolls back table recreation failures and restores FK enforcement" fails with
  `TypeError: client.setAuthorizer is not a function` — the installed better-sqlite3 does not
  expose `setAuthorizer`. Red on a clean tree at the start of this work; not caused by any
  task here. Known-red baseline for every wave barrier.

