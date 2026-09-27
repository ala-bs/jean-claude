# Include task names in raw message export filenames — Design
Date: 2026-09-27

## Problem

Raw message mapping exports use only a truncated task ID, making downloaded
files difficult to identify. The Task Detail View already resolves the visible
task title from the saved name or prompt and should pass that title to the
export helper.

## Codebase findings

| Finding | Evidence |
| --- | --- |
| Export is implemented in a renderer utility | `src/lib/utils-download-message-mapping.ts` |
| The debug pane currently passes only `taskId` | `src/features/task/ui-task-panel/debug-messages-pane.tsx` |
| The panel already resolves the display title | `src/features/task/ui-task-panel/task-name-editor/index.tsx` |

## Decisions

- Use the same resolved title shown in the Task Detail View, including the
  existing prompt fallback.
- Sanitize filesystem-invalid characters and cap the title portion to keep the
  download filename portable.
- Fall back to the short task ID if the title becomes empty after sanitizing.
- Keep the JSON contents and export action unchanged.

## Architecture and interfaces

```text
TaskPanel ──► DebugMessagesPane ──► downloadMessageMapping(messages, taskId, taskTitle)
                                               │
                                               └──► sanitized download filename
```

The utility accepts an additional `taskTitle: string` parameter and derives
`message-mapping-<safe title>.json`.

## Verification

- Unit test filename sanitization and ID fallback.
- Run the repository-required install, test, lint-fix, TypeScript, and lint
  commands.
