# PR Review Agent Chat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add on-demand, inline, read-only agent chats for reviewing other people’s PRs, backed by a PR-linked task and one agent session per selected-line thread.

**Architecture:** Reuse existing task/worktree/step infrastructure instead of adding a parallel chat system. Create one `pr-review` task per PR on first Ask Agent, then create one normal `agent` step per selected-line chat; follow-ups continue the same step/session. Store line-anchor metadata on step `meta`, render compact inline cards in PR diff, and enforce read-only permissions at agent start.

**Tech Stack:** Electron IPC, SQLite/Kysely, React 19, TanStack Query/cache, Zustand, existing agent backends, existing diff/comment UI.

---

## Current Context

- Existing `tasks:createPrReview` in `electron/ipc/handlers.ts:1588` creates a full preset review task with `review` + `pr-review` steps. This feature should not use that preset flow.
- Existing PR detail already loads associated task by `pullRequestId` in `src/features/pull-request/ui-pr-detail/index.tsx:201`, but only for `task.type === 'agent'`. This must include `pr-review` tasks.
- Existing diff selection uses `useLineRangeSelection` and calls `onAddCommentClick(range)`. Extend this into a selectable action popover instead of always opening comment composer.
- Existing messages are keyed by `stepId`; use that to render each inline chat.
- Existing worktree deletion is available via `api.tasks.worktree.delete(taskId)`.
- Existing `TaskType` does not include `pr-review`; add it.

## Naming

- Task type: `pr-review`
- Step type: keep `agent`
- Step meta: `PrReviewChatStepMeta`
- IPC namespace: add under `tasks` for task creation/reuse and under `steps` for chat steps/follow-ups.

---

### Task 1: Add Shared Types For PR Review Tasks And Chat Step Metadata

**Files:**
- Modify: `shared/types.ts:49-50`
- Modify: `shared/types.ts:455-518`
- Test: `shared/types.test.ts`

**Step 1: Write failing type/runtime guard test**

Add to `shared/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPrReviewChatStepMeta } from './types';

describe('pr review chat step meta', () => {
  it('recognizes anchored PR review chat metadata', () => {
    expect(
      isPrReviewChatStepMeta({
        kind: 'pr-review-chat',
        pullRequestId: 123,
        filePath: 'src/app.ts',
        lineStart: 10,
        lineEnd: 12,
        selectedText: 'const value = 1;',
      }),
    ).toBe(true);
  });

  it('rejects unrelated metadata', () => {
    expect(isPrReviewChatStepMeta({ pullRequestId: 123 })).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test shared/types.test.ts`

Expected: FAIL because `isPrReviewChatStepMeta` does not exist.

**Step 3: Update shared types**

In `shared/types.ts`, change:

```ts
export type TaskType = 'agent' | 'skill-creation' | 'feature-map';
```

to:

```ts
export type TaskType = 'agent' | 'skill-creation' | 'feature-map' | 'pr-review';
```

Add near existing `PrReviewStepMeta`:

```ts
/** Meta for agent steps created from inline PR review chats. */
export interface PrReviewChatStepMeta {
  kind: 'pr-review-chat';
  pullRequestId: number;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  selectedText: string;
}

export function isPrReviewChatStepMeta(
  meta: TaskStepMeta | null | undefined,
): meta is PrReviewChatStepMeta {
  if (!meta) return false;
  const m = meta as PrReviewChatStepMeta;
  return (
    m.kind === 'pr-review-chat' &&
    typeof m.pullRequestId === 'number' &&
    typeof m.filePath === 'string' &&
    typeof m.lineStart === 'number' &&
    (m.lineEnd === undefined || typeof m.lineEnd === 'number') &&
    typeof m.selectedText === 'string'
  );
}
```

Add `PrReviewChatStepMeta` to `TaskStepMeta` union.

**Step 4: Update schema comment only**

In `electron/database/schema.ts:127`, update comment:

```ts
type: Generated<string>; // TaskType: 'agent' (default) | 'skill-creation' | 'feature-map' | 'pr-review'
```

No migration needed because column is text and accepts new enum value.

**Step 5: Run test**

Run: `pnpm test shared/types.test.ts`

