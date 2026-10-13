# Work-item status chips — Implementation plan

## Preflight

Run from the repository root before implementation:

```sh
pnpm install
pnpm test
pnpm lint --fix
pnpm ts-check
pnpm lint
```

The repository has no separate migration requirement for this feature: the
existing JSON project config is extended compatibly. The implementation
environment does not expose a subagent dispatch tool, so waves will be run
serially by the orchestrator in task order while preserving the ownership
boundaries below.

## Wave table

| Wave | Tasks | Max concurrency |
| --- | --- | ---: |
| 0 | T0 contracts and config validation | 1 |
| 1 | T1 feed enrichment, T2 Project Settings UI, T3 Feed card UI | 1 (serial fallback; file-disjoint by design) |
| 2 | T4 integration tests and verification hardening | 1 |

Critical path: T0 → T1/T2/T3 → T4. T1, T2, and T3 are logically independent
after T0, but are executed serially because no agent dispatch tool is
available. T4 follows all implementation tasks so it can test the seams.

## Tasks

- [x] **T0 — Add status-chip contracts and config validation**
  - Wave: 0
  - Depends on: none
  - Owns: `shared/work-item-display-config-types.ts`, `shared/feed-types.ts`, `shared/work-item-status-chip-types.ts`, `shared/work-item-status-chip-types.test.ts`
  - Reads: `shared/work-item-field-types.ts`, `shared/work-item-display-config-types.test.ts`, `shared/feed-types.ts`
  - Do: add the rule/tone/match types, optional `statusChips` config property,
    validation for rule IDs/refNames/values/labels/tones, and public helper
    signatures for extracting configured field refNames. Keep version-1 config
    compatibility and export a stable default empty rule list. Add red tests
    before implementation, then make the contract tests pass.
  - Tests: old configs without `statusChips`; malformed rules; invalid refNames;
    empty values/labels; invalid tones; enabled/disabled rule field extraction;
    core-field de-duplication.
  - Verify: `pnpm vitest run shared/work-item-status-chip-types.test.ts shared/work-item-display-config-types.test.ts`
  - Done when: all shared types compile, existing display-config tests remain
    green, and no migration is introduced.

- [x] **T1 — Enrich task feed items with status-chip matches**
  - Wave: 1
  - Depends on: T0
  - Owns: `electron/services/feed-service.ts`, `electron/services/feed-service.test.ts`, `shared/work-item-status-chip.ts`, `shared/work-item-status-chip.test.ts`
  - Reads: `shared/work-item-status-chip-types.ts`, `shared/work-item-field-types.ts`, `electron/services/azure-devops-service.ts`, `electron/services/feed-service.ts`
  - Do: implement exact trimmed/case-insensitive rule matching; resolve enabled
    custom refNames while excluding core fields; load project rules; pass
    custom fields to linked work-item fetches; enrich parent and child task
    items with aggregate matches; preserve type enrichment and omit only
    status chips on fetch/missing-field/partial-field failures. Add `dbg.feed`
    context for those failures and deduplicate provider/item requests where
    possible.
  - Tests: State, Board Column, and custom-field matches; rule-order
    aggregation; parent/child enrichment; custom refName request forwarding;
    missing fields; provider failure; partial custom-field failure; type
    enrichment remaining available.
  - Verify: `pnpm vitest run electron/services/feed-service.test.ts shared/work-item-status-chip.test.ts`
  - Done when: task and subtask FeedItems expose correct matches without
    renderer/provider calls and all scoped tests pass.

