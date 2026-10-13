# Per-project work item display configuration — Implementation plan

Date: 2026-09-19
Design: `docs/plans/2026-09-19-per-project-work-item-field-config-design.md`

## Preflight

```sh
pnpm install
pnpm test          # vitest run
pnpm ts-check      # tsc --noEmit -p tsconfig.web.json && tsc --noEmit -p tsconfig.node.json
pnpm lint --fix    # oxlint --fix
pnpm lint          # oxlint
```

Scoped test command: `pnpm vitest run <path-or-pattern>`.

### The one deliberate red-typecheck window

T0 flips `AzureDevOpsWorkItem.fields` from a typed 17-key object to
`Record<AzureFieldRefName, WorkItemFieldValue>`. `tsc` is whole-program, so
**`pnpm ts-check` is red from the moment T0 lands until the wave-1 barrier**,
when the last codemod task completes. This is expected, not a failure.

Consequently no task in wave 1 may use bare `pnpm ts-check` as its `Verify`.
Each instead uses a **file-scoped typecheck** that ignores sibling noise:

```sh
pnpm ts-check 2>&1 | grep -F '<owned-file-path>' ; test $? -eq 1
```

(`grep` exiting 1 = no lines matched = no errors in *this* file.) Plus the
task's own vitest run where tests exist.

## Wave table

| Wave | Tasks | Max concurrency |
| --- | --- | --- |
| 0 | T0 | 1 (serial) |
| 1 | T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 T11 T12 | 12 |
| 2 | T13 T14 | 2 |
| 3 | T16 T18 | 2 |
| 4 | T15 T19 | 2 |
| 5 | T17 | 1 (serial) |

Revised 2026-09-19: T15 moved to wave 4 and rescoped; T18 (per-surface
defaults, a contract change) inserted in wave 3; T19 (board card elements)
split out of the old T15. See `## Revisions`.

**Critical path:** T0 → T5 → T13 → T15 → T17 (5 deep, 18 tasks total).
The only forced serialization is T0 (contracts) and T17 (full-suite +
lint + ts-check sweep). T13 waits on T5 because it consumes
`useWorkItemFieldMetadataMap`; T15 waits on T13 because it swaps the new
renderer into three panels T6/T7/T8 own in wave 1.

```
 WAVE 0   T0 contracts ── flips the field shape, lands every signature
             │                      (ts-check goes red here, by design)
             ▼
 WAVE 1   ┌──────────────── 12 agents, pairwise-disjoint Owns ─────────────────┐
          │ T1 service   T2 main-svcs  T3 repo    T4 shared-tests  T5 hooks    │
          │ T6 preview   T7 feed-modal T8 board   T9 workspace     T10 misc-ui │
          │ T11 new-task T12 cache-bump                                        │
          └────────────────────────────────────────────────────────────────────┘
             │   ◄── BARRIER: `pnpm ts-check` must go GREEN here. First
             ▼        moment the whole program compiles again.
 WAVE 2   T13 <WorkItemFieldRows>  ∥  T14 <WorkItemDisplaySettings>
             │
             ▼
 WAVE 3   T16 mount settings pane  ∥  T18 per-surface defaults (contract)
             │
             ▼
 WAVE 4   T15 detail panels + hosted editors  ∥  T19 board card elements
             │
             ▼
 WAVE 5   T17 full sweep: pnpm test, ts-check, lint
```

**Critical path (revised):** T0 → T5 → T13 → T18 → T15 → T17.

## Tasks

