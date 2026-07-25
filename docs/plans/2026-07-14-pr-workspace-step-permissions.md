# PR Workspace Step Permissions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn PR review tasks into durable PR Workspaces with useful zero-step UI, generic agent steps, step-scoped session permissions, explicit closed-PR retention decisions, and safe workspace deletion.

**Architecture:** Keep `task.type === 'pr-review'` as workspace/lifecycle identity while moving session permission state from tasks to individual steps. Persist PR workspace lifecycle as `active | cleanup-pending | kept`, replace automatic closed-PR destruction with one global decision queue, and centralize destructive work under the existing project/PR lifecycle lock. Renderer uses normal step, command, and message infrastructure after first step exists; only zero-step state and lifecycle controls are specialized.

**Tech Stack:** Electron IPC, TypeScript, React 19, TanStack Query, Zustand, TanStack Router, Kysely, SQLite, Vitest

---

## Product Invariants

- A PR Workspace may have zero steps. Zero steps is a ready workspace, not a loading or message-fetch failure.
- Generic agent steps are allowed inside `pr-review` tasks and use normal project/global permission defaults.
- `pr-review-chat` steps remain server-created, read-only, and immutable through generic step APIs.
- Session permissions belong to one step. Sibling steps never inherit later session grants.
- **Allow once** resolves only the current permission request and never writes rules.
- **Allow for Session** updates only the active step.
- Closed PR detection never deletes a workspace automatically. It changes `active` workspaces to `cleanup-pending` and presents one global decision per project/PR.
- **Keep workspace** changes pending workspaces to `kept` without stopping agents or commands, deleting files, completing tasks, or disabling controls.
- **Delete all** deletes only `pr-review` tasks for that project/PR. Normal linked agent tasks are untouched.
- Destructive ordering is: stop every command, stop every agent step, close editors, clean Git worktrees/branches, then delete task rows. Steps/messages cascade only after external cleanup succeeds.
- Cleanup failure retains task/history and enough cleanup identity for retry.
- Reactivation changes `cleanup-pending` or `kept` workspaces back to `active`. A later closure prompts again.

### Task 1: Move Session Rules From Tasks to Steps

**Files:**
- Create: `electron/database/migrations/078_pr_workspace_support.ts`
- Create: `electron/database/migrations/078_pr_workspace_support.test.ts`
- Modify: `electron/database/migrator.ts`
- Modify: `electron/database/schema.ts`
- Modify: `shared/types.ts`
- Modify: `electron/database/repositories/tasks.ts`
- Modify: `electron/database/repositories/task-steps.ts`
- Create: `electron/database/repositories/task-steps.test.ts`
- Modify: fixtures containing `Task.sessionRules` under `src/**/*.test.ts`, `electron/**/*.test.ts`, and `shared/**/*.test.ts`

**Step 1: Write migration tests**

Create a real in-memory SQLite schema at the pre-migration shape. Insert:

- one task with non-empty rules and two steps;
- one task with null rules and one step;
- one zero-step task;
- messages and raw messages referencing migrated steps;
- cleanup identity columns added by this consolidated migration.

Assert `up()`:

```ts
expect(await columnNames(db, 'tasks')).not.toContain('sessionRules');
expect(await columnNames(db, 'task_steps')).toContain('sessionRules');
expect(JSON.parse(stepA.sessionRules!)).toEqual(taskRules);
expect(JSON.parse(stepB.sessionRules!)).toEqual(taskRules);
expect(stepWithNullParent.sessionRules).toBeNull();
expect(await countRows(db, 'messages')).toBe(messageCount);
expect(await countRows(db, 'raw_messages')).toBe(rawMessageCount);
expect((await sql`PRAGMA foreign_key_check`.execute(db)).rows).toEqual([]);
```

Assert `down()` restores each task from its latest step by `sortOrder DESC`, then `createdAt DESC`, then `id DESC`. This downgrade is intentionally lossy when sibling rules differ.

**Step 2: Run migration test and verify failure**

Run: `pnpm test -- electron/database/migrations/078_pr_workspace_support.test.ts`

Expected: FAIL because migration does not exist.

**Step 3: Implement migration safely**

In `up()`:

1. Add nullable `task_steps.sessionRules`.
2. Backfill every step from its parent task.
3. Disable foreign keys before recreating `tasks`.
4. Recreate `tasks` with every current column except `sessionRules`, including cleanup identity fields added earlier in this migration.
5. Copy rows, drop old table, rename replacement, run `PRAGMA foreign_key_check`, then re-enable foreign keys.

