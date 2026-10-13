# Draft PR Feed Rail Color — Design
Date: 2026-09-25

## Problem

Feed task rails currently use the default published/open PR color for normal PRs,
while draft PRs fall back to the generic ink color. Draft PR task rails should
have a distinct PR-specific color.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Task rail color is derived from PR state | `src/features/feed/ui-feed-list/feed-item-card.tsx` |
| Draft state currently resolves to generic ink | `src/lib/feed-pr-state.ts` |
| `status-pr` is already used for draft badges and PR UI | `src/index.css`, `feed-item-card.tsx` |

## Decisions

- Reuse `var(--color-status-pr)` for draft PR rails.
- Keep conflict, open-comment, merged, and abandoned states higher precedence;
  those states communicate more actionable information than draft status.
- Keep the change limited to the shared PR-state color helper so task rails and
  its tests stay consistent without introducing new theme tokens.

## Architecture

```text
FeedItemCard ──► getPrStateColor ──► draft? status-pr : published? status-azure
                                      └─ higher-signal states retain precedence
```

## Interfaces

No public interface changes. `getPrStateColor` retains its existing signature
and returns the existing CSS variable string for each PR state.

## Verification

- Unit test the draft mapping as `var(--color-status-pr)`.
- Run the repository-required install, test, lint-fix, TypeScript check, and
  final lint commands.