- [x] **T0 — Contracts: types, accessors, migration, IPC surface**
  - Wave: 0
  - Depends on: —
  - Owns: `shared/work-item-field-types.ts`, `shared/work-item-display-config-types.ts`, `electron/database/migrations/091_project_work_item_display_config.ts`, `electron/database/migrator.ts`, `electron/database/schema.ts`, `shared/types.ts`, `electron/preload.ts`, `electron/ipc/handlers.ts`, `src/lib/api.ts`, `src/features/work-item/ui-work-item-field-rows/index.tsx`, `src/features/project/ui-work-item-display-settings/index.tsx`, `electron/services/azure-devops-service.ts`
  - Reads: the design's `## Interfaces` section (transcribe it verbatim), `shared/work-item-title-parser-types.ts`, `electron/database/migrations/075_project_work_item_title_parser.ts`
  - Do:
    1. `shared/work-item-field-types.ts` — **fully implement** (it is tiny and everything depends on it): all `FIELD_*` refName constants, `CORE_FIELD_REFNAMES`, `EDITABLE_FIELD_REFNAMES`, `CORE_FIELD_METADATA`, `normalizeFieldValue`, the generic accessors (`getFieldValue`/`getStringField`/`getNumberField`/`getBooleanField`/`getIdentityField`) and every named accessor (`getTitle`…`getIterationPath`). `getTags` splits on `;` and trims, dropping empties. Every accessor except `getTitle`/`getState`/`getWorkItemType` returns `T | undefined` — deliberate, see design Risk 1.
    2. `shared/work-item-display-config-types.ts` — **fully implement**: the bound constants, all types, `DEFAULT_WORK_ITEM_DISPLAY_CONFIG` (must equal today's layout — read `ui-work-item-preview` to transcribe the current row and tab order), `isWorkItemDisplayConfig` (enforce bounds + `/^[A-Za-z0-9_.]{1,200}$/` on refNames), `resolveDetailLayout`, `resolveBoardRows`, `collectExtraFieldRefNames`, `hashRefNames`. No tests here — T4 writes them.
    3. In `electron/services/azure-devops-service.ts` change **only** the `AzureDevOpsWorkItem.fields` declaration to `Record<AzureFieldRefName, WorkItemFieldValue>` and add the `extraFieldRefNames?` param + `getWorkItemTypeFields` signature with a `throw new Error('not implemented')` body. Leave all logic to T1. *(This is the one file T0 touches that another wave-1 task owns — T0 is serial and completes first, so there is no concurrent writer.)*
    4. Migration 091 + register in `migrator.ts` + `ProjectTable.workItemDisplayConfig: string | null` in `schema.ts` + the three `Project`/`NewProject`/`UpdateProject` fields in `shared/types.ts`.
    5. Preload + handler + `src/lib/api.ts` entries for `azureDevOps.getWorkItemTypeFields` and the `extraFieldRefNames` params. Handler body delegates to the service (which throws until T1).
    6. Empty skeletons exporting correctly-typed components for `ui-work-item-field-rows` and `ui-work-item-display-settings` (`return null`), so T13/T14 never create a file two tasks might race on.
  - Tests: none (T4 covers the shared modules).
  - Verify: `pnpm vitest run shared/ && pnpm lint shared/work-item-field-types.ts shared/work-item-display-config-types.ts`
  - Done when: both shared modules are complete and lint-clean; migration registered; every signature in the design's `## Interfaces` exists. `pnpm ts-check` **will** be red — only errors of the form "property X does not exist on type Record<…>" in the 23 consumer files are acceptable.

- [x] **T1 — AzureDevOpsService: refName mapping, fetch set, field metadata**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/services/azure-devops-service.ts`, `electron/services/azure-devops-service.test.ts`
  - Reads: `shared/work-item-field-types.ts`, design `## Data flow` + F3/F8
  - Do: replace the three hand-mapping sites (~984, ~1058, ~1159) with one
    `mapWorkItemFields(raw): Record<AzureFieldRefName, WorkItemFieldValue>` using
    `normalizeFieldValue`. Add `fields=` to `queryWorkItems`/`getWorkItemById`
    with `fetchSet = CORE_FIELD_REFNAMES ∪ extraFieldRefNames` (deduped, URL-encoded);
    `getWorkItemsByIds` passes the same set in the `workitemsbatch` body. Implement
    F3: on a non-2xx that names an unknown field, retry once with
    `CORE_FIELD_REFNAMES` only and set a `partialFieldFailure: AzureFieldRefName[]`
    on the result. Implement F8: if `fetchSet.length > 20`, route `queryWorkItems`
    through the existing `workitemsbatch` POST path. Implement `getWorkItemTypeFields`:
    call `/{project}/_apis/wit/workitemtypes/{type}/fields` per type, merge, dedupe
    by refName, union `validWorkItemTypes`, map Azure's `type` onto `WorkItemFieldType`.
    Update internal `fields.x` reads to accessors.
  - Tests: fetch set = core ∪ extras; extras duplicating core don't double; identity normalization; F3 retry returns items with `partialFieldFailure` set; F8 switches to batch above 20; `getWorkItemTypeFields` merges + dedupes + unions valid types.
  - Verify: `pnpm vitest run electron/services/azure-devops-service.test.ts`
  - Done when: tests green, no `any`, no `fields.` property access left in the file.

- [x] **T2 — Main-process consumers → accessors**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/services/feed-service.ts`, `electron/services/work-item-summary-source.ts`, `electron/services/work-item-summary-source.test.ts`, `electron/services/work-item-verification-note-service.ts`
  - Reads: `shared/work-item-field-types.ts`
  - Do: mechanical codemod of 20 sites to accessors. Watch the two shape changes: `fields.assignedTo` + `fields.assignedToUniqueName` → `getAssignee(item)?.displayName` / `?.uniqueName`; `fields.tags` string-splitting → `getTags(item)`. Update test fixtures to the refName record shape.
  - Tests: existing `work-item-summary-source.test.ts` must pass with refName fixtures; add one asserting an assignee with no `uniqueName` doesn't crash summary generation.
  - Verify: `pnpm vitest run electron/services/work-item-summary-source.test.ts && pnpm ts-check 2>&1 | grep -E 'feed-service|work-item-summary-source|work-item-verification-note' ; test $? -eq 1`
  - Done when: tests green, zero `fields.` reads in the four files.

- [x] **T3 — Project repository: persist the config**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/database/repositories/projects.ts`, `electron/database/repositories/projects.test.ts`
  - Reads: existing `parseWorkItemTitleParser` / `serializeWorkItemTitleParserUpdate` in the same file (copy the pattern exactly)
  - Do: add `parseWorkItemDisplayConfig`, `serializeWorkItemDisplayConfig`, `serializeWorkItemDisplayConfigUpdate`; wire into `rowToProject`, `create`, `update`. Corrupt JSON or a failed type guard ⇒ `console.warn` + `null` (design F1).
  - Tests: round-trip save/read; corrupt JSON ⇒ `null` + warn; guard-failing JSON (bad refName charset, over-cap rows) ⇒ `null`; `undefined` in `UpdateProject` leaves the column untouched; explicit `null` clears it.
  - Verify: `pnpm vitest run electron/database/repositories/projects.test.ts`
  - Done when: tests green.

- [x] **T4 — Shared module tests**
  - Wave: 1
  - Depends on: T0
  - Owns: `shared/work-item-field-types.test.ts`, `shared/work-item-display-config-types.test.ts`
  - Reads: the two T0 modules
  - Do: write the unit suite from the design's `## Test strategy`. If a T0 implementation is wrong, **fix it in the test's expectations only if the design says so** — otherwise report the mismatch in `## Discovered`; T0's file is not yours to edit.
  - Tests: `isWorkItemDisplayConfig` rejects wrong `version`, non-array `rows`, over-length refName, bad-charset refName, over-cap rows/overrides, unknown `tabs[].id`; `resolveDetailLayout` override-hit / override-miss / `null`; `collectExtraFieldRefNames` excludes core, dedupes across detail+board+overrides, excludes refNames hidden everywhere; `hashRefNames` order-independent and stable; `normalizeFieldValue` on identity/string/number/null; `getTags` on `''`, `'a'`, `'a; b'`, `'a;b'`; every accessor `undefined` on a missing key.
  - Verify: `pnpm vitest run shared/work-item-field-types.test.ts shared/work-item-display-config-types.test.ts`
  - Done when: tests green and every bullet above has a case.

- [x] **T5 — Hooks: metadata query + extras threading**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/hooks/use-work-items.ts`, `src/hooks/use-feed.test.ts`
  - Reads: `shared/work-item-display-config-types.ts`, `src/hooks/use-projects.ts`
  - Also: add `workItemDisplayConfig: null` to the `Project` fixture in `src/hooks/use-feed.test.ts` (T0 made the field required).
  - Do: add `useWorkItemTypeFields` (key `['work-item-type-fields', providerId, azureProjectId]`, `staleTime: 60*60*1000`) and `useWorkItemFieldMetadataMap` (memoized, `CORE_FIELD_METADATA` merged under the Azure values). Add `extraFieldRefNames` to `useWorkItems`/`useWorkItemById`/`useWorkItemsByIds`, appending `hashRefNames(extras)` to each query key. Codemod the 10 local `fields.` sites — **including the optimistic-update snapshots** in `useUpdateWorkItemField`/`useUpdateWorkItemBoardColumn`, which write into the field object and must now write refName keys.
  - Tests: none co-located today; covered indirectly by T13/T14 component tests.
  - Verify: `pnpm ts-check 2>&1 | grep -F 'src/hooks/use-work-items.ts' ; test $? -eq 1`
  - Done when: file-scoped typecheck clean; no new object/array identity returned per call from `useWorkItemFieldMetadataMap` (React 19 rule — memoize).

- [x] **T6 — Preview panel → accessors** (52 sites, the largest)
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/work-item/ui-work-item-preview/index.tsx`, `src/features/work-item/ui-work-item-preview/query-policy.ts`
  - Reads: `shared/work-item-field-types.ts`
  - Do: codemod only — the layout stays hardcoded in this wave; T15 swaps in the shared renderer. Preserve the existing `hasContent` logic and the type-is-Bug guard on repro steps.
  - Tests: none co-located.
  - Verify: `pnpm ts-check 2>&1 | grep -F 'ui-work-item-preview' ; test $? -eq 1`
  - Done when: zero `fields.` reads; inline editing still targets refNames via `updateWorkItemField`.

- [x] **T7 — Feed work item modal → accessors** (41 sites)
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/feed/ui-work-item-details/index.tsx`
  - Reads: `shared/work-item-field-types.ts`
  - Do: codemod only, same rules as T6.
  - Tests: none co-located.
  - Verify: `pnpm ts-check 2>&1 | grep -F 'ui-work-item-details' ; test $? -eq 1`
  - Done when: zero `fields.` reads.

- [x] **T8 — Board → accessors** (42 sites)
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/work-item/ui-work-item-board/index.tsx`, `src/features/work-item/ui-work-item-board/card-board-item.tsx`, `src/features/work-item/ui-work-item-board/card-readable.tsx`, `src/features/work-item/ui-work-item-board/utils.ts`, `src/features/work-item/ui-work-item-board-column-editor/index.tsx`
  - Reads: `shared/work-item-field-types.ts`
  - Do: codemod. `utils.ts` sorts by `getStackRank(item) ?? Number.MAX_SAFE_INTEGER` — preserve today's undefined-ordering exactly; a sort change here silently reshuffles every board.
  - Tests: add `src/features/work-item/ui-work-item-board/utils.test.ts` pinning stack-rank sort order including items with no stack rank.
  - Verify: `pnpm vitest run src/features/work-item/ui-work-item-board/utils.test.ts`
  - Done when: tests green, zero `fields.` reads.

- [x] **T9 — Workspace → accessors**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/work-item/ui-work-item-workspace/index.tsx`, `src/features/work-item/ui-work-item-workspace/build-board-model.ts`, `src/features/work-item/ui-work-item-workspace/board-split-pane.tsx`, `src/features/work-item/ui-work-item-workspace/color-settings-menu.tsx`
  - Reads: `shared/work-item-field-types.ts`
  - Do: codemod 18 sites. `build-board-model.ts` filters on type/tags/state/assignee — tag filtering moves to `getTags(item)` array membership instead of substring matching on the raw string. **Verify this is not a behaviour change**: today's substring match would match `"backend"` inside `"backend-infra"`; exact array membership will not. Prefer exact membership (the correct behaviour) and note the change in `## Discovered`.
  - Tests: add `src/features/work-item/ui-work-item-workspace/build-board-model.test.ts` covering filter-by-tag (exact match, not substring), by state, by type, by assignee.
  - Verify: `pnpm vitest run src/features/work-item/ui-work-item-workspace/build-board-model.test.ts`
  - Done when: tests green.

- [x] **T10 — Remaining renderer consumers → accessors**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/work-item/ui-work-item-list/index.tsx`, `src/features/pull-request/ui-pr-work-items/index.tsx`, `src/features/agent/ui-work-items-browser/index.tsx`, `src/features/task/ui-task-panel/index.tsx`, `src/features/work-activity/ui-work-activity-overlay/index.tsx`
  - Reads: `shared/work-item-field-types.ts`
  - Do: codemod 28 sites. `ui-work-item-list` compares assignee to the current user — that comparison must use `getAssignee(item)?.uniqueName`, not the display name.
  - Tests: none co-located.
  - Verify: `pnpm ts-check 2>&1 | grep -E 'ui-work-item-list|ui-pr-work-items|ui-work-items-browser|ui-task-panel|ui-work-activity-overlay' ; test $? -eq 1`
  - Done when: zero `fields.` reads across the five files.

- [x] **T11 — Task-creation consumers → accessors**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/new-task/ui-new-task-overlay/index.tsx`, `src/features/new-task/ui-prompt-composer/index.tsx`, `src/routes/projects/$projectId/tasks/new.tsx`
  - Reads: `shared/work-item-field-types.ts`
  - Do: codemod 12 sites. These build agent prompts from title/description/acceptance criteria — the generated prompt text must be byte-identical to today. This is the highest-consequence codemod: a regression here silently degrades every task prompt.
  - Tests: none co-located; if a prompt-building helper is extractable without restructuring, extract and pin it with a snapshot test. If not, say so in `## Discovered`.
  - Verify: `pnpm ts-check 2>&1 | grep -E 'ui-new-task-overlay|ui-prompt-composer|tasks/new' ; test $? -eq 1`
  - Done when: zero `fields.` reads; prompt assembly logic unchanged other than the accessor calls.

- [x] **T12 — Renderer cache version bump** (design Risk 2)
  - Wave: 1
  - Depends on: T0
  - Owns: `src/cache/cache-types.ts`, `src/cache/cache-store.ts`, `src/cache/cache-store.test.ts`, `src/cache/cache-gc.test.ts`, `src/cache/domains/projects.test.ts`
  - Reads: `src/cache/cache-gc.ts`, `src/cache/README.md`
  - Also: add `workItemDisplayConfig: null` to the `Project` fixtures in `cache-gc.test.ts`, `cache-store.test.ts` and `domains/projects.test.ts` (T0 made the field required).
  - Do: `cache-types.ts:44` persists `workItems: Record<string, unknown>`, so an upgrading user holds old-shape entries that would deserialize into a record with no refName keys and render every field blank. Bump the persisted cache version key so old entries are discarded on load. If no version key exists, add one and discard the whole persisted blob when it mismatches.
  - Tests: a persisted payload at the old version is dropped and does not leak into the store; a payload at the current version still loads.
  - Verify: `pnpm vitest run src/cache/cache-store.test.ts`
  - Done when: tests green. **This is the task most likely to be silently skipped and only reproduces on upgrade, never on a fresh install.**

- [x] **T13 — `<WorkItemFieldRows>` renderer**
  - Wave: 2
  - Depends on: T0, T5
  - Owns: `src/features/work-item/ui-work-item-field-rows/index.tsx`, `src/features/work-item/ui-work-item-field-rows/index.test.tsx`, `src/features/work-item/ui-work-item-field-rows/render-field-value.tsx`
  - Reads: `shared/work-item-field-types.ts`, `shared/work-item-html.ts`, `src/hooks/use-work-items.ts`, `src/common/ui/`
  - Do: implement the signature T0 stubbed. Render each visible row by `metadata.type` per the design's renderer table (`string|plainText`→text, `html`→**sanitized** via the existing `shared/work-item-html.ts` path, never raw `dangerouslySetInnerHTML`, `integer|double`→number, `dateTime`→relative date via `src/lib/time.ts`, `boolean`→check, `identity`→avatar+name, `treePath`→last segment with full path on hover, `picklistString`→chip). Skip refNames absent from metadata (F2) and refNames whose `validWorkItemTypes` excludes the item's type (F7). On a value/metadata type mismatch fall back to `String(value)` and `console.warn` once per refName (F5). `editable` affects only `EDITABLE_FIELD_REFNAMES`. `variant: 'board'` renders compact, uncapped.
  - Tests: one case per `WorkItemFieldType`; F2 skip; F7 skip; F5 fallback; `editable` ignored for a non-editable refName; html value is sanitized.
  - Verify: `pnpm vitest run src/features/work-item/ui-work-item-field-rows`
  - Done when: tests green; no raw HTML injection path.

- [x] **T14 — `<WorkItemDisplaySettings>` pane**
  - Wave: 2
  - Depends on: T0, T5
  - Owns: `src/features/project/ui-work-item-display-settings/index.tsx`, `src/features/project/ui-work-item-display-settings/index.test.tsx`, `src/features/project/ui-work-item-display-settings/field-picker.tsx`, `src/features/project/ui-work-item-display-settings/type-override-list.tsx`
  - Reads: `src/features/project/ui-work-item-title-parser-settings/` (copy its pane conventions), `src/hooks/use-work-items.ts`
  - Do: implement the T0 stub. Field picker fed by `useWorkItemTypeFields`; drag-reorder + visibility toggles for `detail.rows` and `board.rows`; visibility toggles for `detail.tabs`; `Add override for type…` managing `overridesByType`, with types inheriting `detail` when absent. Mark configured refNames missing from metadata as **Unavailable** with a remove action (F2) — this pane is the *only* place that surfaces them. Show `only on: Bug, Issue` for type-restricted fields (F7). On metadata fetch failure show the existing provider-auth error state (F4). Calls `onChange` with a complete `WorkItemDisplayConfig`; does not save directly.
  - Tests: unavailable refName is marked and removable; reorder produces the expected `rows[]` order; add-then-remove a type override round-trips to the original config; metadata error renders the error state without crashing.
  - Verify: `pnpm vitest run src/features/project/ui-work-item-display-settings`
  - Done when: tests green.

- [x] **T15 — Wire the renderer into the two detail panels** *(revised 2026-09-19 — see `## Revisions`)*
  - Wave: 4
  - Depends on: T6, T7, T13, T18
  - Owns: `src/features/work-item/ui-work-item-preview/index.tsx`, `src/features/feed/ui-work-item-details/index.tsx`, `src/features/work-item/ui-work-item-field-rows/index.tsx`, `src/features/work-item/ui-work-item-field-rows/index.test.tsx`
  - Reads: `shared/work-item-display-config-types.ts`, `src/hooks/use-projects.ts`, `src/features/work-item/ui-work-item-field-rows/render-field-value.tsx`
  - Do:
    1. Extend `WorkItemFieldRows` with the `editors?` prop from the design
       revision (design decision 22): a partial map refName → render function.
       For a refName present in `editors`, render that node instead of the
       read-only value. `EDITABLE_FIELD_REFNAMES` still gates which refNames may
       be editable at all; custom fields stay read-only (decision 12).
    2. In each detail panel, resolve the layout with the **surface-aware**
       signature `resolveDetailLayout(config, getWorkItemType(item), surface)` —
       `'preview-editorial'` / `'preview-readonly'` / `'feed-modal'` — and render
       the metadata region through `<WorkItemFieldRows>`, passing the panel's
       **existing** editor components via `editors` so inline editing is
       preserved exactly (`MetadataDropdown`, `EditableMetadataValue`,
       `EditableStateValue`, `EditableStateBadge`, `EditableOwner`,
       `EditableIteration`, `WorkItemMetadataEditor`, `WorkItemBoardColumnEditor`,
       `WorkItemTagEditor`).
    3. Pass `extraFieldRefNames = collectExtraFieldRefNames(config)` into each
       panel's work-item query.
    4. Gate content tabs on `layout.tabs`, keeping the type-is-Bug guard on repro
       steps **in addition to** the config.
    5. The preview panel has TWO variants with different defaults (decision 24) —
       pass the correct surface for each.
    - **Scope discipline:** metadata-row region only. Tab chrome, comments,
      history and test-case tabs stay structurally as they are.
  - Tests: extend T13's suite (do not weaken its 18 existing tests): `editors`
    renders the injected node and not the read-only value; `editors` is ignored
    for a non-editable refName; per surface, a `null` config renders exactly that
    surface's default row set and order; a config hiding a row removes exactly
    that row; once a config exists both detail surfaces resolve the same rows.
  - Verify: `pnpm vitest run src/features/work-item/ui-work-item-field-rows`
  - Done when: tests green; `null` config is byte-identical to pre-change on
    both preview variants and the feed modal; every inline editor still works.

- [x] **T18 — Per-surface default layouts** *(added 2026-09-19 — design decisions 23/24)*
  - Wave: 3
  - Depends on: T13, T14
  - Owns: `shared/work-item-display-config-types.ts`, `shared/work-item-display-config-types.test.ts`
  - Reads: `src/features/work-item/ui-work-item-preview/index.tsx` (both variants), `src/features/feed/ui-work-item-details/index.tsx`, `src/features/work-item/ui-work-item-board/card-board-item.tsx`
  - Do: add `WorkItemDisplaySurface`, the three `DEFAULT_DETAIL_LAYOUT_*`
    constants, and the `surface` parameter on `resolveDetailLayout` exactly as
    written in the design revision's interface block. Each default must be
    transcribed from that surface's CURRENT hardcoded layout — read the source,
    do not guess. `resolveDetailLayout` returns the surface default when
    `config` is `null`, and otherwise resolves `config.detail` (plus per-type
    override) identically for every surface.
  - Tests: each surface's default matches the documented field list and order;
    `null` config + surface returns that surface's default; a non-null config
    returns the same layout for all three surfaces; per-type override still wins;
    the existing `Object.hasOwn` prototype-safety case still passes.
  - Verify: `pnpm vitest run shared/work-item-display-config-types.test.ts`
  - Done when: tests green. **This is a contract change — it must land before T15 and T19 start.**

- [x] **T19 — Board card element visibility and order** *(added 2026-09-19 — design decision 25)*
  - Wave: 4
  - Depends on: T8, T18
  - Owns: `src/features/work-item/ui-work-item-board/card-board-item.tsx`, `src/features/work-item/ui-work-item-board/card-board-item.test.tsx`
  - Reads: `shared/work-item-display-config-types.ts`, `src/hooks/use-projects.ts`
  - Do: board cards are **not** label/value rows (design decision 25). Drive the
    card's existing chrome from `resolveBoardRows(config)`: each configured
    refName maps to the element that renders it today — `System.AssignedTo` →
    the header avatar, `Microsoft.VSTS.Common.Priority` → the priority badge,
    `System.IterationPath` → the out-of-sprint badge, `System.Tags` → the tag
    chips. A refName hidden in the config hides its element; the configured order
    controls element order where the layout allows it. Do **not** use
    `<WorkItemFieldRows>` here. Leave the separate `WorkItemBoardReadableCard`
    path alone unless it shares the same element block.
  - Tests: a `null` config renders exactly today's card (all existing elements,
    existing gating such as `colorSettings.showPriority` and out-of-sprint-only
    iteration preserved); hiding `System.Tags` removes the chips and nothing
    else; an extra custom refName in `board.rows` does not crash the card.
  - Verify: `pnpm vitest run src/features/work-item/ui-work-item-board`
  - Done when: tests green; `null` config is byte-identical to pre-change.

