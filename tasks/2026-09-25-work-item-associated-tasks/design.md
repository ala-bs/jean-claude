# Work Item Details: Associated Active Tasks — Design

Date: 2026-09-25

## Problem

Work Item Details shows Azure links, but does not expose the Jean-Claude tasks
created for that work item. Users need a direct way to resume active work from
the work item inspector.

## Decisions

- Association source is the existing cached task feed's `workItemIds` field.
- Only active task-feed items are shown: items from the active task feed, plus
  non-completed nested child items.
- Tasks appear in a `Tasks` group inside the existing collapsible Links section.
- Clicking a task navigates to `/all/$taskId`.
- No database, IPC, or Azure API changes are required.

## Architecture

```text
Task feed cache
  └─ shared associated-task selector + workItemIds match
       ├─ WorkItemDetails → Links → Tasks group → router Link
       └─ WorkItemPreview → editorial Tasks group → router Link
```

`AssociatedWorkItemTasks` owns the shared task-feed selection and row
presentation. `WorkItemDetails` embeds it in Links, while `WorkItemPreview`
embeds it in the Board Overlay's editorial details. Existing task feed cache
data and router links are reused; neither surface introduces a separate
project-task query.

## Interfaces

`selectAssociatedWorkItemTasks` receives feed items and renders each matching
task as a router link with its existing feed attention indicator. The task
match is:

```ts
item.source === 'task' &&
item.isCompleted !== true &&
item.workItemIds?.some((id) => String(id) === String(workItem.id))
```

## States and failures

- Loading: do not block the work item panel; the Tasks group may show a loading
  label while project tasks are unavailable.
- Empty: show “No active tasks associated”.
- Stale cache: use the normal cache resource refresh behavior.
- Navigation: use the existing typed `/all/$taskId` route link.

## Verification

- Unit-test the active association predicate if extracted.
- Run the mandated test, lint, and TypeScript commands.
- Manually verify an associated active task appears, completed tasks do not,
  and clicking the task opens its task panel.
