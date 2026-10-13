# Per-project usage chart — Review

Date: 2026-09-19

Scope: uncommitted working diff only (no commits ahead of base `f8b17ff`).
Files: `electron/database/repositories/ai-usage.ts`, `shared/ai-usage-types.ts`,
`src/lib/api.ts`, `src/features/usage/ui-usage-overlay/index.tsx`.
No design/plan artifact exists for this change, so Round 2 was conventions-only.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 2 | Low-medium | After renaming a project, the same project rendered under two different names in one scroll of the overlay — "Beta" in Cost-by-project, "Alpha" in Top-tasks — making one project look like two. | `ai_usage_events.projectName` is a record-time snapshot (`ai-usage-tracking-service.ts:123`) that is never rewritten when a project is renamed, and the two aggregations disagreed on precedence: the new `byProject` read live-first, the existing `topTasks` read snapshot-first. Adding `byProject` is what put the two resolutions side by side. | `topTasks` now resolves live-first as well: `projectNames.get(value.projectId) ?? taskNames.get(taskId)?.projectName ?? value.projectName ?? null`. Deleted projects still fall through to the snapshot, preserving the old behavior there. Chosen by the user over the contained alternative of making `byProject` stale to match. | `electron/database/repositories/ai-usage.ts:524` |
| 1 | Medium | "Share of spend" percentages in the Cost-by-project tooltip always renormalize to 100% across listed projects, overstating each project and contradicting the header cost tile. | `byProject` is only accumulated when `event.projectId` is truthy, but a real recording path writes `projectId: null` — `recordAutocompleteUsageBatched` flushes with `projectId: null` (`ai-usage-tracking-service.ts:204-212`) for every inline completion. The new panel derived its denominator by summing `byProject` rows, so that unattributed spend was absent from the denominator while remaining present in `totals`. | Denominator switched to `data.totals.estimatedCostUsd`, matching how the sibling "Usage by feature" panel measures share against `data.totals` rather than a row sum. Shares now sum to ≤100% and reconcile with the hero tile. | `src/features/usage/ui-usage-overlay/index.tsx:803` |

## Before / after