- [x] **T20 — Plumb the config to board cards** *(added 2026-09-19 — reported by T19)*
  - Wave: 5
  - Depends on: T19
  - Owns: `src/features/work-item/ui-work-item-workspace/index.tsx`, `src/features/work-item/ui-work-item-board/index.tsx`, `src/features/work-item/ui-work-item-board/card-readable.tsx`, `src/features/work-item/ui-work-item-board/card-readable.test.tsx`
  - Reads: `src/features/work-item/ui-work-item-board/card-board-item.tsx`, `shared/work-item-display-config-types.ts`
  - Do: T19 gave `WorkItemBoardCard` a `displayConfig` prop but nothing supplies
    it, so the board is still hardcoded at runtime. Forward
    `project.workItemDisplayConfig` from the workspace (which already passes
    `project.workItemTitleParser` the same way) through
    `ui-work-item-board/index.tsx` to the card. Then gate the priority badge and
    tag chips rendered *inside* `card-readable.tsx` on the same resolved rows —
    the only live `<WorkItemBoard>` call site uses `variant="editorial"`, i.e.
    the `WorkItemBoardReadableCard` path, so without this the feature is
    invisible on the board in practice.
  - Tests: `card-readable.test.tsx` — a `null` config renders exactly today's
    readable card; hiding `Microsoft.VSTS.Common.Priority` removes the badge and
    nothing else; hiding `System.Tags` removes the chips and nothing else.
  - Verify: `pnpm vitest run src/features/work-item/ui-work-item-board src/features/work-item/ui-work-item-workspace`
  - Done when: tests green; `null` config byte-identical; the board visibly
    honours the config end to end.

