# PR Project Launch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users create or reuse a PR review workspace and run any saved project command or command group directly from active PR details.

**Architecture:** Add task-scoped `startPrCommand` IPC orchestration that validates PR and command ownership, serializes work by project/PR, resolves backend-owned worktree path, resets logs, then starts selected command. Add stateful split control in PR header, backed by existing command status/log/port infrastructure. Extend closed-PR lifecycle to stop commands and force-delete review worktree plus local branch.

**Tech Stack:** Electron IPC, TypeScript, React 19, TanStack Query, Zustand, Kysely, Vitest, node-pty

---

### Task 1: Add Command Group Lookup

**Files:**
- Modify: `electron/database/repositories/project-command-groups.ts:25-39`
- Test: `electron/database/repositories/project-command-groups.test.ts`

**Step 1: Write failing repository test**

Add test matching `ProjectCommandRepository.findById` behavior:

```ts
it('finds and parses a command group by id', async () => {
  const group = await ProjectCommandGroupRepository.create({
    projectId,
    name: 'Full stack',
    commandIds: ['web', 'api'],
  });

  await expect(ProjectCommandGroupRepository.findById(group.id)).resolves.toEqual(group);
  await expect(ProjectCommandGroupRepository.findById('missing')).resolves.toBeUndefined();
});
```

Mock Kysely chain through `vi.mock('../index')`, following `electron/database/repositories/settings.test.ts`. Assert `where('id', '=', groupId)`, parsed `commandIds`, and missing-row result.

**Step 2: Run focused test and verify failure**

Run: `pnpm test -- electron/database/repositories/project-command-groups.test.ts`

Expected: FAIL because `findById` does not exist.

**Step 3: Implement lookup**

Add before `create`:

```ts
findById: async (id: string): Promise<ProjectCommandGroup | undefined> => {
  const row = await db
    .selectFrom('project_command_groups')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? parseRow(row) : undefined;
},
```

**Step 4: Run focused test**

Run: `pnpm test -- electron/database/repositories/project-command-groups.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add electron/database/repositories/project-command-groups.ts electron/database/repositories/project-command-groups.test.ts
git commit -m "feat(run-commands): add command group lookup"
```

### Task 2: Add Serialized PR Command Orchestration

**Files:**
- Modify: `electron/services/pr-review-task-service.ts:47-248`
- Modify: `electron/services/pr-review-task-service.test.ts:41-267`
- Modify: `electron/services/run-command-service.ts:833-1000`
- Create: `electron/services/run-command-service.test.ts`
- Modify: `shared/run-command-types.ts:106-171`

**Step 1: Add shared request/result types**

Add types without importing `Task` into run-command types:

```ts
export type PrRunTarget =
  | { type: 'command'; id: string }
  | { type: 'group'; id: string };

export interface StartPrCommandParams {
  projectId: string;
  pullRequestId: number;
  target: PrRunTarget;
}
```

Keep API result typing in `src/lib/api.ts`, where `Task`, `RunStatus`, and `PortsInUseErrorData` already coexist.

**Step 2: Write failing orchestration tests**

Extend `electron/services/pr-review-task-service.test.ts` with injected dependencies and cases:

```ts
describe('startPrCommand', () => {
  it('creates a workspace and starts an owned command with backend-derived context', async () => {
    const task = makeTask();
    const deps = makeStartDeps({
      createOrGetTask: vi.fn().mockResolvedValue({ task, created: true }),
    });

    await startPrCommand(
      {
        projectId: 'project-1',
        pullRequestId: 12,
        target: { type: 'command', id: 'web' },
      },
      deps,
    );

    expect(deps.resetLogs).toHaveBeenCalledWith(task.id, ['web']);
    expect(deps.startCommand).toHaveBeenCalledWith({
      taskId: task.id,
      projectId: task.projectId,
      workingDir: task.worktreePath,
      runCommandId: 'web',
    });
  });
});
```

Add cases:

- Existing review task/worktree reused.
- Active PR required; completed and abandoned reject before workspace creation.
- Missing or foreign command rejects before workspace creation.
- Group ID resolves saved group server-side.
- Empty group rejects.
- Missing or foreign group member rejects entire group.
- Group IDs deduplicated while retaining order.
- Existing process fully stops, then log reset broadcasts, then new process spawns.
- Port conflict returns `{ task, runResult }`, retaining created workspace.
- Two concurrent starts for same project/PR serialize and create one workspace.
- Different PR keys can proceed independently.
- Lock recovers after rejected operation.

Use deferred promises in concurrency tests; do not use timing sleeps.

**Step 3: Run focused tests and verify failure**

