# Expired Pipeline Requeue — Review
Date: 2026-09-18

## Fixes
| # | Severity | Symptom | Root cause | Fix | File |
| --- | --- | --- | --- | --- | --- |
| 1 | High | Multiple expired policies could leave one policy permanently marked in-flight after its PATCH failed | TanStack Query replaces per-call mutation callbacks when consecutive `mutate` calls share one observer; earlier `onError` callbacks were not guaranteed to run | Use independent `mutateAsync(...).catch(...)` promises so each failed PATCH clears its own marker | `src/features/pull-request/ui-pr-completion-queue-driver/index.tsx` |

## Before / after
```text
Before:
policy A PATCH ─┐
                ├─ shared mutation observer ── latest callback only
policy B PATCH ─┘                              └─ A marker may stick

After:
policy A PATCH ── promise A ── catch A ── clear A marker
policy B PATCH ── promise B ── catch B ── clear B marker
```

## Refuted findings
| Claim | Why it was not a bug |
| --- | --- |
| Expired `running` evaluations should not be requeued | `context.isExpired` identifies an older-commit run; adjacent UI code treats any expired build policy as re-queueable. |

## Parked — needs your decision
| Finding | The two behaviors | Recommendation |
| --- | --- | --- |
| PATCH succeeds but Azure keeps returning same expired evaluation; marker suppresses retries and expired rejection is excluded from settlement | Keep one PATCH in flight per policy and trust Azure transition, or add bounded retries plus terminal queue settlement | Keep current behavior for now; bounded policy needs product choice because it can skip a PR while CI state remains stale. |

## Not fixed (noted only)
| Issue | Why deferred |
| --- | --- |
| Expired `approved` evaluation is not automatically requeued | User request covers expired running pipelines; broadening approved-state behavior changes existing queue semantics. |

## Verification
- `pnpm vitest run src/features/pull-request/ui-pr-completion-queue-driver/index.test.ts src/features/pull-request/ui-pr-completion-queue-driver/driver.test.tsx` — 36 passed
- `pnpm ts-check` — passed
- `pnpm lint` — passed
- `pnpm test` — 5808 passed, 1 skipped, 1 pre-existing failure in migration 078 (`client.setAuthorizer is not a function`)