Use one transaction for table recreation. Never use `db` inside transaction callback.

In `down()`:

1. Add `tasks.sessionRules` through safe table recreation.
2. Populate it from latest child step using deterministic ordering.
3. Recreate `task_steps` without `sessionRules` while foreign keys are disabled.
4. Verify foreign keys before committing.

Register after migration `076` in `electron/database/migrator.ts`.

**Step 4: Update shared and database models**

Move field definitions:

```ts
export interface TaskStep {
  // existing fields
  sessionRules: PermissionScope;
}
```

Remove `sessionRules` from `Task`, `NewTask`, `UpdateTask`, task repository input types, task row parsing, and task DB serialization. Add nullable JSON column to `TaskStepTable`; parse null as `{}` and serialize create/update values in `TaskStepRepository`.

**Step 5: Add repository round-trip tests**

Test step create/read/update behavior:

```ts
expect(created.sessionRules).toEqual({ bash: { 'pnpm test': 'allow' } });
expect(readWithNullRules.sessionRules).toEqual({});
expect(updateValues.sessionRules).toBe(
  JSON.stringify({ read: { '**/*.ts': 'allow' } }),
);
```

Update test fixtures by moving existing task rules to their active step. Do not keep compatibility fields on tasks.

**Step 6: Run focused tests**

Run: `pnpm test -- electron/database/migrations/078_pr_workspace_support.test.ts electron/database/repositories/task-steps.test.ts electron/database/repositories/tasks.test.ts shared/types.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add electron/database/migrations/078_pr_workspace_support.ts electron/database/migrations/078_pr_workspace_support.test.ts electron/database/migrator.ts electron/database/schema.ts shared/types.ts electron/database/repositories/tasks.ts electron/database/repositories/task-steps.ts electron/database/repositories/task-steps.test.ts
git commit -m "refactor(permissions): scope session rules to steps"
```

### Task 2: Make Permission Composition and Mutation Step-Scoped

**Files:**
- Create: `electron/services/step-permission-service.ts`
- Create: `electron/services/step-permission-service.test.ts`
- Modify: `electron/services/agent-service.ts`
- Modify: `electron/services/agent-service.test.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/hooks/use-tasks.ts`
- Create: `src/hooks/use-step-permissions.ts`

**Step 1: Write failing permission service tests**

Define atomic operations around a `stepId`:

```ts
addSessionAllowedTool({ stepId, tool, pattern })
removeSessionAllowedTool({ stepId, tool, pattern })
allowForProject({ stepId, tool, pattern })
allowForProjectWorktrees({ stepId, tool, pattern })
allowGlobally({ stepId, tool, pattern })
```

Test:

- session grant updates only requested step;
- sibling step remains unchanged;
- remove preserves unrelated entries;
- project/worktree/global grants update settings and active step for immediate runtime consistency;
- missing step or parent task rejects;
- read-only `pr-review-chat` step rejects every mutation;
- each successful mutation emits `step.upsert`, never `task.upsert`;
- concurrent mutations re-read current step inside serialized update rather than overwriting each other.

**Step 2: Run test and verify failure**

Run: `pnpm test -- electron/services/step-permission-service.test.ts`

Expected: FAIL because service does not exist.

**Step 3: Implement atomic service**

Keep lookup, validation, merge, persistence, and event emission in one service operation. Use per-step promise serialization so simultaneous grants cannot perform stale read/modify/write cycles.

Do not add compatibility wrappers around task-level APIs. Replace callers.

**Step 4: Move agent runtime composition to step rules**

In `AgentService`, change effective rule order to:

```ts
const permissionRules = [
  ...resolveRules(settings, isWorktree, globalRules, workingDir),
  ...flattenScope(step.sessionRules ?? {}),
];
```

Pass:

```ts
persistedSessionRules: step.sessionRules ?? {}
```

When backend reports session-allowed tools, re-fetch and update the step, then emit `step.upsert`. Add tests proving:

- project rules are overridden only by current step rules;
- learned tools persist on current step;
- sibling rules remain unchanged;
- provider without persisted-session support does not mutate step.

**Step 5: Replace IPC contracts**