Run: `pnpm test -- electron/services/pr-review-task-service.test.ts`

Expected: FAIL because `startPrCommand` and dependency types do not exist.

**Step 4: Add keyed lifecycle lock**

Use module-level non-poisoning promise queues:

```ts
const prLifecycleLocks = new Map<string, Promise<void>>();

function withPrLifecycleLock<T>(
  projectId: string,
  pullRequestId: number | string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${projectId}:${pullRequestId}`;
  const previous = prLifecycleLocks.get(key) ?? Promise.resolve();
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const next = previous.then(async () => {
    try {
      resolve(await operation());
    } catch (error) {
      reject(error);
    }
  });
  prLifecycleLocks.set(key, next);
  void next.then(() => {
    if (prLifecycleLocks.get(key) === next) prLifecycleLocks.delete(key);
  });
  return result;
}
```

Keep this aligned with proven queue cleanup pattern in `electron/services/worktree-service.ts:1474-1518`.

Split existing creation into unlocked core plus locked export so `createPrReviewTask`, launch, and cleanup share same key:

```ts
async function createOrGetPrReviewTaskUnlocked(...) { ... }

export function createOrGetPrReviewTask(params, deps) {
  return withPrLifecycleLock(params.projectId, params.pullRequestId, () =>
    createOrGetPrReviewTaskUnlocked(params, deps),
  );
}
```

Inside `startPrCommand`, call unlocked core while lock is already held to avoid deadlock.

**Step 5: Implement `startPrCommand`**

Define injected dependencies for project/PR lookup, command/group lookup, task creation, log reset, and start calls. Under lock:

1. Resolve project and repository IDs.
2. Fetch PR and require `status === 'active'`.
3. Resolve target and require every command belongs to `projectId`.
4. Create/reuse review task.
5. Require non-null `task.worktreePath`.
6. Call `startCommand` for command target or `startGroup` for group target with backend-only `afterStop` callback.
7. `RunCommandService` awaits full stop, invokes `afterStop` to reset/broadcast logs, then checks ports and spawns. This prevents shutdown output from polluting fresh logs.
8. Return `{ task, created, runResult }` for success and port conflict.

Use target group ID, not renderer-provided command IDs. This prevents stale/tampered group membership.

Add optional internal callback to run service methods, not renderer IPC contracts:

```ts
type StartOptions = { afterStop?: () => void | Promise<void> };
```

Invoke once after `stopCommandWithoutLock` for a command, and once after all group members finish stopping. Add run-command service tests proving stop output completes before callback and spawn occurs after callback. Keep existing callers unchanged when callback omitted.

**Step 6: Run focused tests**

Run: `pnpm test -- electron/services/pr-review-task-service.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add shared/run-command-types.ts electron/services/pr-review-task-service.ts electron/services/pr-review-task-service.test.ts electron/services/run-command-service.ts electron/services/run-command-service.test.ts
git commit -m "feat(pr): orchestrate project launch"
```

### Task 3: Make Closed PR Cleanup Safe and Automatic

**Files:**
- Modify: `electron/services/pr-review-task-service.ts:83-112,250-283`
- Modify: `electron/services/pr-review-task-service.test.ts:269-397`
- Modify: `electron/services/feed-service.ts:542-580`
- Modify: `electron/services/feed-service.test.ts`
- Modify: `electron/ipc/handlers.ts:3068-3100,3600-3635`
- Modify: `src/features/pull-request/ui-pr-detail/index.tsx:447-467`

**Step 1: Replace merged-only tests with closed lifecycle tests**

Rename `completePrReviewTasksForMergedPr` tests to `completePrReviewTasksForClosedPr`. Inject dependencies for:

```ts
stopCommandsForTask
findProjectById
closeEditorWindowsForTaskWorktree
cleanupWorktree
cleanupMissingWorktree
updateTask
updateTaskStatus
markUserCompleted
compactRawMessages
emitTaskUpsert
```

Add ordering assertion:

```ts
expect(invocationOrder).toEqual([
  'stop',
  'close-editor',
  'cleanup-worktree',
  'clear-worktree-fields',
  'complete',
]);
```

Cover:

- `force: true` and `branchCleanup: 'delete'`.
- Missing worktree path still stops commands and completes task.
- Missing on-disk worktree uses `cleanupMissingWorktree` and deletes branch.
- Cleanup failure leaves task worktree fields and completion state unchanged for retry.
- Already completed task still stops commands and cleans remaining workspace.
- Regular agent tasks remain untouched.
- Repeated cleanup is idempotent.

**Step 2: Run service tests and verify failure**

Run: `pnpm test -- electron/services/pr-review-task-service.test.ts`

Expected: FAIL against merged-only completion implementation.

**Step 3: Implement closed lifecycle cleanup**

Rename helper and run it under same project/PR lifecycle lock. For each review task:

1. Stop task commands.
2. Close editor windows.
3. Force-clean worktree and delete branch when metadata exists.
4. Clear `worktreePath`, `branchName`, `startCommitHash`, `sourceBranch` only after successful Git cleanup.
5. Mark task completed/user-completed and compact messages using existing idempotency rules.
6. Emit final task state.

Do not skip already-completed tasks before cleanup.

Add exported `cleanPrReviewWorkspace({ projectId, pullRequestId, taskId }, deps)` using same lifecycle lock and same stop/editor/Git/metadata-clear ordering without completing active task. This gives manual cleanup same serialization as start and automatic cleanup.

Inside acquired lock, re-fetch task by `taskId` and validate `type`, `projectId`, `pullRequestId`, and current worktree metadata. Never use handler snapshot captured before lock.

**Step 4: Expand PR status triggers**

In both PR detail fetch and feed status refresh, replace completed-only condition:

```ts
if (pullRequest.status !== 'active') {
  try {
    await completePrReviewTasksForClosedPr(...);
  } catch (error) {
    dbg.ipc('Failed to clean closed PR workspace: %O', error);
  }
}
```

Cleanup failure must not reject valid PR detail/status loading. Leave worktree metadata intact so next closed-status detection retries. In feed processing, isolate cleanup failure per entry so one failed workspace does not abort remaining statuses.

Update `electron/services/feed-service.test.ts`:

- Completed invokes cleanup.
- Abandoned invokes cleanup.
- Active does not invoke cleanup.

Run: `pnpm test -- electron/services/feed-service.test.ts electron/services/pr-review-task-service.test.ts`

Expected: PASS.

**Step 5: Fix manual cleanup root cause**

Current `tasks:worktree:delete` removes cwd without stopping task commands. For `pr-review` tasks with `pullRequestId`, route handler through `cleanPrReviewWorkspace` so manual cleanup shares project/PR lock with launch and automatic cleanup. For every other task type, add before editor/Git cleanup:

```ts
await runCommandService.stopCommandsForTask(taskId);
```

Change PR manual clean call to delete branch per validated behavior:

```ts
await deleteWorktree.mutateAsync({ taskId: associatedPrReviewTask.id });
```

Do not pass `keepBranch: true`.

Add service tests proving manual cleanup serializes against start, stops commands before deleting cwd, deletes branch, and recovers after cleanup failure.

Also add start-versus-automatic-cleanup and start-versus-manual-cleanup deferred-promise tests here, after all locked lifecycle operations exist.

**Step 6: Run focused tests**

Run: `pnpm test -- electron/services/pr-review-task-service.test.ts electron/services/feed-service.test.ts src/hooks/use-tasks.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add electron/services/pr-review-task-service.ts electron/services/pr-review-task-service.test.ts electron/services/feed-service.ts electron/services/feed-service.test.ts electron/ipc/handlers.ts src/features/pull-request/ui-pr-detail/index.tsx
git commit -m "fix(pr): clean closed review workspaces"
```

### Task 4: Wire Secure Launch IPC and Log Reset Broadcast

**Files:**
- Modify: `src/lib/api.ts:503-656,1870-1898`
- Modify: `electron/preload.ts:253-264`
- Modify: `electron/ipc/handlers.ts:299-308,1639-1667,4536-4590`

**Step 1: Add typed renderer API**

Import `StartPrCommandParams`, `RunStatus`, and `PortsInUseErrorData`. Add:

```ts
startPrCommand: (
  params: StartPrCommandParams,
) => Promise<{
  task: Task;
  created: boolean;
  runResult: RunStatus | PortsInUseErrorData;
}>;
```

Add unavailable-API fallback in same section as `createPrReviewTask`.

**Step 2: Add preload bridge**

```ts
startPrCommand: (params: StartPrCommandParams) =>
  ipcRenderer.invoke('tasks:startPrCommand', params),