- [x] **T16 — Mount the settings pane in Integrations**
  - Wave: 3
  - Depends on: T14
  - Owns: `src/features/project/ui-project-settings/index.tsx`, `src/features/project/ui-project-settings/utils-project-settings-save-data.ts`
  - Reads: `src/features/project/ui-work-item-display-settings/index.tsx`
  - Do: render `<WorkItemDisplaySettings>` in the `integrations` case (currently lines ~1843–1862, beside `<WorkItemsLink>`), wired through `markFieldDirty('workItemDisplayConfig')` and the existing versioned save queue. Add `workItemDisplayConfig` to `getProjectSettingsSaveData`.
  - Tests: extend the existing save-data test if present; otherwise add one asserting a changed config lands in the `UpdateProject` payload and an unchanged one does not.
  - Verify: `pnpm vitest run src/features/project/ui-project-settings`
  - Done when: tests green; the `ProjectSettingsMenuItem` `assertNever` switch still compiles.

- [x] **T17 — Full sweep**
  - Depends on: all
  - Owns: — (fixes only; any file, serially)
  - Reads: everything
  - Wave: 5
  - Do: `pnpm install`, `pnpm test`, `pnpm lint --fix`, `pnpm ts-check`, `pnpm lint`. Fix fallout. Confirm zero remaining `workItem.fields.<name>` property reads repo-wide: `grep -rnE "fields\.(title|workItemType|teamProject|state|assignedTo|assignedToUniqueName|description|acceptanceCriteria|reproSteps|changedDate|boardColumn|boardColumnDone|tags|priority|stackRank|storyPoints|iterationPath)\b" src electron shared --include='*.ts' --include='*.tsx'` must return nothing.
  - Tests: the whole suite.
  - Verify: `pnpm test && pnpm ts-check && pnpm lint`
  - Done when: all three green and the grep is empty.

