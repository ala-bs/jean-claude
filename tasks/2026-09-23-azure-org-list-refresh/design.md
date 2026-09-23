# Azure Organization List Refresh — Design
Date: 2026-09-23

## Problem

Azure DevOps organization lists are backed by the cached `providers` React
Query. When an organization is added in Settings while the clone pane is
already open, the clone pane can continue showing the old list. Users need an
explicit way to refresh the list, especially before cloning from Azure.

## Users & success criteria

- A user can refresh the Azure organization list from the clone repository
  pane.
- A user can refresh the same list from Azure DevOps Settings.
- The refresh action visibly indicates progress and does not lose the current
  selection.
- No new persistence, IPC, or Azure API contract is required.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Organization lists use the `providers` React Query | `src/hooks/use-providers.ts`, `src/features/project/ui-clone-repo-pane/index.tsx` |
| Provider mutations already invalidate the providers query | `src/hooks/use-providers.ts` |
| Clone pane is the user-facing stale-list case | `src/features/project/ui-clone-repo-pane/index.tsx` |

## Decisions

1. Use `useProviders().refetch()` from both list surfaces.
2. Put refresh controls beside the relevant heading/header, with accessible
   labels and a rotating `RefreshCw` icon while fetching.
3. Keep the selected provider ID unchanged; React Query returns the newest
   provider objects and the existing ID-based selection resolves naturally.

## Architecture

```text
Azure Settings / Clone Pane
          │
          └── useProviders().refetch()
                    │
                    ▼
             providers query
                    │
                    ▼
           refreshed organization list
```

## Interfaces

No new public interface. Existing hook return values are used:

```ts
const providersQuery = useProviders();
await providersQuery.refetch();
```

## Error handling

React Query retains the prior data if refetch fails. Existing error rendering
continues to handle the query error; the refresh button returns to its idle
state after the request settles.

## Test strategy

- Run the repository test suite, lint, and TypeScript checks.
- Manually verify that adding an organization in Settings, then refreshing the
  clone pane, makes it available without closing and reopening the pane.
- Manually verify refresh in Settings and verify selection is preserved.

## Rollout

No migration, feature flag, or rollback work is required. The change is
renderer-only and uses the existing provider query contract.
