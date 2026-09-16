# Queued PRs dropped on merge — Review

Date: 2026-09-16

Scope: the uncommitted working diff only (no branch commits vs `main`) —
`src/features/pull-request/ui-pr-completion-queue-driver/{index.tsx,index.test.ts,driver.test.tsx}`.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Merging one queued PR drained the rest of that project's queue within seconds, each with a "skipped: merge conflicts" toast | Merging the head moves the target branch, so Azure recomputes the merge of every PR aimed at it and briefly reports `conflicts`; the promoted entry was also judged against a cached PR read that predated the merge. `resolveArmedPrSettlement` treated a *single* blocking `mergeStatus` as terminal, while the sibling `autoCompleteSetBy` check already had a stale-read guard | A blocking `mergeStatus` must be confirmed on a second counted read (`MERGE_BLOCKED_READS_BEFORE_TRUSTED`) before the entry fails | `index.tsx:55,108,111` |
| 2 | High | *Introduced by fix #1*: a genuinely conflicted PR would never settle, wedging the whole project queue permanently | Read counting keyed on `pr !== lastCountedPrRef.current`. React Query's structural sharing (on by default; measured `SAME_REF=true`) returns the **previous object** for a deeply-equal refetch, which is the normal case for a PR at rest — so the counter froze at 1 | Count reads off `dataUpdatedAt` instead of object identity, with identity as the first-read fallback | `index.tsx:186,433-440` |
| 3 | High | Same wedge on the pre-existing `UNARMED_READS_BEFORE_TRUSTED` guard: a persistently unarmed PR could never reach 4 reads | Same root cause as #2 — one shared counting branch | Fixed by the same change; both counters now advance per fetch | `index.tsx:433-452` |
| 4 | Medium | *Introduced by fix #2*: an unrelated cache write could supply the "confirming" read, re-creating bug #1 through a different trigger | The PR query key is shared with every PR mutation (vote, publish, draft toggle, title/description), and each `setQueryData`s on success, spreading the **stale** `mergeStatus` forward and bumping `dataUpdatedAt` exactly like a real fetch | A read only counts once `MIN_COUNTED_READ_GAP_MS` (0.8 × poll interval) has elapsed since the last counted one — a window an incidental click cannot compress | `index.tsx:68,433-440` |

## Before / after

```
BEFORE — one merge cascades through the queue
  PR A merges ──> target branch moves ──> Azure recomputes every sibling PR
      B promoted ── first read: conflicts (transient / pre-merge cache) ─> FAIL ─┐
      C promoted ── same ───────────────────────────────────────────────────────┤ seconds
      D promoted ── same ───────────────────────────────────────────────────────┘
  result: queue empty, jobs failed, nothing merged

AFTER — one confirming poll, a poll interval apart, decides
  t+0s   B armed, read #1: conflicts   -> count 1, NOT terminal, stays queued
  t+~15s poll, read #2: succeeded      -> counter reset, B proceeds to merge
                         conflicts     -> count 2, confirmed, disarm + promote C
  a cache write at t+2s (vote/retitle) -> inside the gap, never counted
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| `dataUpdatedAt` could move backward or reset to 0 and break the comparison | The check is `!==`/elapsed, not monotonic, and `if (!isArmed || !pr) return` guards the undefined-data window; with no `initialData`, a defined `pr` always carries a real timestamp |
| Adding `prFetchedAt` to the watcher effect deps makes it run more often | `settle` already depends on the mutation object, which is a fresh identity every render, so the effect already re-ran every render |
| The `prFetchedAt > 0` fallback silently disables timestamp counting in production | Production never supplies `initialData`/`placeholderData`; the branch only serves test doubles |
| Counters could leak across queue entries | `QueueEntryRunner` is keyed by `entry.id` (`index.tsx:150`), so each promotion mounts fresh refs |
| A genuinely conflicted PR can no longer settle at all | The runner's own `setInterval(invalidate, 15s)` keeps advancing `dataUpdatedAt`, so the gap always clears; verified by test |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| Residual of fix #4: a sibling `setQueryData` on the same PR that lands **more** than 12s after the last counted read can still supply a confirming read carrying a stale `mergeStatus`. Measured ground truth: `setQueryData` is indistinguishable from a real fetch in query state (`dataUpdatedAt` **and** `dataUpdateCount` both bump; `fetchStatus`/`fetchMeta` idle/null after both) | (a) Accept it: exploit window is ≤ one poll interval and needs a user action on that exact PR inside it; worst case is one PR dropped from the queue with a visible toast, recoverable by re-queuing. (b) Close it properly: count confirmations against the runner's **own** poll tick (a ref set on each `setInterval` fire, consumed by the next counted read), which no cache write can manufacture | (b) is the correct mechanism, but it needs the driver test suite converted to fake timers, since counted reads would then require a real tick. Worth doing as its own change — say the word and I'll do it |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| `[qac-debug]` instrumentation from `526c83ac` still in the tree (`cache-event-service.ts`, `handlers.ts`, `cache-listener.tsx`, `ui-pr-auto-complete`, `ui-project-settings`) | Pre-existing, unrelated investigation (toggle sync), outside this diff |
| `hasRejectedBlockingPolicy` has no equivalent confirmation guard — a stale rejected evaluation can also fail an entry on one read | Pre-existing, untouched by this diff; same shape as fix #1 and a candidate for the same treatment |
| `electron/database/migrations` test `078_pr_workspace_support > rolls back table recreation failures` fails | Pre-existing: verified failing with this diff stashed |

## Verification

```
pnpm vitest run src/features/pull-request/ui-pr-completion-queue-driver
  -> 24 passed (2 files)

Regression guards proven by temporarily reverting each fix:
  identity-only counting          -> 2 tests fail (conflict confirmation + unarmed threshold wedge)
  `!==` instead of the time gap   -> 1 test fails (sibling cache write stands in for a poll)
  unguarded `mergeStatus` branch  -> 1 test fails (single transient conflicted read drops the entry)

Structural-sharing probe (throwaway, removed):
  SAME_REF=true UPDATED_AT_DIFFERS=true
setQueryData vs fetch probe (throwaway, removed):
  AFTER_FETCH   dataUpdateCount=1   AFTER_SETDATA dataUpdateCount=2   AFTER_FETCH2 dataUpdateCount=3
  -> no query-state field distinguishes them

pnpm test      -> 5795 passed, 1 failed (pre-existing, see above), 1 skipped
pnpm lint      -> clean
pnpm ts-check  -> clean
```