```

**Step 3: Extract log-reset broadcaster in handler registration scope**

Move existing reset + `BrowserWindow` broadcast body into local helper:

```ts
const resetRunCommandLogs = (taskId: string, runCommandIds: string[]) => {
  for (const runCommandId of runCommandIds) {
    const generation = runCommandService.resetLogs({
      taskId,
      runCommandId,
      generation: 0,
    });
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(
          'project:commands:run:logsReset',
          taskId,
          runCommandId,
          generation,
        );
      }
    }
  }
};
```

Keep generic `resetLogs` IPC behavior unchanged by calling same helper or a single-command variant. Broadcast must happen before launch so renderer clears stale logs before first output.

**Step 4: Register `tasks:startPrCommand`**

Place beside `tasks:createPrReviewTask`. Supply repositories/services as dependencies:

- `ProjectRepository.findById`
- Azure `getPullRequest`
- `ProjectCommandRepository.findById`
- `ProjectCommandGroupRepository.findById`
- existing PR task creation dependencies
- extracted reset broadcaster
- `runCommandService.startCommand`
- `runCommandService.startGroup`

Do not accept renderer `taskId`, `workingDir`, or group command IDs.

**Step 5: Type-check bridge**

Run: `pnpm ts-check`

Expected: PASS.

**Step 6: Commit**

```bash
git add src/lib/api.ts electron/preload.ts electron/ipc/handlers.ts
git commit -m "feat(pr): expose secure project launch IPC"
```

### Task 5: Extract Shared Run Item Semantics

**Files:**
- Create: `src/lib/run-command-items.ts`
- Create: `src/lib/run-command-items.test.ts`
- Modify: `src/features/agent/ui-run-button/index.tsx:73-219,255-314`

**Step 1: Write pure helper tests**

Cover:

- Commands and groups sorted together by `sortOrder`, then `createdAt`.
- Group resolves saved command IDs in group order.
- Deleted command IDs are excluded.
- Empty group resolves disabled.
- Command confirmation uses display name/message.
- Group confirmation aggregates configured messages and falls back to group summary.
- Running group action stops only currently running members.

Suggested API:

```ts
export type RunCommandItem =
  | { type: 'command'; item: ProjectCommand }
  | { type: 'group'; item: ProjectCommandGroup };