Expected: PASS.

---

### Task 2: Add PR Review Agent Settings

**Files:**
- Modify: `shared/settings-types.ts` or existing settings type file found by `SettingsRepository`
- Modify: `electron/database/repositories/settings.ts`
- Modify: `src/hooks/use-settings.ts`
- Modify: `src/features/settings/ui-general-settings/index.tsx`
- Test: `electron/database/repositories/settings.test.ts`

**Step 1: Locate settings schema**

Use `SettingsRepository.get('summaryModels')` and `SettingsRepository.get('backendDefaultModels')` examples. Add new setting key beside typed defaults.

**Step 2: Write failing repository test**

Add to `electron/database/repositories/settings.test.ts`:

```ts
it('returns default PR review agent setting', async () => {
  await expect(SettingsRepository.get('prReviewAgent')).resolves.toEqual({
    backend: null,
    modelPreference: 'default',
    thinkingEffort: 'default',
  });
});
```

**Step 3: Run test to verify it fails**

Run: `pnpm test electron/database/repositories/settings.test.ts`

Expected: FAIL because `prReviewAgent` key is unknown.

**Step 4: Add setting type/default**

Add type:

```ts
export interface PrReviewAgentSetting {
  backend: AgentBackendType | null;
  modelPreference: ModelPreference;
  thinkingEffort: ThinkingEffort;
}
```

Default:

```ts
prReviewAgent: {
  backend: null,
  modelPreference: 'default',
  thinkingEffort: 'default',
},
```

Meaning: `backend: null` uses project default backend.

**Step 5: Add hooks**

In `src/hooks/use-settings.ts`, add:

```ts
export function usePrReviewAgentSetting() {
  return useSetting('prReviewAgent');
}

export function useUpdatePrReviewAgentSetting() {
  return useUpdateSetting('prReviewAgent');
}
```

Adjust helper names to match existing file conventions.

**Step 6: Add Settings UI**

In `src/features/settings/ui-general-settings/index.tsx`, add section near model settings:

```tsx
<SettingsSection
  title="PR Review Agent"
  description="Default backend and model for Ask Agent in PR diffs."
>
  <ModelSelectionControl ... />
</SettingsSection>
```

Reuse existing backend/model controls from `SummaryModelsSettings` or backend default model settings; do not create new dropdown primitives.

**Step 7: Run tests**

Run: `pnpm test electron/database/repositories/settings.test.ts`

Expected: PASS.

---

### Task 3: Replace Preset PR Review Creation With Get-Or-Create Review Task

**Files:**
- Modify: `electron/ipc/handlers.ts:1588-1840`
- Modify: `src/lib/api.ts:639-645`
- Modify: `electron/preload.ts:260-266`
- Test: add `electron/ipc/pr-review-task.test.ts` or extend nearest IPC handler test if present

**Step 1: Extract helper shape in plan**

Create IPC handler behavior:

```ts
type CreatePrReviewTaskParams = {
  projectId: string;
  pullRequestId: number;
};
```

Return existing active/incomplete `type === 'pr-review'` task with same `projectId` + `pullRequestId` if present.

If not present:

- Load project and PR.
- Fetch PR source branch.
- Create worktree from `origin/<sourceBranch>` with fallback to local branch.
- Create task:

