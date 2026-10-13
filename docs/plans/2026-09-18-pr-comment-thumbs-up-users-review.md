# PR Comment Thumbs-Up Users - Review
Date: 2026-09-18

## Fixes
| # | Severity | Symptom | Root cause | Fix | File |
|---|---|---|---|---|---|
| 1 | High | Users could not add first thumbs-up | Reaction control was gated by existing like count | Keep interactive control visible for eligible users; hide count only when zero | `src/features/pull-request/ui-pr-comments/index.tsx` |
| 2 | Low | Duplicate React keys for same-name likers | Tooltip used display text as identity key | Use name plus index key | `src/features/pull-request/ui-pr-comments/index.tsx` |
| 3 | Low | Tooltip opened with no content | Like count and usable liker identities were handled separately | Show tooltip only when at least one identity exists | `src/features/pull-request/ui-pr-comments/index.tsx` |

## Before / after
```text
before: likes=0 -> no control -> cannot like
after:  likes=0 -> [thumbs up] -> likes=1 -> hover -> liker names
```

## Refuted findings
| Claim | Why it was not a bug |
|---|---|
| Read-only comments trigger like mutations | Read-only path renders non-interactive indicator and never calls mutation |
| React-rendered liker names allow XSS | React escapes text nodes |

## Parked - needs your decision
| Finding | The two behaviors | Recommendation |
|---|---|---|
| Identity disclosure | Show display name/username/internal ID fallback to every PR viewer, or restrict/sanitize identities | Confirm Azure PR viewer policy before changing fallback behavior |
| Tooltip keyboard announcement | Improve shared `Tooltip` with `aria-describedby`, or limit this feature to pointer hover | Fix shared tooltip accessibility separately to avoid scope expansion |
| Large liker lists | Render all names, or cap/truncate list | Cap only if API can return unusually large reaction lists |

## Not fixed (noted only)
| Issue | Why deferred |
|---|---|
| No direct component test for liker tooltip | Existing PR comment component has no focused rendering test fixture; behavior covered by type/lint review only |

## Verification
- `pnpm install` - passed
- `pnpm ts-check` - passed
- `pnpm lint --fix` - passed with import-order warning, then corrected
- `pnpm lint` - passed
- `git diff --check` - passed
- `pnpm test` - 5,807 passed, 1 failed, 1 skipped
- Existing unrelated failure: `electron/database/migrations/078_pr_workspace_support.test.ts` calls unavailable `client.setAuthorizer`