export function buildRunCommandItems(...): RunCommandItem[];
export function resolveRunCommandIds(...): string[];
export function getRunConfirmation(...): {
  label: string;
  message: string | null;
} | null;
```

**Step 2: Run helper tests and verify failure**

Run: `pnpm test -- src/lib/run-command-items.test.ts`

Expected: FAIL because helper does not exist.

**Step 3: Implement helpers and refactor existing button**

Move only pure sorting/resolution/confirmation logic. Keep process actions and component state in `RunButton`. Preserve current task-detail behavior exactly.

**Step 4: Run tests**

Run: `pnpm test -- src/lib/run-command-items.test.ts`

Expected: PASS.

Run: `pnpm ts-check`

Expected: PASS, proving existing `RunButton` still compiles against shared helpers.

**Step 5: Commit**

```bash
git add src/lib/run-command-items.ts src/lib/run-command-items.test.ts src/features/agent/ui-run-button/index.tsx
git commit -m "refactor(run-commands): share picker semantics"
```

### Task 6: Build PR Stateful Split Run Control

**Files:**
- Create: `src/features/pull-request/ui-pr-run-control/index.tsx`
- Create: `src/features/pull-request/ui-pr-run-control/index.test.tsx`
- Modify: `src/features/pull-request/ui-pr-header/index.tsx:92-125,255-294`
- Modify: `src/stores/overlays.ts:6-46`
- Modify: `src/features/run-commands/ui-running-commands-overlay/index.tsx:36-99`
- Test: `src/stores/overlays.test.ts`

**Step 1: Write visibility and picker tests**

Use `// @vitest-environment happy-dom`, `createRoot`, `flushSync`, `QueryClientProvider`, API spies, and `RootKeyboardBindings`, following `src/features/pull-request/ui-pr-review-agent-chat-card/index.test.ts`.

Test:

- Hidden for read-only, completed, abandoned, and zero configured items.
- Visible for active writable PR with command or group.
- Picker renders shared sorted items.
- Existing **Create Review Workspace** action remains visible.

Run: `pnpm test -- src/features/pull-request/ui-pr-run-control/index.test.tsx`

Expected: FAIL because component does not exist.

**Step 2: Add interaction tests**

Test state machine:

```text
idle -> confirming? -> preparing -> running -> view logs
                    \-> port conflict -> retry -> running
                    \-> error -> idle + toast
```

Cover:

- Idle primary/caret opens picker.
- Confirmation appears before `tasks.startPrCommand`.
- Cancel creates no workspace.
- Start sends command/group target ID, project ID, and PR ID only.
- Preparing state disables duplicate launch.
- Success stores returned review task/status and opens `running-commands` overlay focused on launched task/command.
- Port conflict does not open overlay.
- Retry kills unique conflicting ports, then calls `tasks.startPrCommand` again so retry shares PR lock and revalidates/recreates workspace if cleanup raced it.
- Running primary opens logs.
- Picker row shows Run/Stop/busy state.
- Running command/group stops through existing API.
- Failed start/stop displays toast and clears busy state.
- Incoming status events update running state.
- Associated review task prop updates replace stale local task state after cleanup or restoration.
- Activity job tracks every PR project preparation, succeeds with returned task ID and `created` flag, and fails with launch error.