## File ownership check

| File | Owner (wave) |
| --- | --- |
| `shared/work-item-field-types.ts` | T0 (0) |
| `shared/work-item-display-config-types.ts` | T0 (0) |
| `shared/work-item-field-types.test.ts` | T4 (1) |
| `shared/work-item-display-config-types.test.ts` | T4 (1) |
| `shared/types.ts` | T0 (0) |
| `electron/database/migrations/091_*.ts` | T0 (0) |
| `electron/database/migrator.ts` | T0 (0) |
| `electron/database/schema.ts` | T0 (0) |
| `electron/database/repositories/projects.ts` | T3 (1) |
| `electron/database/repositories/projects.test.ts` | T3 (1) |
| `electron/preload.ts` | T0 (0) |
| `electron/ipc/handlers.ts` | T0 (0) |
| `src/lib/api.ts` | T0 (0) |
| `electron/services/azure-devops-service.ts` | T0 (0, signature only) → T1 (1, logic) |
| `electron/services/azure-devops-service.test.ts` | T1 (1) |
| `electron/services/feed-service.ts` | T2 (1) |
| `electron/services/work-item-summary-source.ts` (+test) | T2 (1) |
| `electron/services/work-item-verification-note-service.ts` | T2 (1) |
| `src/hooks/use-work-items.ts` | T5 (1) |
| `src/features/work-item/ui-work-item-preview/*` | T6 (1) → T15 (3) |
| `src/features/feed/ui-work-item-details/index.tsx` | T7 (1) → T15 (3) |
| `src/features/work-item/ui-work-item-board/card-board-item.tsx` | T8 (1) → T15 (3) |
| `src/features/work-item/ui-work-item-board/{index,card-readable,utils}.*` | T8 (1) |
| `src/features/work-item/ui-work-item-board-column-editor/index.tsx` | T8 (1) |
| `src/features/work-item/ui-work-item-workspace/*` | T9 (1) |
| `src/features/work-item/ui-work-item-list/index.tsx` | T10 (1) |
| `src/features/pull-request/ui-pr-work-items/index.tsx` | T10 (1) |
| `src/features/agent/ui-work-items-browser/index.tsx` | T10 (1) |
| `src/features/task/ui-task-panel/index.tsx` | T10 (1) |
| `src/features/work-activity/ui-work-activity-overlay/index.tsx` | T10 (1) |
| `src/features/new-task/ui-new-task-overlay/index.tsx` | T11 (1) |
| `src/features/new-task/ui-prompt-composer/index.tsx` | T11 (1) |
| `src/routes/projects/$projectId/tasks/new.tsx` | T11 (1) |
| `src/cache/cache-types.ts`, `cache-store.ts`, `cache-store.test.ts` | T12 (1) |
| `src/features/work-item/ui-work-item-field-rows/*` | T0 (0, skeleton) → T13 (2) |
| `src/features/project/ui-work-item-display-settings/*` | T0 (0, skeleton) → T14 (2) |
| `src/features/project/ui-project-settings/index.tsx` | T16 (3) |
| `src/features/project/ui-project-settings/utils-project-settings-save-data.ts` | T16 (3) |

