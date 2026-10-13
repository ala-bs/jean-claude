# PR queue "required check failed" skip — Review

Date: 2026-09-16

Scope: uncommitted diff on
`src/features/pull-request/ui-pr-completion-queue-driver/` (no design/plan
artifact exists for this fix, so round 2 was limited to repo conventions).

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | The new guard still skipped a PR after a single genuine fetch, so a stale pre-arm rejection could settle the entry ~15s after promotion | `dataUpdatedAt > 0` means "this key has cached data", not "this runner saw a poll". The evaluations query is `enabled: isArmed` with `staleTime: 30_000`, so on arm it serves the PR-details view's snapshot with its old stamp — and that snapshot was counted as confirming read #1 | First read is now a **baseline**: it sets the timestamp floor and never increments the counter. Two post-baseline polls are required | `index.tsx:510` |
| 2 | Medium | Two *different* checks each rejected once settled the entry as "confirmed failed" | The counter was a bare integer while `rejectedPolicy` came from `evaluations.find(...)` — array-order dependent and not tied to an evaluation | Counter is keyed to `evaluationId`; a change of identity resets it to 0 | `index.tsx:497` |
| 3 | Medium | A read showing the check recovered did not clear the count if it landed inside the gap window, so rejected→clean→rejected still skipped the PR | Reset lived inside the "counted read" branch, which is gated on the poll-interval gap | Reset now runs on **every** read with no rejection; only increments need a counted read | `index.tsx:497` |
| 4 | Medium | Speculative `rejected` + `isExpired` requeue branch could PATCH a terminal Azure evaluation every 15s forever (`onError` deletes the retry marker by design) | Added on a hunch, with no evidence Azure accepts a requeue of a superseded-iteration evaluation | Reverted — out of scope for the reported bug | `index.tsx:414` |
| 5 | Medium | New counting logic was dead under test: the driver test mock returned no `dataUpdatedAt`, so `evaluationsFetchedAt` was `undefined` | Mock predates the change | Mock now serves a stamped `dataUpdatedAt`; three driver tests added for baseline / policy-identity / recovery | `driver.test.tsx` |

## Before / after

```
arm entry ──> cached evaluations snapshot (pre-arm, "Build 1" rejected)

first fix:   [count 1] ── poll 15s ─> [count 2] ─> SKIP     ✗ one real fetch
now:         [baseline] ─ poll 15s ─> [count 1] ─ poll 15s ─> [count 2] ─> SKIP
                                          │
                       any read with no rejection, or a different
                       evaluationId ───────> count := 0
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| A sibling mutation's `setQueryData` could fake a confirming evaluations read | All six `setQueryData` calls in `use-pull-requests.ts` target the `['pull-request', ...]` key; nothing writes `['pull-request-policy-evaluations', ...]` |
| Both counted reads could be pre-arm cache values | A disabled/cached query has a frozen `dataUpdatedAt`, so the gap is 0 and a second pre-arm read cannot count. Only read #1 was at risk — that is finding 1 |
| The added `prId` effect dep changes behavior | `QueueEntryRunner` is keyed by `entry.id` and `prId` never mutates within its lifetime — a no-op dep |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| An expired *rejected* build policy is never requeued, so the queue head can wait on a build nobody will start | Pre-existing, outside the reported bug, and the safe fix needs the real Azure response for requeuing a superseded evaluation (finding 4's revert) |
| `electron/database/migrations/078_pr_workspace_support.test.ts` fails | Pre-existing — confirmed failing with this diff stashed |

## Verification

- `npx vitest run src/features/pull-request/ui-pr-completion-queue-driver` → 29 passed (2 files)
- `pnpm test` → 5800 passed, 1 failed (the pre-existing migration 078 test; verified failing on a clean tree)
- `pnpm lint` → clean
- `pnpm ts-check` → clean