```
BEFORE — denominator = sum of byProject rows
  events ──┬─ projectId set ──► byProject ─► Σ rows = $50 ──► denominator
           └─ projectId NULL ─► (dropped)                        ▲
              (autocomplete)                                      │
  header tile reads $100 ◄── totals (includes NULL rows) ─────────┘  MISMATCH
  → a $25 project renders "Share of spend 50.0%"

AFTER — denominator = totals.estimatedCostUsd
  events ──┬─ projectId set ──► byProject ─► rows
           └─ projectId NULL ─► (still dropped from rows, by design)
  header tile reads $100 ──► totals.estimatedCostUsd ──► denominator
  → the same $25 project renders "Share of spend 25.0%"
  → listed shares sum to ≤100%; the gap is the unattributed spend
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| The new `projects` query is awaited sequentially after the `tasks` query, costing an extra serial DB round-trip; should be `Promise.all`. | The driver is synchronous better-sqlite3 behind Kysely's `SqliteDialect` (`electron/database/index.ts`: `new Database(dbPath)` + `new SqliteDialect({database: client})`). Queries execute synchronously on one connection; `Promise.all` cannot overlap them. The "round trip" is a microtask hop. |
| The new `projects` query is redundant — the `tasks` query above already `leftJoin`s `projects` and selects `projects.name`. | The tasks query is keyed by `taskIds` from `byTaskMap`, populated only under `if (event.taskId && event.projectId)`. `ai_usage_events.taskId` is nullable (`schema.ts:478`), so a project whose events carry no `taskId` never appears there at all; the result map is keyed by `taskId` and exposes no projectId→name lookup. |
| Hook-ordering / re-render-loop risk from the new `useMemo`s. | `UsageOverlay` has exactly one `return` (line 827); all hooks including the new ones at 786/795 sit above it, unconditional. `projectRows` depends on the stable react-query `data?.byProject` reference, same pattern as the existing `data?.byModel` memo. |
| Shared-object mutation via `addTotals` (which mutates its first argument). | The `byProjectMap` miss path allocates a fresh `{...emptyTotals, projectName, taskIds: new Set()}` per projectId; `emptyTotals` is never passed to `addTotals` and holds only primitives, so the shallow spread is a full copy. No object is shared between maps. |
| Missing `byProject` on some other `AiUsageDashboard` producer/consumer. | Repo-wide grep for `byFeature`/`unknownPricing` returns only the 4 touched files. The sole literal outside the repository is the no-window stub at `src/lib/api.ts:2978-2998`, which the diff updates. No snapshot test, fixture, or key-iterating serializer exists. `ts-check` passes. |
| Division by zero / `NaN` / `Infinity` bar widths. | `maxOf` returns `Math.max(...values, 0) || 1`, so `maxProjectCost` is never 0; the share expression is explicitly guarded by `projectCostTotal > 0`. |
| `taskCount` double-counts a task that moved between projects. | No reachable path: `tasks.projectId` is insert-only, no caller of `TaskRepository.update` passes it, and `task-update-validation.ts:41-56` lists `projectId` in `BACKEND_OWNED_UPDATE_FIELDS` and throws if the renderer tries. Each taskId lands in at most one project bucket. |

## Parked — needs your decision

None outstanding. The one parked item (project-name precedence) was resolved by the
user in favour of option (a) and is recorded as fix #2 above.

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| ~~Unattributed spend excluded from the panel's rows~~ | **Resolved after review** — the user asked for an explicit row. `byProject` now buckets events with a null/empty `projectId` under a `projectId: null` row, rendered as a neutral-grey italic "Unattributed" entry that sorts by cost like any other row. Project rows plus that bucket now sum exactly to `totals`, so the tooltip shares add to 100%. |
| The panel adds an unlabeled 4th numeric column (`inputOutputTokens`) that the adjacent "Cost by model" panel does not have; neither panel has column headers. | Cosmetic. The metric itself is consistent with "Usage by feature", which also uses `inputOutputTokens`. |
| `MODEL_COLORS` is reused for projects, so project #1 shares a swatch with model #1 in the panel directly above. Colors are not a stable identity across panels. | Cosmetic; matches how `byFeature` already reuses the same palette. |
| With a single project chip selected, the panel degenerates to one row at 100% width. | Redundant with the header, but no wrong number. Cosmetic. |
| Empty state shows "0 projects" next to "No project data yet."; the sibling panel uses a static label instead of a count. | Copy nit, no wrong information. |
| No test for `AiUsageRepository.getDashboard`. | No test file or shared DB fixture exists for this repository; sibling repo tests each hand-roll a `vi.hoisted` Kysely mock. Per review rules, missing tests are not flagged where no surrounding infrastructure exists — noted as an option, not a defect. |
| No index on `ai_usage_events(projectId)`. | Irrelevant to this change: the aggregation reduces over already-fetched events and issues no new per-project SQL; the scan is driven by `createdAt`, which is indexed. |

## Verification

- `pnpm ts-check` → passes (both `tsconfig.web.json` and `tsconfig.node.json`), no output.
- `pnpm lint` → clean except one pre-existing warning in `src/features/feed/ui-feed-list/feed-item-card.tsx:63` (untouched file).
- Re-run after fix #2: `pnpm ts-check` passes, `pnpm lint` unchanged, `pnpm test` still
  **5812 passed / 1 failed** — same counts as the clean tree.
- `pnpm test` → **5812 passed, 1 failed, 1 skipped (451 files)**. The single failure is
  `electron/database/migrations/078_pr_workspace_support.test.ts` — `TypeError: client.setAuthorizer is not a function`.
  Confirmed pre-existing: re-run against a stashed clean tree produced the identical failure
  (`1 failed | 7 passed`), and the pass/fail counts are unchanged before and after the fix.
- `git diff` re-read after fixing to confirm the fix row above is physically present on disk.