Three files are written in two different waves (`azure-devops-service.ts`,
the three T15 panels, the two T0 skeletons). That is legal — the disjointness
rule is *within* a wave — and is what lets T0 pre-register every shared file so
no wave-1 task ever touches a conflict magnet.

## Do not parallelize

- **T0.** Everything depends on its contracts; it is wave 0 alone.
- **The migration.** Only T0 writes `migrations/` and `migrator.ts`. No other
  task adds a migration; if one seems necessary, stop and revise the design.
- **`pnpm install` / lockfile.** T17 only.
- **Repo-wide `pnpm lint --fix`.** T17 only — a wave-1 agent running it would
  rewrite files owned by 11 siblings.
- **`pnpm ts-check` as a gate.** Wave barriers only, never inside a wave-1 task
  (see the red-window note in Preflight).

## Risk list

1. **T12 (cache bump)** — the failure only reproduces on *upgrade*. A fresh
   `pnpm dev` will look perfect while every upgrading user sees blank fields.
   Fallback: if no version key exists in the persisted store, clear the
   `workItems` slice unconditionally on this release.
2. **T11 (task-prompt consumers)** — silently degrades every generated agent
   prompt if `description`/`acceptanceCriteria` come back `undefined` instead of
   `''`. Fallback: pin prompt assembly with a snapshot test before the codemod;
   if the helper can't be extracted, diff a generated prompt by hand.