Reset overlay, toast, and task-message stores after each test.

**Step 3: Implement component**

Use:

- `useProjectCommands(projectId)`
- `useProjectCommandGroups(projectId)`
- shared run item helpers
- `ConfirmRunModal`
- `KillPortsModal`
- `api.tasks.startPrCommand`
- `api.runCommands.getStatus`, `onStatusChange`, `stopCommand`, `killPortsForCommand`
- `useOverlaysStore((state) => state.open)`
- `useBackgroundJobsStore` for `pr-review-creation`
- `useToastStore`

Keep resolved runtime task in component state, seeded from associated review task. Reconcile state whenever associated task ID or worktree path changes so manual/automatic cleanup cannot leave stale runtime context. On initial existing task, fetch status and subscribe by task ID. On new launch result, update task/status immediately; do not wait for query invalidation.

For activity tracking, call `addRunningJob` before every launch attempt with title `Preparing project for PR #${pullRequestId}`. On success call `markJobSucceeded(jobId, { taskId: task.id, projectId, created })`; on error call `markJobFailed`. This tracks authoritative launch preparation without guessing workspace state from stale renderer cache.

Extend overlay store with optional target:

```ts
runningCommandTarget: { taskId: string; runCommandId: string } | null;
openRunningCommands: (target: { taskId: string; runCommandId: string }) => void;
clearRunningCommandTarget: () => void;
```

`openRunningCommands` sets target and opens `running-commands` atomically. While target exists, overlay includes that command even if it exits quickly; other entries remain running-only. Overlay initializes/reconciles `selectedKey` from target and clears target only when overlay closes. Existing global overlay callers keep using `open('running-commands')`. For groups, focus first selected command ID; all running group members remain listed.

Use split behavior:

```text
Idle:     [Start project | v]
Starting: [Preparing workspace...]
Running:  [View logs | v]
```

Caret always opens picker. Running main segment opens logs. Picker supports Run/Stop per item.

**Step 4: Run component tests**

Run: `pnpm test -- src/features/pull-request/ui-pr-run-control/index.test.tsx`

Expected: PASS.

**Step 5: Mount in PR header**

Pass minimum data into control:

```tsx
<PrRunControl
  projectId={projectId}
  pullRequestId={pr.id}
  status={pr.status}
  readOnly={readOnly}
/>
```

Component discovers associated PR task from existing project task query or receives it from `PrDetail`; prefer passing `associatedPrReviewTask` from `src/features/pull-request/ui-pr-detail/index.tsx:218-247,619-637` to avoid duplicate task scanning.

Place between **New Task** and **Create Review Workspace**.

**Step 6: Run focused renderer tests**

Run: `pnpm test -- src/features/pull-request/ui-pr-run-control/index.test.tsx src/lib/run-command-items.test.ts`

Expected: PASS.

**Step 7: Commit**

```bash
git add src/features/pull-request/ui-pr-run-control/index.tsx src/features/pull-request/ui-pr-run-control/index.test.tsx src/features/pull-request/ui-pr-header/index.tsx src/features/pull-request/ui-pr-detail/index.tsx
git commit -m "feat(pr): add project launch control"
```

### Task 7: Verify Full Change

**Files:**
- Review all modified files

**Step 1: Install dependencies**

Run: `pnpm install`

Expected: successful install; no unintended lockfile change.

**Step 2: Run full tests**

Run: `pnpm test`

Expected: PASS.

**Step 3: Auto-fix lint**

Run: `pnpm lint --fix`

Expected: completes successfully; inspect formatting changes.

**Step 4: Run TypeScript checks**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Run final lint**

Run: `pnpm lint`

Expected: PASS.

**Step 6: Review diff and behavior**

Run: `git diff --check && git status --short`

Confirm:

- No migration or changelog changed.
- PR launch never accepts renderer-provided cwd.
- Closed cleanup stops commands before deleting cwd.
- Log reset broadcast occurs before command spawn.
- Existing task-detail Run button behavior remains unchanged.
- Manual and automatic cleanup delete local review branch as approved.

**Step 7: Request code review**

Use `@requesting-code-review` against full branch diff. Fix findings, then rerun affected focused tests plus full checks.

**Step 8: Commit verification fixes if needed**

```bash
git add <only-files-changed-by-review-fixes>
git commit -m "fix(pr): address project launch review"
```