Replace `tasks:*Session*` channels and task-ID parameters with `steps:*` channels and `stepId`. Remove `sessionRules` special handling from `tasks:update`.

Renderer API shape:

```ts
steps: {
  addSessionAllowedTool(params: {
    stepId: string;
    tool: string;
    pattern: string;
  }): Promise<TaskStep>;
  removeSessionAllowedTool(params: {
    stepId: string;
    tool: string;
    pattern: string;
  }): Promise<TaskStep>;
  // project, worktree, and global variants also accept stepId
}
```

Create step-specific React Query mutations in `use-step-permissions.ts`. Remove corresponding exports from `use-tasks.ts`.

**Step 6: Preserve Allow Once semantics**

Trace `PermissionBar` request resolution. Add/adjust its test so **Allow once** calls only request resolution and none of the step permission mutations. **Allow for Session** must call `steps.addSessionAllowedTool` with active `step.id`.

Run: `pnpm test -- electron/services/step-permission-service.test.ts electron/services/agent-service.test.ts src/features/agent/ui-permission-bar`

Expected: PASS.

**Step 7: Commit**

```bash
git add electron/services/step-permission-service.ts electron/services/step-permission-service.test.ts electron/services/agent-service.ts electron/services/agent-service.test.ts electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts src/hooks/use-tasks.ts src/hooks/use-step-permissions.ts src/features/agent/ui-permission-bar
git commit -m "feat(permissions): isolate agent session grants by step"
```

### Task 3: Allow Generic Steps While Keeping PR Chat Read-Only

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/ipc/task-update-validation.ts`
- Modify: `electron/ipc/task-update-validation.test.ts`
- Modify: `electron/services/agent-service.ts`
- Modify: `electron/services/agent-service.test.ts`
- Modify: `electron/services/pr-review-agent-service.ts`
- Modify: `electron/services/pr-review-agent-service.test.ts`
- Modify: `electron/services/pr-review-task-service.ts`
- Modify: `electron/services/pr-review-task-service.test.ts`

**Step 1: Invert generic-step rejection tests**

Replace tests that reject all generic steps under PR-review tasks. Assert:

- generic `agent` step can be created, updated, and started;
- renderer cannot forge `meta.kind: 'pr-review-chat'` through generic create/update;
- genuine PR chat step cannot be changed through generic step update;
- chat metadata under a normal task rejects;
- chat PR ID must match parent task PR ID.

**Step 2: Run focused tests and verify failure**

Run: `pnpm test -- electron/ipc/task-update-validation.test.ts electron/services/agent-service.test.ts electron/services/pr-review-agent-service.test.ts`

Expected: FAIL because current validation rejects generic PR Workspace steps and stores chat rules on task.

**Step 3: Split workspace identity from chat identity**

Use these checks:

```ts
if (isPrReviewChatStepMeta(step.meta)) {
  assertReadOnlyPrReviewChatStep({ task, step, backend });
}
```

Do not special-case generic steps merely because parent task type is `pr-review`. Continue rejecting chat metadata under non-PR tasks.

`createPrReviewChatStep()` must create:

```ts
{
  type: 'agent',
  interactionMode: 'ask',
  sessionRules: buildReadOnlyPrReviewSessionRules(),
  meta: { kind: 'pr-review-chat', pullRequestId, ... },
}
```

PR Workspace task creation must no longer set read-only task rules. Generic first step gets `sessionRules: {}` and therefore project/global defaults.

**Step 4: Protect chat rules semantically**

Mutation services reject `pr-review-chat` metadata before writing. Runtime verifies expected read-only rule scope without `JSON.stringify` insertion-order equality. Compare normalized flattened rules or a canonicalized scope.

**Step 5: Run focused tests**

Run: `pnpm test -- electron/ipc/task-update-validation.test.ts electron/services/agent-service.test.ts electron/services/pr-review-agent-service.test.ts electron/services/pr-review-task-service.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add electron/ipc/handlers.ts electron/ipc/task-update-validation.ts electron/ipc/task-update-validation.test.ts electron/services/agent-service.ts electron/services/agent-service.test.ts electron/services/pr-review-agent-service.ts electron/services/pr-review-agent-service.test.ts electron/services/pr-review-task-service.ts electron/services/pr-review-task-service.test.ts
git commit -m "feat(pr): support generic workspace agent steps"
```

### Task 4: Persist PR Workspace Lifecycle State

**Files:**
- Modify: `electron/database/migrations/078_pr_workspace_support.ts`
- Modify: `electron/database/migrations/078_pr_workspace_support.test.ts`
- Modify: `electron/database/migrator.ts`
- Modify: `electron/database/schema.ts`
- Modify: `shared/types.ts`
- Modify: `electron/database/repositories/tasks.ts`
- Modify: `electron/database/repositories/tasks.test.ts`
- Modify: `electron/ipc/task-update-validation.ts`
- Modify: `electron/ipc/task-update-validation.test.ts`

**Step 1: Write failing migration tests**

Add nullable `prWorkspaceState` to tasks. Backfill:

- live `pr-review` task with workspace metadata: `active`;
- completed PR-review task retaining workspace metadata: `cleanup-pending`;
- PR-review task without workspace metadata: `active` so restoration remains possible;
- every non-PR task: null.

Assert down removes only new column and preserves all task/step/message rows.

**Step 2: Run test and verify failure**

Run: `pnpm test -- electron/database/migrations/078_pr_workspace_support.test.ts`

Expected: FAIL because migration does not exist.

**Step 3: Implement migration and models**

Add:

```ts
export type PrWorkspaceState = 'active' | 'cleanup-pending' | 'kept';
```

Expose `Task.prWorkspaceState: PrWorkspaceState | null`. New PR-review tasks are `active`; normal tasks are null. Repository parsing must reject unknown persisted values rather than silently treating them as active.

Register migration after `076`.

**Step 4: Protect backend-owned state**

Add `prWorkspaceState` to backend-owned task update fields. Generic `tasks:update` must reject renderer attempts to change it. Lifecycle service owns transitions.

**Step 5: Run focused tests**

Run: `pnpm test -- electron/database/migrations/078_pr_workspace_support.test.ts electron/database/repositories/tasks.test.ts electron/ipc/task-update-validation.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add electron/database/migrations/078_pr_workspace_support.ts electron/database/migrations/078_pr_workspace_support.test.ts electron/database/migrator.ts electron/database/schema.ts shared/types.ts electron/database/repositories/tasks.ts electron/database/repositories/tasks.test.ts electron/ipc/task-update-validation.ts electron/ipc/task-update-validation.test.ts
git commit -m "feat(pr): persist workspace lifecycle state"
```

### Task 5: Replace Automatic Closed Cleanup With Durable Decisions

**Files:**
- Modify: `electron/services/pr-review-task-service.ts`
- Modify: `electron/services/pr-review-task-service.test.ts`
- Modify: `electron/services/feed-service.ts`
- Modify: `electron/services/feed-service.test.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