3. **T1 (service)** — adding `fields=` changes what Azure returns. If any core
   refName is misspelled, that field goes `undefined` app-wide with no error.
   Fallback: assert the full `CORE_FIELD_REFNAMES` round-trips against a
   recorded fixture before trusting the live path.
4. **T9 (tag filtering)** — substring → exact membership is a real behaviour
   change. Intentional and correct, but user-visible on boards filtered by a
   tag prefix. Record it in `## Discovered`.

## Out of scope

Copied from the design — do not drift:

- Editing custom fields inline (picklists, allowed values, validation).
- Per-field custom labels; per-field editability toggles.
- Configuring work item **list** rows (`ui-work-item-list`).
- Per-type overrides for board cards.
- Sharing/exporting a config between projects; org-level defaults.
- Configuring PR-side or non-Azure providers.
- Any preview/modal convergence beyond the metadata-row region.

## Coverage check

| Design section | Tasks |
| --- | --- |
| Data model / migrations | T0, T3 |
| Interfaces — `work-item-field-types` | T0, T4 |
| Interfaces — `work-item-display-config-types` | T0, T4 |
| Interfaces — `AzureDevOpsWorkItem` shape change | T0, T1, T2, T5–T12 |
| Interfaces — IPC / preload / api.ts | T0, T1 |
| Interfaces — hooks | T5 |
| Interfaces — `WorkItemFieldRows` | T0, T13, T15 |
| Interfaces — `WorkItemDisplaySettings` | T0, T14, T16 |
| Architecture — settings write path | T14, T16, T3 |
| Architecture — read path / fetch set | T1, T5 |
| Data flow — happy path | T15 |
| F1 corrupt config | T3 |
| F2 unknown refName | T13, T14 |
| F3 Azure rejects extras | T1 |
| F4 metadata fetch fails | T13, T14 |
| F5 value/type mismatch | T13 |
| F6 settings save race | T16 (existing queue) |
| F7 type-restricted field | T13, T14 |
| F8 oversized fetch set | T1 |
| State table | T5, T14, T16 |
| Security — sanitization, refName validation, bounds | T0 (guard), T13 (sanitize), T1 (encode) |
| Test strategy — unit | T4, T3 |
| Test strategy — integration | T1 |
| Test strategy — component | T13, T14, T15 |
| Test strategy — manual | T17 + handoff notes |
| Rollout — cache version bump | T12 |
| Rollout — ordering | wave structure |

## Discovered

### Pre-existing, not fixed here

- **`electron/database/migrations/078_pr_workspace_support.test.ts` fails on
  `main`** — `TypeError: client.setAuthorizer is not a function`. better-sqlite3
  API drift, unrelated to this work. Present in the preflight baseline and still
  the only red test at the wave-1 barrier.
- **`toVerificationWorkItem` in `work-item-verification-note-service.ts` has
  zero callers** repo-wide (found by T2). Exported but dead. Retyped rather than
  deleted — deletion is out of scope.
- **`AzureDevOpsUser` (`src/lib/api.ts:366`) has no `uniqueName`** (found by
  T10). Identity comparisons must fall back to `emailAddress`, which holds the
  Azure UPN. Worth adding the field properly at some point.
- **`pnpm lint --fix` is repo-wide with no path filter**, so it cannot be run
  safely while parallel agents are editing. Not a blocker, but it means the
  formatter can only run at wave barriers.

### Fixed here, but outside the planned tasks

- **`src/lib/api.ts` declared a SECOND `AzureDevOpsWorkItem`** with the old
  camelCase field object. T0 changed only the service-side declaration; every
  renderer consumer imports the `api.ts` one. Found by T5 when its file-scoped
  typecheck would not clear. Fixed by the orchestrator before dispatching
  batch B — had it been missed, all six batch-B tasks would have coded against
  the wrong type.