- [x] **T2 — Add Project Settings status-chip editor**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/project/ui-work-item-display-settings/index.tsx`, `src/features/project/ui-work-item-display-settings/status-chip-rules.tsx`, `src/features/project/ui-work-item-display-settings/status-chip-rules.test.tsx`, `src/features/project/ui-work-item-display-settings/index.test.tsx`
  - Reads: `shared/work-item-status-chip-types.ts`, `shared/work-item-display-config-types.ts`, `src/features/project/ui-work-item-display-settings/field-picker.tsx`, `src/common/ui/`
  - Do: add a compact repeatable rule editor to the existing Work item fields
    settings pane. Support add/edit/delete, enabled toggle, reorder, field
    refName, multiple values, label, and tone. Use fetched field metadata when
    available, retain built-in fields while metadata loads/fails, validate
    before emitting a complete config, and preserve all existing field-layout
    editing behavior.
  - Tests: render empty state; add/edit/remove/toggle/reorder; validation;
    preserving existing display layout; custom field selection; retry/error
    metadata state.
  - Verify: `pnpm vitest run src/features/project/ui-work-item-display-settings/index.test.tsx src/features/project/ui-work-item-display-settings/status-chip-rules.test.tsx`
  - Done when: Project Settings emits the existing update payload with valid
    `statusChips` and no unrelated settings regressions.

- [x] **T3 — Render linked work-item status chips in Feed List**
  - Wave: 1
  - Depends on: T0
  - Owns: `src/features/feed/ui-feed-list/feed-item-card.tsx`, `src/features/feed/ui-feed-list/feed-item-card.test.tsx`
  - Reads: `shared/feed-types.ts`, `shared/work-item-status-chip-types.ts`, existing `WorkItemChip` and tooltip patterns in `src/features/feed/ui-feed-list/feed-item-card.tsx`
  - Do: render aggregate status chips for parent task and subtask rows next to
    the existing linked-ID chips. Apply tone styling, accessible labels, and a
    tooltip listing matched IDs. Keep the chips informational and preserve
    existing ID-chip click/focus behavior. Render nothing for absent/empty
    matches.
  - Tests: parent chip; subtask chip; tone/aria/tooltip text; multiple chips;
    empty matches; existing ID-chip interaction unchanged.
  - Verify: `pnpm vitest run src/features/feed/ui-feed-list/feed-item-card.test.tsx`
  - Done when: the visual result is `[ #id ] [ status ]` above the task title,
    without changing Feed partitioning or work-item navigation.

- [x] **T4 — Verify feed/settings integration seams**
  - Wave: 2
  - Depends on: T1, T2, T3
  - Owns: `electron/services/feed-service.test.ts`, `src/features/project/ui-work-item-display-settings/index.test.tsx`, `src/features/feed/ui-feed-list/feed-item-card.test.tsx`
  - Reads: all changed implementation files
  - Do: add only seam/regression coverage that cannot be owned by T1–T3:
    project config changes invalidate/reload task feed data, linked IDs remain
    aligned with matches, and old projects render identically. Do not duplicate
    unit coverage. Resolve any integration mismatch found at the boundaries.
  - Tests: config update followed by feed reload; parent/child ID alignment;
    old config/no-rules behavior; mixed matched/unmatched linked IDs.
  - Verify: `pnpm test -- electron/services/feed-service.test.ts src/features/project/ui-work-item-display-settings/index.test.tsx src/features/feed/ui-feed-list/feed-item-card.test.tsx`
  - Done when: seam tests pass and the full repository checks pass at the final
    barrier.

## File ownership check

| File | Owner | Wave |
| --- | --- | ---: |
| `shared/work-item-display-config-types.ts` | T0 | 0 |
| `shared/feed-types.ts` | T0 | 0 |
| `shared/work-item-status-chip-types.ts` | T0 | 0 |
| `shared/work-item-status-chip-types.test.ts` | T0 | 0 |
| `electron/services/feed-service.ts` | T1 | 1 |
| `electron/services/feed-service.test.ts` | T1, then T4 | 1/2 |
| `shared/work-item-status-chip.ts` | T1 | 1 |
| `shared/work-item-status-chip.test.ts` | T1 | 1 |
| `src/features/project/ui-work-item-display-settings/index.tsx` | T2 | 1 |
| `src/features/project/ui-work-item-display-settings/status-chip-rules.tsx` | T2 | 1 |
| `src/features/project/ui-work-item-display-settings/status-chip-rules.test.tsx` | T2 | 1 |
| `src/features/project/ui-work-item-display-settings/index.test.tsx` | T2, then T4 | 1/2 |
| `src/features/feed/ui-feed-list/feed-item-card.tsx` | T3 | 1 |
| `src/features/feed/ui-feed-list/feed-item-card.test.tsx` | T3, then T4 | 1/2 |

T4 is intentionally the sole later owner of the three test files it extends;
it starts only after T1–T3 commits. No same-wave ownership overlaps exist.

## Do not parallelize

- `pnpm install` and native dependency rebuilds.
- Repository-wide lint fixes and full typecheck/test barriers.
- Git staging/commits and plan checkbox updates.
- Database migrations: none are needed for this design.

## Risk list

- **Azure custom-field fetch behavior:** fallback is to preserve core-field
  chips and log omitted custom fields, using existing partial-field behavior.
- **Feed enrichment cost:** fallback is to dedupe linked provider/item requests
  and reuse the existing chunking/cache patterns.
- **Dense settings UI:** fallback is to keep the editor compact and defer
  presets/templates, without changing the underlying rule model.

## Out of scope

Copied from the design: changing Azure fields; automatic rule inference; regex,
ranges, or boolean conditions; feed filtering/sorting/partitioning; historical
linked-item caching; and standalone work-item feed-card status chips.

## Coverage check

| Design section | Covered by |
| --- | --- |
| Contracts and backward-compatible data model | T0 |
| Main-process architecture and happy/failure paths | T1 |
| Project Settings configuration surface | T2 |
| Feed List presentation and interaction | T3 |
| Integration, refresh, and regression verification | T4 |
| Security and no-new-IPC constraint | T0, T1, T2, T3 |
| Rollout/rollback | T0, T4 |

## Discovered

- The full test suite has one pre-existing environment failure:
  `electron/services/ssh-askpass-broker.test.ts` cannot bind the real
  `ssh-agent` socket under the sandbox (`Operation not permitted`).
- `pnpm lint` exits successfully but reports existing and new import-order
  warnings; no lint errors remain.