**Step 1: Write lifecycle transition tests**

Replace automatic cleanup expectations with:

- active PR leaves workspace `active`;
- closed PR changes every `active` workspace for project/PR to `cleanup-pending`;
- closed PR leaves `kept` workspaces unchanged and does not prompt again;
- repeated closed status is idempotent;
- reopened PR changes `cleanup-pending` and `kept` back to `active`;
- a later closure changes active back to pending;
- task upsert emits for every changed workspace;
- no command, agent, editor, Git, completion, or deletion operation occurs during detection.

Rename `completePrReviewTasksForClosedPr` to behavior-revealing service such as:

```ts
reconcilePrWorkspaceState({ projectId, pullRequestId, pullRequestStatus })
```

**Step 2: Run service/feed tests and verify failure**

Run: `pnpm test -- electron/services/pr-review-task-service.test.ts electron/services/feed-service.test.ts`

Expected: FAIL because closed status currently cleans and completes workspaces.

**Step 3: Implement transitions under lifecycle lock**

Under existing project/PR lock, re-fetch current PR status and related PR-review tasks before transitions. Keep `kept` on repeated closed observations. On active status, reset both pending and kept to active.

Creation/restoration always writes `active`.

**Step 4: Update detail and feed triggers**

Both `azureDevOps:getPullRequest` and feed status enrichment call reconciliation for active and closed statuses. Continue isolating Azure/status failures per PR, but do not swallow state persistence errors silently; log them and return valid PR data.

Feed must not hide pending or kept workspace tasks.

**Step 5: Add pending-decision API**

Expose:

```ts
listPendingPrWorkspaceDecisions(): Promise<Array<{
  projectId: string;
  pullRequestId: number;
  taskIds: string[];
}>>
```

