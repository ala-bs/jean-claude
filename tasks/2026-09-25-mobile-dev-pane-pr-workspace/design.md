# Mobile Dev Pane in PR Workspace — Design
Date: 2026-09-25

## Problem

The PR workspace overview currently force-closes and hides the Mobile Dev pane,
even when the project has mobile preview configuration. Its Logs action and
`cmd+l` shortcut always open Command Logs. This makes the PR workspace behave
differently from a normal task despite using the same task worktree and mobile
runtime configuration.

## Users & success criteria

- A developer opening a PR workspace with mobile configuration can use the same
  Mobile Dev pane available from a normal task.
- The overview's primary Logs action and `cmd+l` target Mobile Dev when it is
  available.
- Command Logs remains directly reachable as a secondary pane.
- Projects without mobile configuration retain the current Command Logs
  behavior.
- The pane runs from the PR worktree when one exists, with the existing project
  root fallback preserved.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Mobile Dev is already rendered by TaskPanel and receives the task root path | `src/features/task/ui-task-panel/index.tsx` |
| PR overview explicitly hides Mobile Dev and changes the logs shortcut target | `src/features/task/ui-task-panel/index.tsx` |
| PR overview owns the primary Logs action | `src/features/task/ui-pr-workspace-empty-state/index.tsx` |
| Mobile availability is derived from project mobile preview config | `src/features/task/ui-task-panel/index.tsx` |

## Decisions

- Mobile Dev is the primary logs surface in a PR overview when configured.
- Command Logs remains available without the `cmd+l` shortcut in that state.
- Without mobile configuration, Command Logs remains primary.
- No new IPC, persistence, database migration, or runtime is needed.
- The existing `task.worktreePath ?? project.path` root selection is reused.

## Architecture

```text
PR overview
   │
   ├─ primary Logs/Mobile Dev action ──┐
   ├─ cmd+l ---------------------------┼─> TaskPanel pane routing
   └─ secondary Command Logs action ---┘       │
                                               ├─ MobileDevPane
                                               └─ CommandLogsPane
```

TaskPanel remains the owner of pane visibility and shortcut routing. The PR
overview card only receives the already-resolved primary action callback and
label. MobileDevPane is unchanged and continues to own device selection,
Metro/build logs, and task-scoped state.

## Interfaces

No public or IPC interface changes. The existing PR overview callback is reused:

```ts
onOpenLogs: () => void;
```

TaskPanel resolves that callback to Mobile Dev when `mobileDevPaneEnabled` is
true, otherwise to Command Logs. The visible button label is resolved by the
same condition so the action is not misleading.

## Data flow

1. TaskPanel derives `mobileDevPaneEnabled` from the project config.
2. PR overview no longer treats Mobile Dev as a prohibited pane.
3. `cmd+l`, run-command log controls, and the overview primary action select
   Mobile Dev when enabled.
4. MobileDevPane receives the existing task/project/worktree inputs.
5. The secondary Command Logs command remains registered without `cmd+l`.

Failure behavior is unchanged: absent/invalid mobile configuration follows the
existing Command Logs path; Mobile Dev's existing device, Metro, and build
errors remain responsible for their own UI and toast handling.

## State and security

No new state. Existing task-scoped navigation state selects the pane, and the
existing persisted Mobile Dev store retains device/log-tab selections. No new
permissions or data exposure are introduced.

## Verification

- Update TaskPanel tests for PR overview routing with and without Mobile Dev.
- Assert the overview primary action opens Mobile Dev when available and
  Command Logs otherwise.
- Assert the secondary Command Logs command remains available.
- Run the repository-required install, test, lint-fix, type-check, and lint
  commands.

## Rollout

No migration or feature flag. The change is renderer-only and reversible by
restoring the overview exclusion and routing condition.