- **`resolveDetailLayout` was prototype-chain-unsafe** (found by T4, which is
  the adversarial test task and did exactly its job). `config.overridesByType[type] ?? config.detail`
  on a `JSON.parse`'d object means a work item type named `toString`,
  `constructor` or `valueOf` resolves to the inherited `Object.prototype`
  member — a function, not a layout — and the renderer then calls
  `layout.rows.map` on it. Azure work item type names are user-authored, so
  this was reachable. Now uses `Object.hasOwn`.
- **Five test files carried stale old-shape fixtures that `ts-check` cannot
  catch.** Because `fields` is now a string-index `Record`, a fixture using
  `{title, state, workItemType}` still typechecks perfectly and simply misses
  every refName lookup at runtime. 16 tests failed at the barrier:
  `src/lib/build-board-model.test.ts`, `src/lib/work-item-board-utils.test.ts`,
  `src/lib/work-item-board-column-editor.test.ts`,
  `src/features/pull-request/ui-pr-work-items/search.test.ts`,
  `src/lib/prompt-composer-snippet-context.test.ts`. Plus two `Project`
  fixtures missing the new required column
  (`electron/services/pr-review-agent-service.test.ts`, and the four the plan
  reassigned to T5/T12). **This index-signature blindness is the single biggest
  hazard of the refName migration** and is why the full suite, not `ts-check`,
  is the real gate.

### Plan premises that turned out to be wrong

- **Design Risk 2 (renderer cache holds old-shape work items) does not exist.**
  T12 investigated and found `src/cache` has no persistence whatsoever — it is a
  plain in-memory Legend-State observable rebuilt from IPC on every launch, with
  no version key to bump. The suggested alternative location,
  `work_activity_events.workItemsJson`, stores `WorkActivityWorkItem`
  (`{id, providerId, azureOrgId, azureProjectId, title?, workItemType?}`), not
  `AzureDevOpsWorkItem`, so it holds no field objects either. **No migration or
  cache bump is needed.** T12 reduced to its fixture-repair "Also" clause.
- **The tag filter never did substring matching.** The plan (and design) claimed
  filtering matched `"backend"` inside `"backend-infra"` and that moving to
  `getTags()` membership would be a user-visible change. T9 found the existing
  `matchesAnyAzureWorkItemTag` already did split-trim-lowercase-Set membership.
  The codemod is semantically identical; **there is no behaviour change to
  announce.** T9 deliberately preserved the case-insensitive comparison, which
  matters because persisted filters and `tagOptions` can disagree on casing.
- **T8's `utils.test.ts` already existed** and was overwritten rather than
  created. Verified no coverage lost: all three original cases (rank ascending,
  unranked last preserving order, non-finite treated as unranked) are present in
  the new four-case file, which adds state-group workflow ordering.
- **The plan's site counts were slightly off** — T2 found 18 sites not 20, and
  the `assignedTo`/`tags` sites the plan predicted in main-process services do
  not exist there. T9 found 17 real sites not 18. T1 found **five** hand-mapping
  sites, not three (also `getRelatedTestCases` and `getPullRequestWorkItems`).

### Escaped the codemod — found at the T17 sweep

- **`work-item-summary-generation-service.ts:85` read `workItem.fields.teamProject`**
  and was never migrated, so it silently became `undefined`. The guard
  `getTeamProject(workItem) !== request.projectName` therefore always fired and
  **work item summary generation was completely broken**. Two compounding causes:
  1. The planning grep that produced the "23 files" list omitted `teamProject`
     from its alternation (the per-field *count* grep included it — the *file
     list* grep did not), so no task ever owned this file.
  2. `Record<string, WorkItemFieldValue>` turns a stale camelCase key into a
     silent `undefined` instead of a type error, so `ts-check` could not catch
     it — and the co-located test passed because **its fixture used the same
     stale key**, so production code and fixture were consistently wrong
     together. Only real Azure data would have exposed it.
  Fixed in T17 along with the fixture. A full-alternation re-sweep (including
  bracket-style `fields['title']` access) then confirmed zero remaining
  old-shape reads repo-wide.

  **Lesson for any future refName-style migration in this repo:** a
  string-index `Record` makes the compiler blind, so the discovery grep is the
  *only* real gate and must be exhaustive. Verify the key list against the type
  definition rather than writing it by hand.

### Open question for review

- **`fields=` and `$expand=relations` may be mutually exclusive on Azure's
  `workitems` GET / `workitemsbatch` POST** (`VS403474`). T1 could not verify
  against a live org and chose a conservative resolution: `fields=` is sent
  **only when the project has configured extra refNames**, so with no config the
  requests are byte-identical to today; `$expand` is always kept so relations
  never break; and the F3 retry drops `fields` entirely rather than falling back
  to core-only, which also recovers from the mutual-exclusion error if it is
  real. Needs confirmation against a real Azure org — if they coexist, `fields=`
  can be sent always for payload savings; if they 400, the retry becomes the
  primary path and should be made explicit.


## Revisions

### 2026-09-19 — per-surface defaults and hosted editors

**What changed in the design:** T15 stopped before writing code and reported
that the three target panels do not share a "metadata row region". Verified: there
are four distinct layouts (preview has two variants), `DEFAULT_WORK_ITEM_DISPLAY_CONFIG`
reproduced exactly one of them, and every detail field is rendered by a live
inline editor — so the original T15 would have deleted inline editing while also
changing the layout of unconfigured projects. The design gained decisions 22-25
and a revised interface block (`## Revision` in the design doc).

**Tasks added:** T18 (per-surface default layouts — a contract change, wave 3),
T19 (board card element visibility/order, wave 4).

**Tasks edited in place:** T15 — rescoped to the two detail panels only, moved to
wave 4, now also owns `ui-work-item-field-rows/` to add editor hosting, and
depends on T18. It was unchecked and uncommitted, so nothing referenced it.

**Tasks superseded:** none. T17 moves to wave 5.