Repository/service groups `cleanup-pending` tasks by project/PR, ordered oldest detected first. Grouping prevents duplicate prompts when historical workspace tasks exist.

**Step 6: Run focused tests**

Run: `pnpm test -- electron/services/pr-review-task-service.test.ts electron/services/feed-service.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add electron/services/pr-review-task-service.ts electron/services/pr-review-task-service.test.ts electron/services/feed-service.ts electron/services/feed-service.test.ts electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts
git commit -m "feat(pr): queue closed workspace decisions"
```

### Task 6: Centralize Safe PR Workspace Deletion

**Files:**
- Create: `electron/services/pr-workspace-deletion-service.ts`
- Create: `electron/services/pr-workspace-deletion-service.test.ts`
- Modify: `electron/services/task-worktree-cleanup-service.ts`
- Modify: `electron/services/task-worktree-cleanup-service.test.ts`
- Modify: `electron/services/pr-review-task-service.ts`
- Modify: `electron/services/pr-review-task-service.test.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

**Step 1: Write exact ordering and boundary tests**

For delete current and delete all, record calls and assert:

```ts
expect(order).toEqual([
  'stop-command:task-1',
  'stop-command:task-2',
  'stop-agent:step-1',
  'stop-agent:step-2',
  'close-editor:task-1',
  'close-editor:task-2',
  'cleanup-git:task-1',
  'cleanup-git:task-2',
  'delete-db:task-1',
  'delete-db:task-2',
]);
```

Cover:

- command stop false aborts before any agent/Git/DB operation;
- agent stop failure aborts before editor/Git/DB operation;
- Git cleanup failure deletes no task rows and preserves failed task/history;
- all commands across all targets stop before first agent;
- all agents stop before first worktree deletion;
- successful DB deletion cascades steps/messages/raw messages;
- normal linked agent task with same `pullRequestId` is never selected;
- delete current selects only route task;
- delete all selects all and only `type === 'pr-review'` for project/PR;
- repeated delete is idempotent;
- lifecycle lock serializes deletion against workspace creation and command start.

**Step 2: Run test and verify failure**

Run: `pnpm test -- electron/services/pr-workspace-deletion-service.test.ts`

Expected: FAIL because service does not exist and current cleanup does not stop agents.

**Step 3: Implement phase-based deletion**

Under `withPrLifecycleLock`:

1. Re-fetch authoritative target tasks and all child steps.
2. Stop commands for every target; treat `false` as failure.
3. Stop each running step through `AgentService.stop(stepId)` and await completion.
4. Close editor windows.
5. Clean each worktree and local branch using verified cleanup identity from migration `075`.
6. If every external cleanup succeeds, delete task rows and emit `task.delete` with captured step IDs.

Do not delete tasks one-by-one while another target still has running processes. Do not clear cleanup identity before verified Git cleanup. If one Git cleanup fails after another succeeds, keep all task records; update successfully cleaned task metadata so retry does not target an already removed path.

**Step 4: Expose atomic APIs**

```ts
deletePrWorkspaceTask(params: { taskId: string }): Promise<void>
deleteAllPrWorkspaces(params: {
  projectId: string;
  pullRequestId: number;
}): Promise<void>
resolveClosedPrWorkspace(params: {
  projectId: string;
  pullRequestId: number;
  action: 'keep' | 'delete';
}): Promise<void>
```

`keep` validates pending state, changes all pending workspace tasks to `kept`, emits upserts, and performs no stop/cleanup/completion operation. `delete` delegates to delete-all service.

Route existing PR-review `tasks:delete` through delete-current service. Keep non-PR deletion behavior unchanged except shared safety fixes proven necessary by existing tests.

**Step 5: Run focused tests**

Run: `pnpm test -- electron/services/pr-workspace-deletion-service.test.ts electron/services/task-worktree-cleanup-service.test.ts electron/services/pr-review-task-service.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add electron/services/pr-workspace-deletion-service.ts electron/services/pr-workspace-deletion-service.test.ts electron/services/task-worktree-cleanup-service.ts electron/services/task-worktree-cleanup-service.test.ts electron/services/pr-review-task-service.ts electron/services/pr-review-task-service.test.ts electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts
git commit -m "feat(pr): safely delete workspace tasks"
```

### Task 7: Add Global Closed-PR Workspace Decision Modal

**Files:**
- Create: `src/hooks/use-pr-workspace-decisions.ts`
- Create: `src/features/pull-request/ui-closed-pr-workspace-modal/index.tsx`
- Create: `src/features/pull-request/ui-closed-pr-workspace-modal/index.test.tsx`
- Modify: `src/routes/__root.tsx`
- Modify: `src/cache/cache-events.ts`

**Step 1: Write modal lifecycle tests**

Using happy-dom, QueryClient, and mocked API, test:

- one pending decision opens modal globally;
- duplicate task/upsert/feed/detail observations for same project/PR produce one prompt;
- multiple PR decisions queue deterministically;
- restart/remount reloads pending decision from backend;
- Keep calls one atomic API and closes only after success;
- Keep leaves task/worktree controls available after query refresh;
- Delete all calls one atomic API and closes only after success;
- mutation failure retains modal and enables retry;
- active/reactivated state removes stale pending modal;
- deleted tasks are removed from task cache and next queued decision opens.

**Step 2: Run test and verify failure**

Run: `pnpm test -- src/features/pull-request/ui-closed-pr-workspace-modal/index.test.tsx`

Expected: FAIL because hook/component do not exist.

**Step 3: Implement backend-authoritative queue**

`usePrWorkspaceDecisions` queries `listPendingPrWorkspaceDecisions`. Key queue entries by `${projectId}:${pullRequestId}`. Task cache events invalidate decision query when a PR Workspace task changes or is deleted.

Do not use renderer-only acknowledgement state. Persistence comes from `prWorkspaceState`.

**Step 4: Build modal and mount once**

Mount `ClosedPrWorkspaceModal` in `RootLayout`. Copy should clearly distinguish:

- **Keep workspace**: retains workspace and all activity; no automatic cleanup.
- **Delete all**: stops workspace activity and permanently removes all PR Workspace tasks, histories, worktrees, and local branches for this PR.

Disable both buttons while mutation runs. Keep modal open on error and show toast/error text.

**Step 5: Run focused tests**

Run: `pnpm test -- src/features/pull-request/ui-closed-pr-workspace-modal/index.test.tsx src/cache/cache-events.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/hooks/use-pr-workspace-decisions.ts src/features/pull-request/ui-closed-pr-workspace-modal/index.tsx src/features/pull-request/ui-closed-pr-workspace-modal/index.test.tsx src/routes/__root.tsx src/cache/cache-events.ts
git commit -m "feat(pr): prompt before closed workspace cleanup"
```

### Task 8: Build Dedicated Zero-Step PR Workspace UI

**Files:**
- Create: `src/features/task/ui-pr-workspace-empty-state/index.tsx`
- Create: `src/features/task/ui-pr-workspace-empty-state/index.test.tsx`
- Modify: `src/features/task/ui-task-panel/index.tsx`
- Modify: `src/features/task/ui-task-panel/add-step-dialog.tsx`
- Modify: `src/features/agent/ui-run-button/index.tsx`
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx`

