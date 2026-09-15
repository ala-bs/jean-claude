# Queue auto-complete toggle sync (instrumentation pass) — Review

Date: 2026-09-15

Scope: uncommitted working diff only. `git merge-base HEAD main` equals `HEAD`,
so there is no branch-vs-base delta. No design/plan artifact exists for this
change, so Round 2 was limited to repo conventions and leftover scaffolding.

The diff under review is **diagnostic instrumentation**, not the feature fix:
four `[qac]` log sites plus one new component test.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | Med | `[qac] emit` could print `willSend=true` for a window that never receives the event, i.e. the instrumentation itself produces the false lead it exists to eliminate | The log was inserted at the top of the per-window loop and derived `willSend` from `shouldSendCacheEvent` alone, but the real send is additionally gated by `!win.isDestroyed() && !win.webContents.isDestroyed()` further down — the log duplicated half of a two-part condition | Compute `isAlive` and fold it into the reported `willSend`, and print `alive=` explicitly | `electron/services/cache-event-service.ts` |
| 2 | Med | The per-row log would emit ~1 line per PR feed row per project change, burying the two single-line logs the user must actually read and report back | `PrAutoComplete` mounts once per PR feed row (`feed-item-card.tsx:334`) and the feed list does **not** virtualize (verified: no windowing in `ui-feed-list/index.tsx`), so a single `project.upsert` re-renders every row and the effect fired on all of them | Dedupe to transitions only via a module-level `Map<projectId, value>`, and move it to a distinct `[qac-row]` prefix so it can be filtered separately | `src/features/pull-request/ui-pr-auto-complete/index.tsx` |
| 3 | Med | The new test proved only "store → UI is reactive"; it drove the update with `applyCacheEvent`, skipping `shouldApplyCacheEvent` — the very gate under suspicion | Test entered the pipeline one layer below the real renderer entry point | Added a second case driving `handleCacheEvent`, the real entry point, so the gate is exercised | `.../ui-pr-auto-complete/queue-toggle-sync.test.tsx` |

## What the round bought us diagnostically

Fix 3 was not just hygiene — running it **eliminated the entire renderer half of
the suspect list**:

```
Settings toggle ──► autosave ──► projects:update (IPC)
                                      │
                                      ▼
                           emitCacheEvent('project.upsert')
                                      │
       ┌──────────────────────────────┴─────────────────────────────┐
       │  MAIN-SIDE DELIVERY                                        │
       │  per-window subscription filter + liveness guard   ❓ STILL SUSPECT
       └──────────────────────────────┬─────────────────────────────┘
                                      ▼
                          handleCacheEvent (renderer)
                          shouldApplyCacheEvent gate       ✅ CLEARED (PROBE 2)
                                      ▼
                          cache$.projects[id] updated      ✅ CLEARED
                                      ▼
                          useProject → PrAutoComplete      ✅ CLEARED
```

A probe also confirmed the new per-row effect **does** refire on `project.upsert`
(log count 1 → 2), so the instrumentation is not blind at the moment it matters.

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| The `[qac] cache subscriptions truncated` warning under-reports drops, because the later `.flatMap` also discards entries inside the kept 500 (null entries, empty `resourceKey`, keys > 300 chars) | Mechanism is literally true but cannot fire for this investigation. Project ids are 32-char hex (`001_initial.ts`: `lower(hex(randomblob(16)))`), so `project:<id>` is ~40 chars against a 300-char cap, and the renderer constructs the subscription objects itself so the null/empty branches are hostile-payload defenses only. The 500-entry cap is the sole realistic drop path, and that is exactly what the warning covers. |
| The first test assertion is vacuous — `button?.getAttribute('title')` could be `null` because no button rendered at all | With `autoCompleteSetBy: null`, no queue entry, and a matching `currentIdentityId`, the trigger button renders with `title={undefined}`. Had no button rendered, the optional chain yields `undefined`, which fails `toBeNull()`. The guard holds. |
| The new `useEffect` could hot-loop on an unstable `project` identity | `useEffect` was already imported; `project` comes from `cache$.projects[id].get()` and is stable across renders absent a mutation. Verified empirically by probe. |
| Double `shouldApplyCacheEvent` / `shouldSendCacheEvent` calls introduce a side effect | Both verified pure — they read `subscriptionCounts` and `cache$.resources[key].get()` and mutate nothing. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| **All `[qac]` / `[qac-row]` logging must be removed before this ships.** It is deliberate temporary scaffolding and contradicts normal repo hygiene. | It is the point of the current change; removal happens once the logs identify the broken hop. |
| `droppedProjectKeys` filters on `startsWith('project')`, so it won't list project-scoped keys named `tasks:project:*` / `pullRequests:project:*` | Affects readability of a warning that only fires past 500 subscriptions; irrelevant to the flag under investigation. |
| The new test mocks `@/lib/api` with only `projects.findById` and `cache.setSubscriptions`; extending it to the queued/armed branch would need `api.pullRequests.*` | Not a defect today; noted for whoever extends the file. |
| No `vi.clearAllMocks()` / zustand store reset in `afterEach` | Invisible with the current two cases; would matter if queue-entry cases are added. |

## Verification

```
pnpm ts-check   → clean (tsconfig.web.json + tsconfig.node.json)
pnpm lint       → clean (oxlint, no warnings)
pnpm test       → 445 passed | 1 skipped (446 files)
                  5753 passed | 1 skipped (5754 tests)
```

Every row in the Fixes table was re-confirmed present in `git diff` after the
run.