```ts
await createTaskAndEmit({
  projectId,
  type: 'pr-review',
  prompt: `Review PR #${pullRequestId}: ${pr.title}`,
  name: taskName,
  worktreePath,
  startCommitHash,
  branchName,
  sourceBranch,
  pullRequestId: String(pullRequestId),
  pullRequestUrl: pr.url ?? null,
  updatedAt: new Date().toISOString(),
  sessionRules: buildReadOnlyPrReviewSessionRules(),
});
```

Do not create preset `Review Changes` or `Submit Review` steps.

**Step 2: Write failing test**

Test behavior, not implementation details:

```ts
it('creates a pr-review task without default review steps', async () => {
  const task = await invokeCreatePrReviewTask({ projectId: 'p1', pullRequestId: 12 });

  expect(task.type).toBe('pr-review');
  expect(task.pullRequestId).toBe('12');
  await expect(TaskStepRepository.findByTaskId(task.id)).resolves.toEqual([]);
});
```

**Step 3: Run test to verify it fails**

Run targeted test command for new/extended test file.

Expected: FAIL because current handler creates two steps.

**Step 4: Implement minimal handler change**

Keep branch/worktree code from current handler. Delete reviewer config creation and both `StepService.create` calls. Delete auto-start. Add get-existing logic before worktree creation.

**Step 5: Update API names**

Prefer explicit name:

```ts
createPrReviewTask: (params: {
  projectId: string;
  pullRequestId: number;
}) => Promise<Task>;
```

Keep old `createPrReview` only if current header button still needs preset review during migration. If not used after Task 8, remove it.

**Step 6: Run test**

Expected: PASS.

---

### Task 4: Add Read-Only Session Rules Helper

**Files:**
- Create: `electron/services/pr-review-agent-service.ts`
- Test: `electron/services/pr-review-agent-service.test.ts`

**Step 1: Write failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildReadOnlyPrReviewSessionRules } from './pr-review-agent-service';

describe('buildReadOnlyPrReviewSessionRules', () => {
  it('allows read/search tools and blocks write/edit tools', () => {
    const rules = buildReadOnlyPrReviewSessionRules();
    expect(rules.read).toBe('allow');
    expect(rules.write).toBe('deny');
    expect(rules.edit).toBe('deny');
  });
});
```

Adjust assertions to actual `PermissionScope` shape in `shared/permission-types.ts`.

**Step 2: Run test to verify it fails**

Run: `pnpm test electron/services/pr-review-agent-service.test.ts`

Expected: FAIL missing file/export.

**Step 3: Implement helper**

```ts
import type { PermissionScope } from '@shared/permission-types';

export function buildReadOnlyPrReviewSessionRules(): PermissionScope {
  return {
    read: 'allow',
    write: 'deny',
    edit: 'deny',
  } satisfies PermissionScope;
}
```

If `PermissionScope` uses tool-name patterns instead, encode exact allowed tools and deny edit/write equivalents. Do not allow bare `Bash`; allow no Bash for MVP unless existing permission type requires explicit command allowlist.

**Step 4: Use helper in create task**

Import into `electron/ipc/handlers.ts`, use as `sessionRules` for `pr-review` task.

**Step 5: Run test**

Run: `pnpm test electron/services/pr-review-agent-service.test.ts`

Expected: PASS.

---

### Task 5: Add IPC For Creating Anchored Chat Steps

**Files:**
- Modify: `electron/ipc/handlers.ts` around steps handlers
- Modify: `src/lib/api.ts` steps namespace
- Modify: `electron/preload.ts` steps namespace
- Test: `electron/services/pr-review-agent-service.test.ts`

**Step 1: Add prompt builder test**

In `pr-review-agent-service.test.ts`:

```ts
import { buildPrReviewChatPrompt } from './pr-review-agent-service';

it('builds prompt with selected lines and file path', () => {
  const prompt = buildPrReviewChatPrompt({
    prTitle: 'Fix auth',
    pullRequestId: 12,
    filePath: 'src/auth.ts',
    lineStart: 4,
    lineEnd: 6,
    selectedText: 'return user.id;',
    question: 'Is this safe?',
  });

  expect(prompt).toContain('PR #12: Fix auth');
  expect(prompt).toContain('src/auth.ts:4-6');
  expect(prompt).toContain('return user.id;');
  expect(prompt).toContain('Is this safe?');
  expect(prompt).toContain('Do not modify files');
});
```

**Step 2: Implement prompt builder**