**Step 1: Write zero-state tests**

Test:

- `pr-review` task with zero steps renders `PR Workspace`, not Prompt/Reload/No messages;
- visible Add Step opens existing `AddStepDialog`;
- first submission creates generic `agent` step with `sortOrder: 0`, `{}` session rules, selected backend/model/mode, and expected auto-start setting;
- created step becomes active and normal message UI replaces zero-state;
- Continue preset is hidden/disabled when no prior usable step exists;
- configured project commands render existing `RunButton` and logs access;
- no configured commands renders configuration hint instead of disappearing;
- generic zero-step non-PR task retains existing behavior.

**Step 2: Run test and verify failure**

Run: `pnpm test -- src/features/task/ui-pr-workspace-empty-state/index.test.tsx`

Expected: FAIL because component does not exist.

**Step 3: Implement explicit TaskPanel branch**

Before generic message stream rendering:

```tsx
const isEmptyPrWorkspace =
  task.type === 'pr-review' && steps !== undefined && steps.length === 0;
```

Render dedicated state with workspace readiness, Add Step, command controls/log access, and PR navigation. Reuse `handleAddStep`, `RunButton`, and command logs pane; do not duplicate command orchestration.

**Step 4: Add no-command fallback**

Give `RunButton` an optional empty fallback/render prop, or expose minimal empty-state signal without moving process logic out. Show:

```text
No project commands configured. Add commands in Project Settings to run this workspace.
```

