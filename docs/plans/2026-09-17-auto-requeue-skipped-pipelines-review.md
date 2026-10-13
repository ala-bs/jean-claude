# Auto re-queue skipped pipelines — Review

Date: 2026-09-17

Scope: the uncommitted working diff (`src/features/pull-request/ui-pr-completion-queue-driver/{index.tsx,driver.test.tsx}`,
`src/features/pull-request/ui-pr-checks/{index.tsx,index.test.ts}`). The branch has
no commits of its own vs `main`, and no design/plan artifact exists for this
change, so round 2 was run against repo conventions and the prior review doc
`docs/plans/2026-09-16-pr-queue-required-check-skip-review.md`.

## Fixes

| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | An armed PR could stall its project queue forever: a required check Azure always refuses to re-queue (deleted build definition, PAT without queue-builds) was PATCHed on every poll and the entry never settled | `onError` restored the pre-increment attempt count, so a failing PATCH consumed no budget. Budget was written optimistically and rolled back on failure — but the settlement path *deferred to* unspent budget, so "never spendable" meant "never settles" | `onError` now only clears the in-flight marker; a spent retry stays spent whatever Azure answers | `index.tsx:546` |
| 2 | High | Same permanent stall when Azure *accepted* the re-queue but left the evaluation dwelling on `rejected` (superseded iteration, build never starts) | The in-flight marker is only cleared when `shouldAutoRequeue` goes false, so no second retry was ever dispatched, the counter froze at 1 of 2, and the settlement filter excluded the policy on that basis. Settlement was coupled to the retry machinery, so every way that machinery can get stuck became an un-settleable entry | Settlement no longer asks `shouldAutoRequeue` at all. A dispatched retry now buys a **bounded grace window** (`READS_GRANTED_PER_FAILURE_RETRY = 4` extra confirming reads) instead of gating the decision — progress is guaranteed on every path | `index.tsx:637`, `index.tsx:688` |
| 3 | Medium | A genuine flake got fewer retries than advertised — sometimes none: a manual-trigger policy that the queue kicked off and that then failed had one retry instead of two, and two source-branch pushes (re-expiry) left a later failure with zero | One counter was shared by three different requeue reasons. "Start a build nobody started" and "that run expired, redo it" are not retries of a failure, but they spent the failure budget | Budget (`failureRetriesRef`) counts only `rejected`/`broken` re-runs; the kickoff/expiry paths stay marker-only as before. Toast wording corrected to "run N of M" | `index.tsx:497`, `index.tsx:532` |
| 4 | Medium | The PR could be skipped on the very poll that dispatched its final re-run — wasting the retry most likely to be the winning one | React runs the requeue effect before the settlement effect in the same commit, so the settlement predicate read the just-incremented counter, concluded "no budget left", and counted that same poll as a confirming rejection | Same grace-window change as #2: the last retry widens the window rather than closing the gate | `index.tsx:656` |
| 5 | Low | The row icon for a failed optional check still rendered in the required-failure red, so the muted label looked like a rendering bug | The first pass muted only the status label; the `XCircle` colour lived in a separate function | One `isOptionalFailure()` rule now drives both the icon and the label colour | `ui-pr-checks/index.tsx:56` |
| 6 | Low (test) | A throwing `mockImplementation` leaked across tests, silently changing a retry-budget assertion in a later test | `requeueCi.mockClear()` clears calls but leaves implementations installed | `mockReset()` in `beforeEach`, with a comment naming the trap | `driver.test.tsx:212` |

## Before / after

```
  poll reads a required check as `rejected`
                 │
     ┌───────────┴────────────┐
 optional / waived?      blocking?
     │                        │
   ignore        ┌────────────┴─────────────┐
                 │                          │
          budget left?  ── yes ──► re-queue pipeline (budget spent, even if the
                 │                  PATCH fails) and GRANT +4 confirming reads
                 no                         │
                 │                          ▼
                 └──────────────► keep counting confirming reads
                                            │
                          reads >= 2 + retries*4  ──► skip PR, promote next
                                            │
                        check recovers / new evaluation ──► count := 0

  BEFORE: "budget left?" also SUPPRESSED the settlement path, so a budget that
  could never be spent (PATCH always fails) or never re-dispatched (status
  dwells on `rejected`) meant the entry never settled — and no wall-clock
  timeout exists anywhere else to catch it. Worst case now: ~10 counted polls
  (~2.5 min) and the queue always moves on.
```

## Refuted findings

| Claim | Why it was not a bug |
| --- | --- |
| The `ignoredConfigIds` arm of `isBlockingForQueue` is dead code | Reachable, though narrowly: the waiver list is snapshotted at enqueue from policies that were non-blocking *then*, so an admin flipping one to blocking while the PR waits makes the arm the only thing that stops the queue skipping a PR Azure was told to merge anyway. Comment reworded to claim only that. |
| Always showing the `Optional` badge is a regression, because it now sits next to the "Make optional" button | No test encoded the old guard (`index.test.ts` asserts the badge exactly in the no-handler case), and the two chips are different axes — Azure's blocking flag vs the per-PR auto-complete waiver. It is also precisely what was asked for. Redundant at worst, not contradictory. |
| Adding `entry.completionOptions?.autoCompleteIgnoreConfigIds` to two dependency arrays causes effect thrash | Entries are created once in `enqueue` and only shallow-copied by `setStatus`/`setJobId`, which carry the same `completionOptions` object through — stable identity. |
| A rejected + `isExpired` policy can never settle the entry | True, but pre-existing: the `!context?.isExpired` exclusion predates this diff and is in the prior review's *Not fixed* table. This diff only adds (now bounded) re-queue traffic for it. |

## Not fixed (noted only)

| Issue | Why deferred |
| --- | --- |
| A permanently `broken` blocking build policy still never settles the entry (the settlement `find` matches only `rejected`) | Pre-existing; the diff bounds the new PATCH traffic for it but fixing the settle path is outside this change |
| No wall-clock timeout on an armed entry at all — every settle path is condition-based | Pre-existing architectural gap. This review removed the one new way to hit it; a real deadline is a separate change |
| `electron/database/migrations/078_pr_workspace_support.test.ts` fails (`client.setAuthorizer is not a function`) | Pre-existing — verified failing with this diff stashed |
| `src/features/pull-request/ui-pr-run-control/index.test.ts` failed once under full-suite parallelism | Flaky, unrelated file; passes in isolation and in a clean full-suite run |

## Parked — needs your decision

| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| `MAX_AUTO_REQUEUES_PER_POLICY = 2` and `READS_GRANTED_PER_FAILURE_RETRY = 4` (~1 min of grace per retry, ~2.5 min worst case before a skip) | More retries absorb flakier CI but hold the queue head longer and burn agents; fewer restore the old quick-skip | Product call. Both are one-line constants — tell me your CI's flake rate and typical queue-to-start latency and I'll set them |
| Azure's real response to re-queueing a `rejected` evaluation is still unverified (the prior review reverted a similar branch for exactly this) | If Azure refuses it, the feature degrades to "2 wasted PATCHes then skip" — no longer a stall, but no benefit either | Watch the first few runs in the app; if you see the "re-running failed check" toast but no new build in Azure, we should read the response body and gate on it |

## Verification

- `pnpm vitest run src/features/pull-request/ui-pr-completion-queue-driver` → 33 passed (2 files)
- `pnpm vitest run src/features/pull-request` → 184 passed (22 files)
- `pnpm test` → 5807 passed, 1 skipped, 1 failed (migration 078 only; confirmed failing on a stashed tree)
- `pnpm lint` → clean
- `pnpm ts-check` → clean