```ts
export function buildPrReviewChatPrompt(params: {
  prTitle: string;
  pullRequestId: number;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  selectedText: string;
  question: string;
}) {
  const range = params.lineEnd && params.lineEnd !== params.lineStart
    ? `${params.lineStart}-${params.lineEnd}`
    : String(params.lineStart);

  return [
    `You are helping review PR #${params.pullRequestId}: ${params.prTitle}.`,
    '',
    'You are running in a local worktree checked out to the PR source branch.',
    'Inspect the repository as needed, but do not modify files, run write commands, commit, push, or post comments.',
    '',
    `Selected location: ${params.filePath}:${range}`,
    '',
    'Selected code:',
    '```',
    params.selectedText,
    '```',
    '',
    'Reviewer question:',
    params.question,
    '',
    'Answer concisely. Call out uncertainty and exact files/lines when relevant.',
  ].join('\n');
}
```

**Step 3: Add IPC contract**

In `src/lib/api.ts`:

```ts
createPrReviewChatStep: (params: {
  taskId: string;
  pullRequestId: number;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  selectedText: string;
  question: string;
}) => Promise<TaskStep>;
```

In `electron/preload.ts`, expose `ipcRenderer.invoke('steps:createPrReviewChatStep', params)`.

**Step 4: Implement handler**

Handler steps:

- Load task, validate `task.type === 'pr-review'`.
- Load project + PR title.
- Read `prReviewAgent` setting.
- Create `StepService.create({ type: 'agent', autoStart: false, meta: { kind: 'pr-review-chat', ...anchor }, promptTemplate, interactionMode: 'ask' or 'auto' })`.
- Start agent immediately with `agentService.start(step.id)`.
- Return step.

Use setting fallback:

```ts
const setting = await SettingsRepository.get('prReviewAgent');
const backend = setting.backend ?? project.defaultAgentBackend ?? 'claude-code';
```

**Step 5: Run focused tests**

Run: `pnpm test electron/services/pr-review-agent-service.test.ts`

Expected: PASS.

---

### Task 6: Add Follow-Up API For Existing Chat Step

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `src/lib/api.ts`
- Modify: `electron/preload.ts`
- Test: extend `electron/services/pr-review-agent-service.test.ts`

**Step 1: Define behavior**

Follow-up continues same step/session, not new step.

Use existing agent service continuation if available. If agent service does not expose “send message to existing step,” add minimal method that starts backend with `step.sessionId` and new prompt against same `stepId`.

**Step 2: Add prompt builder test**

```ts
import { buildPrReviewFollowUpPrompt } from './pr-review-agent-service';

it('builds a concise follow-up prompt', () => {
  expect(buildPrReviewFollowUpPrompt('Can you inspect tests too?')).toContain(
    'Can you inspect tests too?',
  );
});
```

**Step 3: Add IPC contract**

```ts
continuePrReviewChatStep: (params: {
  stepId: string;
  question: string;
}) => Promise<TaskStep>;
```

**Step 4: Implement handler**

- Load step, validate `isPrReviewChatStepMeta(step.meta)`.
- Validate step is not running.
- Send follow-up using same step/session.
- Return updated/running step.

**Step 5: Run tests**

Run targeted tests.

Expected: PASS.

---

### Task 7: Expose PR Review Task And Chat Mutations To Renderer

**Files:**
- Modify: `src/hooks/use-tasks.ts`
- Create: `src/hooks/use-pr-review-agent.ts`
- Test: add `src/hooks/use-pr-review-agent.test.ts` if hook test setup supports it, otherwise cover via component tests in later tasks

**Step 1: Add hook API**

Create `src/hooks/use-pr-review-agent.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { ingestTask } from '@/cache/domains/tasks';
import { ingestStep, markStepListsStale } from '@/cache/domains/steps';

export function useCreateOrGetPrReviewTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.tasks.createPrReviewTask,
    onSuccess: (task) => {
      ingestTask(task);
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useCreatePrReviewChatStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.steps.createPrReviewChatStep,
    onSuccess: (step) => {
      ingestStep(step);
      markStepListsStale(step.taskId);
      queryClient.invalidateQueries({ queryKey: ['steps', step.taskId] });
    },
  });
}