Historical logs remain reachable even if command configuration was later removed.

**Step 5: Run focused tests**

Run: `pnpm test -- src/features/task/ui-pr-workspace-empty-state/index.test.tsx src/features/pull-request/ui-pr-run-control/index.test.ts src/lib/run-command-items.test.ts`

Expected: PASS; PR detail run control remains unchanged.

**Step 6: Commit**

```bash
git add src/features/task/ui-pr-workspace-empty-state/index.tsx src/features/task/ui-pr-workspace-empty-state/index.test.tsx src/features/task/ui-task-panel/index.tsx src/features/task/ui-task-panel/add-step-dialog.tsx src/features/agent/ui-run-button/index.tsx src/features/task/ui-task-panel/command-logs-pane/index.tsx
git commit -m "feat(pr): add zero-step workspace experience"
```

### Task 9: Show Active-Step Permissions and Workspace Identity

**Files:**
- Modify: `src/features/task/ui-task-panel/index.tsx`
- Modify: `src/features/task/ui-task-panel/task-settings-pane.tsx`
- Create: `src/features/task/ui-task-panel/task-settings-pane.test.tsx`
- Modify: `src/features/agent/ui-add-permission-modal/index.tsx`
- Create: `src/features/agent/ui-add-permission-modal/index.test.tsx`
- Modify: `src/features/feed/ui-feed-list/feed-item-card.tsx`
- Create: `src/features/feed/ui-feed-list/feed-item-card.test.tsx`

**Step 1: Write settings and badge tests**

Assert:

- settings displays active step rules, not task data;
- changing active step immediately changes displayed permissions;
- zero-step workspace explains that adding a step creates a session;
- PR chat rules are visible but read-only;
- generic step rules can add/remove Session entries;
- project/worktree/global scopes still call their matching step-aware APIs;
- all-feed `pr-review` item shows `PR Workspace` badge;
- project task lists and ordinary linked tasks do not gain badge.

**Step 2: Run tests and verify failure**

Run: `pnpm test -- src/features/task/ui-task-panel/task-settings-pane.test.tsx src/features/agent/ui-add-permission-modal/index.test.tsx src/features/feed/ui-feed-list/feed-item-card.test.tsx`

Expected: FAIL against task-scoped settings and missing badge.

**Step 3: Bind settings to active step**

Pass `activeStep?.sessionRules ?? {}` and `activeStep?.id`. Rename UI section to **Active Session Permissions** and show active step name. Do not create fallback rules for no active step.

Add Session scope to Add Permission modal. It calls `steps.addSessionAllowedTool`; other scopes call step-aware project/worktree/global mutations. Disable editing for `pr-review-chat` steps.

**Step 4: Add all-feed-only badge**

Render badge in `FeedItemCard` when `item.taskType === 'pr-review'`. Do not change shared task title or PR carousel partition logic.

**Step 5: Run focused tests**

Run: `pnpm test -- src/features/task/ui-task-panel/task-settings-pane.test.tsx src/features/agent/ui-add-permission-modal/index.test.tsx src/features/feed/ui-feed-list/feed-item-card.test.tsx src/lib/use-feed-partition.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/features/task/ui-task-panel/index.tsx src/features/task/ui-task-panel/task-settings-pane.tsx src/features/task/ui-task-panel/task-settings-pane.test.tsx src/features/agent/ui-add-permission-modal/index.tsx src/features/agent/ui-add-permission-modal/index.test.tsx src/features/feed/ui-feed-list/feed-item-card.tsx src/features/feed/ui-feed-list/feed-item-card.test.tsx
git commit -m "feat(pr): expose workspace session identity"
```

### Task 10: Wire Manual Delete Actions and Route-Aware Navigation

**Files:**
- Create: `src/hooks/use-pr-workspace-actions.ts`
- Create: `src/features/pull-request/ui-delete-pr-workspace-dialog/index.tsx`
- Create: `src/features/pull-request/ui-delete-pr-workspace-dialog/index.test.tsx`
- Modify: `src/features/pull-request/ui-pr-detail/index.tsx`
- Modify: `src/features/pull-request/ui-pr-header/index.tsx`
- Modify: `src/features/task/ui-task-panel/index.tsx`
- Modify: `src/features/task/ui-task-panel/delete-task-dialog.tsx`

**Step 1: Write action and navigation tests**

Cover:

