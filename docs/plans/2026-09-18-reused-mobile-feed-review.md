# Reused Mobile Feed Badge - Review
Date: 2026-09-18

## Fixes
| # | Severity | Symptom | Root cause | Fix | File |
| 1 | Medium | Old task keeps showing reused mobile | Badge trusted per-task persisted selection without checking current device owner | Feed-level assignment query gates badge ownership | `src/features/feed/ui-feed-list/feed-item-device-badge.tsx` |
| 2 | Medium | Assignment polling multiplied per feed row | Each badge created its own polling query observer | Hoisted assignment query to `FeedList`; threaded assignments through cards and subtasks | `src/features/feed/ui-feed-list/index.tsx`, `feed-item-card.tsx` |

## Before / after
```text
Before: Feed -> many badges -> many 5s assignment observers
After:  Feed -> one assignment observer -> badges receive shared data
                         |
                         +-> stale owner badge hidden
```

## Refuted findings
| Claim | Why it was not a bug |
|---|---|
| Cross-task assignment data creates security boundary exposure | App is single-user/local; task IDs are opaque local identifiers and existing IPC already exposes global task data |

## Parked - needs your decision
| Finding | The two behaviors | Recommendation |
|---|---|---|
| None | - | - |

## Not fixed (noted only)
| Issue | Why deferred |
|---|---|
| Full suite migration test fails at `client.setAuthorizer` | Existing environment/dependency mismatch; unrelated to this diff |

## Verification
- `pnpm install` passed.
- `pnpm exec vitest run src/features/feed/ui-feed-list/feed-item-card.test.tsx` passed: 11 tests.
- `pnpm ts-check` passed.
- `pnpm lint --fix` ran; lint reports one existing import-order warning in `feed-item-card.tsx`.
- `pnpm lint` completed with same non-blocking import-order warning.
- `pnpm test` ran: 5809 passed, 1 skipped, 1 failed at unrelated `078_pr_workspace_support.test.ts` (`setAuthorizer is not a function`).