export function useContinuePrReviewChatStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.steps.continuePrReviewChatStep,
    onSuccess: (step) => {
      ingestStep(step);
      markStepListsStale(step.taskId);
      queryClient.invalidateQueries({ queryKey: ['steps', step.taskId] });
    },
  });
}
```

Adjust imports to actual exported cache helpers.

**Step 2: Update task lookup**

In `src/features/pull-request/ui-pr-detail/index.tsx`, change associated task lookup from:

```ts
task.pullRequestId === String(prId) && task.type === 'agent'
```

to:

```ts
task.pullRequestId === String(prId) && (task.type === 'agent' || task.type === 'pr-review')
```

For task comment mode, only `agent` task should count as author active task. Add separate variables:

```ts
const associatedAgentTask = ... task.type === 'agent'
const associatedPrReviewTask = ... task.type === 'pr-review'
```

**Step 3: Run typecheck**

Run: `pnpm ts-check`

Expected: PASS.

---

### Task 8: Add Selection Popover With Ask Agent Action

**Files:**
- Modify: `src/features/agent/ui-diff-view/use-line-range-selection.ts`
- Modify: `src/features/agent/ui-diff-view/index.tsx`
- Modify: `src/features/agent/ui-diff-view/side-by-side-table.tsx`
- Modify: `src/features/common/ui-file-diff/file-diff-content.tsx`
- Test: `src/features/agent/ui-diff-view/use-line-range-selection.test.ts` or component test

**Step 1: Refactor selection callback shape**

Change from one callback:

```ts
onAddCommentClick?: (lineRange: LineRange) => void;
```

to action-aware callback:

```ts
onLineRangeSelected?: (params: {
  range: LineRange;
  clientX: number;
  clientY: number;
}) => void;
```

Keep backward compatibility inside `FileDiffContent` by mapping `onAddCommentClick` to default comment behavior when no custom selection actions are provided.

**Step 2: Add popover state in `FileDiffContent`**

```ts
const [selectionPopover, setSelectionPopover] = useState<{
  range: LineRange;
  clientX: number;
  clientY: number;
} | null>(null);
```

Render small absolute/fixed popover:

```tsx
{selectionPopover && (
  <div className="fixed z-50 rounded-md border border-glass-border bg-bg-1 p-1 shadow-xl" style={{ left: selectionPopover.clientX, top: selectionPopover.clientY }}>
    <button type="button" onClick={() => openComment(selectionPopover.range)}>Comment</button>
    {onAskAgent && <button type="button" onClick={() => onAskAgent(selectionPopover.range)}>Ask Agent</button>}
  </div>
)}
```

**Step 3: Add prop**

```ts
onAskAgent?: (range: LineRange) => void;
```

Pass through `PrDiffView` later.

**Step 4: Test selection callback coordinates**

If hook test is too awkward, add component test for rendering popover after selecting line range.

**Step 5: Run targeted test**

Run relevant component/hook test.

Expected: PASS.

---

### Task 9: Build Inline PR Review Chat Card

**Files:**
- Create: `src/features/pull-request/ui-pr-review-agent-chat-card/index.tsx`
- Modify: `src/features/common/ui-file-diff/file-diff-content.tsx`
- Test: `src/features/pull-request/ui-pr-review-agent-chat-card/index.test.tsx`

**Step 1: Write component test**

```tsx
it('renders collapsed latest answer and expands chat', async () => {
  render(
    <PrReviewAgentChatCard
      step={stepWithCompletedOutput}
      messages={messages}
      onFollowUp={vi.fn()}
      isSubmittingFollowUp={false}
    />,
  );

  expect(screen.getByText(/Ask Agent/)).toBeInTheDocument();
  expect(screen.getByText(/latest answer/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /expand/i }));
  expect(screen.getByRole('textbox')).toBeInTheDocument();
});
```

Adjust test utilities to repo setup.

**Step 2: Implement component**

Props:

```ts
export function PrReviewAgentChatCard({
  step,
  messages,
  onFollowUp,
  isSubmittingFollowUp,
}: {
  step: TaskStep;
  messages: NormalizedEntry[];
  onFollowUp: (question: string) => void;
  isSubmittingFollowUp: boolean;
})
```

Render:

- Header: `Ask Agent`, status pill.
- Collapsed body: latest assistant/result markdown or “Thinking...”.
- Expanded body: user/assistant message list, no tool calls.
- Composer: textarea + Send.

Filter messages:

```ts
const chatEntries = messages.filter(
  (entry) => entry.type === 'user-message' || entry.type === 'assistant-message' || entry.type === 'result',
);
```

Use existing `MarkdownContent` for assistant output.

**Step 3: Run component test**

Expected: PASS.

---

### Task 10: Render Chat Cards Inline Under Anchored Lines

**Files:**
- Modify: `src/features/pull-request/ui-pr-diff-view/index.tsx`
- Modify: `src/features/pull-request/ui-pr-detail/index.tsx`
- Modify: `src/features/common/ui-file-diff/file-diff-content.tsx`
- Test: add/extend PR diff component test if present

**Step 1: Load PR review steps**

Use existing step hooks for `associatedPrReviewTask?.id` in `PrDetail`.

Filter:

```ts
const prReviewChatSteps = steps.filter((step) => isPrReviewChatStepMeta(step.meta));
```

Pass to `PrDiffView` filtered by selected file.

**Step 2: Convert steps to inline comments**

In `FileDiffContent`, add prop:

```ts
prReviewChatCards?: Array<{
  line: number;
  content: ReactNode;
  lineStart: number;
  lineEnd?: number;
}>;
```

Merge into `inlineComments` like review comments:

```ts
const prReviewChatInlineComments = prReviewChatCards?.map((card) => ({
  line: card.line,
  content: card.content,
})) ?? EMPTY_INLINE_COMMENTS;
```

**Step 3: Wire follow-up mutation**

In `PrDetail`, use `useContinuePrReviewChatStep()` and pass handler down to cards.

**Step 4: Run typecheck**

Run: `pnpm ts-check`

Expected: PASS.

---

### Task 11: Wire Ask Agent Creation From PR Diff

**Files:**
- Modify: `src/features/pull-request/ui-pr-detail/index.tsx`
- Modify: `src/features/pull-request/ui-pr-diff-view/index.tsx`
- Modify: `src/features/common/ui-file-diff/file-diff-content.tsx`
- Test: component test around `PrDiffView` or integration-level renderer test

**Step 1: Add ask dialog/composer**

On `Ask Agent` popover click, show inline composer at selected range before creating step:

```tsx
<InlineCommentComposer
  lineStart={range.start}
  lineEnd={range.end !== range.start ? range.end : undefined}
  onSubmit={(question) => handleAskAgent(range, question)}
  onCancel={...}
  allowImages={false}
  placeholder="Ask agent about these lines..."
  submitLabel="Ask Agent"