- PR details action says **Delete PR Workspaces** and calls delete-all for project/PR;
- task workspace action says **Delete PR Workspace** and calls delete-current task;
- normal task delete path remains unchanged;
- all-feed workspace route redirects to `/all/prs/$projectId/$prId` after successful delete;
- project workspace route redirects to `/projects/$projectId/prs/$prId` after successful delete;
- mutation failure remains on current route and exposes retry;
- navigation happens after backend success, not before;
- deletion removes task cache entries and stale running-command overlay targets.

**Step 2: Run tests and verify failure**

Run: `pnpm test -- src/features/pull-request/ui-delete-pr-workspace-dialog/index.test.tsx`

Expected: FAIL because shared dialog/actions do not exist.

**Step 3: Implement shared mutations and confirmation**

Use atomic backend APIs only. Confirmation must state that task history, steps/messages, worktrees, local branches, agents, and commands will be removed. PR details delete-all affects all PR Workspace tasks for that PR; task route deletes current workspace only.

Do not route these actions through generic `useDeleteWorktree`; approved semantics delete task records too.

**Step 4: Implement route-family redirect**

Use current TanStack Router route context/path matching. Navigate only in mutation success callback. If matching PR detail route cannot be formed, fall back to project root for project route and `/all` for all-feed route.

**Step 5: Run focused tests**

Run: `pnpm test -- src/features/pull-request/ui-delete-pr-workspace-dialog/index.test.tsx src/hooks/use-tasks.test.ts src/stores/overlays.test.ts`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/hooks/use-pr-workspace-actions.ts src/features/pull-request/ui-delete-pr-workspace-dialog/index.tsx src/features/pull-request/ui-delete-pr-workspace-dialog/index.test.tsx src/features/pull-request/ui-pr-detail/index.tsx src/features/pull-request/ui-pr-header/index.tsx src/features/task/ui-task-panel/index.tsx src/features/task/ui-task-panel/delete-task-dialog.tsx
git commit -m "feat(pr): add workspace deletion controls"
```

### Task 11: Verify Integrated Behavior

**Files:**
- Review all modified files

**Step 1: Run focused integration suite**

Run:

```bash
pnpm test -- electron/database/migrations/078_pr_workspace_support.test.ts electron/services/step-permission-service.test.ts electron/services/agent-service.test.ts electron/services/pr-review-agent-service.test.ts electron/services/pr-review-task-service.test.ts electron/services/pr-workspace-deletion-service.test.ts electron/services/feed-service.test.ts src/features/pull-request/ui-closed-pr-workspace-modal/index.test.tsx src/features/task/ui-pr-workspace-empty-state/index.test.tsx src/features/task/ui-task-panel/task-settings-pane.test.tsx src/features/feed/ui-feed-list/feed-item-card.test.tsx
```

Expected: PASS.

**Step 2: Install dependencies**

Run: `pnpm install`

Expected: successful install; no unintended lockfile change.

**Step 3: Run full tests**

Run: `pnpm test`

Expected: PASS.

**Step 4: Auto-fix lint**

Run: `pnpm lint --fix`

Expected: completes successfully; inspect every formatting change.

**Step 5: Run TypeScript checks**

Run: `pnpm ts-check`

Expected: PASS.

**Step 6: Run final lint**

Run: `pnpm lint`

Expected: PASS.

**Step 7: Review migration and lifecycle invariants**

Run: `git diff --check && git status --short`

Confirm:

- migrations `076` and `077` follow current `075` and preserve all rows/FKs;
- no task-level `sessionRules` references remain;
- Allow once has no persistence call;
- generic PR Workspace steps run with their own rules;
- PR chat steps remain read-only and unmodifiable;
- closed detection performs no cleanup;
- Keep performs no stop, completion, or cleanup;
- Delete all never selects normal linked agent tasks;
- all commands and agents stop before first worktree deletion;
- DB rows remain when cleanup fails;
- zero-step PR Workspace never renders message-loading failure UI;
- no changelog files changed.

**Step 8: Request code review**

Use `@requesting-code-review` against full branch diff. Focus review on migration data safety, permission isolation, process-stop ordering, decision persistence, and route behavior. Fix findings and rerun affected focused tests plus full checks.

**Step 9: Commit review fixes if needed**

```bash
git add <only-files-changed-by-review-fixes>
git commit -m "fix(pr): address workspace redesign review"
```
