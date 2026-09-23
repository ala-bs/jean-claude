# Mobile build status in feed — Design
Date: 2026-09-23

## Problem

Mobile preview builds are task-scoped run commands, but the feed only retains
currently running commands. Once the command exits, the associated task gives
no indication that a build was running or whether it succeeded.

## Decisions

- Keep the latest mobile build status in the renderer store, keyed by task ID.
- A task has one compact latest-build status even though command IDs are
  device-scoped.
- Keep the result until a later mobile build starts.
- Map `running` to ongoing, `stopped` (zero exit in the existing service) to
  succeeded, and `errored` to failed.
- No database migration: this is live-session UI state.

## Architecture

```text
run-command IPC status
        │
        ▼
TaskMessageManager ──► mobileBuildStatuses[taskId]
                              │
                              ▼
                    FeedItemCard / SubtaskRow
```

The shared mobile-command parser identifies only stable `mobile-build:` IDs.
The task message manager translates command status events into a retained
latest result. Feed rows render a status badge and use the existing running-row
visual treatment for an active build.

## Interfaces

```ts
type MobileBuildStatus = {
  commandId: string;
  status: 'running' | 'succeeded' | 'errored';
  updatedAt: number;
};

mobileBuildStatuses: Record<string, MobileBuildStatus>;
setMobileBuildStatus(
  taskId: string,
  commandId: string,
  status: MobileBuildStatus['status'],
): void;
```

## Failure handling and logging

- Unknown/non-mobile command IDs are ignored.
- A failed command remains visible as failed until another mobile build starts.
- The process service’s existing zero-exit/`stopped` contract is used for
  success; if that contract changes, the status mapping is the boundary to
  update.

## Tests

- Preserve parser round-trip and invalid-ID tests.
- Verify the feed status mapping through task-message status events.
- Run the repository-required install, test, lint-fix, type-check, and lint
  commands.