/>
```

This can reuse `commentFormEntries` machinery with a new form type, or be rendered by the selection popover as a small modal. Prefer inline form for consistency.

**Step 2: Implement `handleAskAgent`**

In `PrDetail`:

```ts
const handleAskAgent = useCallback(async (params: {
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  selectedText: string;
  question: string;
}) => {
  const task = associatedPrReviewTask ?? await createOrGetPrReviewTask.mutateAsync({ projectId, pullRequestId: prId });
  await createPrReviewChatStep.mutateAsync({
    taskId: task.id,
    pullRequestId: prId,
    ...params,
  });
}, [associatedPrReviewTask, createOrGetPrReviewTask, createPrReviewChatStep, projectId, prId]);
```

Use `getSelectedTextForRange` in `FileDiffContent` or pass selected text from there, same as task comments.

**Step 3: Disable for own PR task-comment mode?**

Show Ask Agent only when reviewing others’ PRs (`!isPrAuthor`) for MVP. If user wants it on own PR later, remove guard.

**Step 4: Run tests/typecheck**

Run: `pnpm ts-check`

Expected: PASS.

---

### Task 12: Add Manual Cleanup Button For PR Review Worktree

**Files:**
- Modify: `src/features/pull-request/ui-pr-detail/index.tsx`
- Modify: `src/features/pull-request/ui-pr-header/index.tsx` or add small control near file toolbar
- Test: component test if existing header tests support it

**Step 1: UI behavior**

If `associatedPrReviewTask?.worktreePath`, show `Clean review workspace` button in PR header/menu.

Click calls:

```ts
api.tasks.worktree.delete(associatedPrReviewTask.id, { keepBranch: true })
```

Use existing task worktree deletion hook if present.

**Step 2: Preserve chats**

Only delete worktree. Do not delete task or steps.

After cleanup, inline cards still render from messages; new follow-up should show error: “Review workspace was cleaned up. Start a new review workspace to ask more.”

**Step 3: Add guard in follow-up handler**

If task has no `worktreePath`, disable follow-up composer.

**Step 4: Run typecheck**

Expected: PASS.

---

### Task 13: Auto-Complete PR Review Task When PR Merges

**Files:**
- Modify: `src/hooks/use-pull-requests.ts` or main PR polling/cache ingestion location
- Modify: `electron/ipc/handlers.ts` if completion should happen main-side
- Test: `src/hooks/use-pull-requests.test.ts` or service-level test if PR snapshots are ingested main-side

**Step 1: Define trigger**

When PR detail/feed refresh sees PR status merged/completed, find linked `pr-review` task with same `pullRequestId` and set `status: 'completed'` + `userCompleted: true`.

Prefer main-side service if PR feed ingestion already records snapshots; avoid renderer-only completion if possible.

**Step 2: Write failing test**

```ts
it('completes linked pr-review task when PR is merged', async () => {
  const task = await TaskRepository.create({ type: 'pr-review', pullRequestId: '12', ... });
  await handlePrSnapshot({ pullRequestId: 12, status: 'completed' });
  await expect(TaskRepository.findById(task.id)).resolves.toMatchObject({
    status: 'completed',
    userCompleted: true,
  });
});
```

Adjust to actual PR status enum (`completed` vs `merged`).

**Step 3: Implement minimal service**

Add helper:

```ts
export async function completePrReviewTasksForMergedPr(params: {
  projectId: string;
  pullRequestId: number;
}) {
  const tasks = await TaskRepository.findByProjectId(params.projectId);
  for (const task of tasks) {
    if (task.type !== 'pr-review') continue;
    if (task.pullRequestId !== String(params.pullRequestId)) continue;
    if (task.status === 'completed') continue;
    const updated = await TaskRepository.update(task.id, {
      status: 'completed',
      userCompleted: true,
    });
    emitTaskUpsert(updated);
  }
}
```

Call from PR fetch/update path after status known.

**Step 4: Run test**

Expected: PASS.

---

### Task 14: Remove Or Reposition Old Preset PR Review Button

**Files:**
- Modify: `src/features/pull-request/ui-pr-header/index.tsx:160-190`
- Modify: `src/features/pull-request/ui-pr-review-setup-dialog/index.tsx` if unused
- Modify: `src/stores/background-jobs.ts` if old job type becomes unused
- Test: `pnpm ts-check`

**Step 1: Decide compatibility**

For MVP, remove header “Review with agents” entry if it invokes old preset review. Ask Agent now starts from selected lines only.

**Step 2: Delete unused dialog only if no references remain**

Use Grep for `PrReviewSetupDialog` and `pr-review-creation`.

**Step 3: Run typecheck**

Expected: PASS.

---

### Task 15: Full Verification

**Files:**
- No code changes unless failures require fixes.

**Step 1: Install**

Run: `pnpm install`

Expected: completes; Node engine warning acceptable in current environment.

**Step 2: Tests**

Run: `pnpm test`

Expected: all tests pass.

**Step 3: Lint fix**

Run: `pnpm lint --fix`

Expected: no remaining auto-fixable issues.

**Step 4: Typecheck**

Run: `pnpm ts-check`

Expected: pass.

**Step 5: Final lint**

Run: `pnpm lint`

Expected: pass.

---

## Implementation Notes

- Keep PR review task worktree read-only at permissions layer. Do not rely only on prompt text.
- Do not add PR comment posting for agent answers in MVP.
- Do not store duplicate chat tables unless step/message storage proves insufficient.
- Keep old task-comment behavior for PR authors separate from PR-review tasks.
- Each selected-line chat is one step. Follow-ups continue same step/session.
- Inline cards should hide tool calls; task detail can still show normal timeline for debugging.

## Suggested Commit Slices

1. `feat(pr-review): add chat task metadata and settings`
2. `feat(pr-review): create read-only review tasks on demand`
3. `feat(pr-review): create anchored agent chat steps`
4. `feat(pr-review): render inline ask-agent chats`
5. `feat(pr-review): add workspace cleanup and merge completion`
