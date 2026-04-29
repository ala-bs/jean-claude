# Interactive Run Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make run commands interactive by forwarding user keyboard input (stdin) to running processes, turning the read-only log pane into a terminal-like experience.

**Architecture:** Change the spawned process `stdio` from `['ignore', 'pipe', 'pipe']` to `['pipe', 'pipe', 'pipe']` so stdin is writable. Add a new `sendInput` IPC channel that forwards text from the renderer to `process.stdin`. In the UI, add a single-line input at the bottom of the command logs pane that sends text on Enter.

**Tech Stack:** Electron IPC (invoke), Node.js child_process stdin, React, Zustand, TailwindCSS

---

### Task 1: Service Layer — Enable stdin pipe and add `sendInput` method

**Files:**
- Modify: `electron/services/run-command-service.ts`

**Step 1: Change stdio config to pipe stdin**

In `startCommandWithoutLock`, change the `spawn` call's stdio from `['ignore', 'pipe', 'pipe']` to `['pipe', 'pipe', 'pipe']`:

```typescript
const childProcess = spawn(command.command, {
  cwd: workingDir,
  shell: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: getProcessEnvWithoutNodeEnv(),
  detached: true,
});
```

**Step 2: Add the `sendInput` method to `RunCommandService`**

Add this public method to the `RunCommandService` class, after the `stopCommand` method:

```typescript
sendInput({
  taskId,
  runCommandId,
  input,
}: {
  taskId: string;
  runCommandId: string;
  input: string;
}): void {
  const taskProcesses = this.runningProcesses.get(taskId);
  if (!taskProcesses) return;

  const tracked = taskProcesses.get(runCommandId);
  if (!tracked || tracked.status !== 'running') return;

  const stdin = tracked.process.stdin;
  if (!stdin || stdin.destroyed) return;

  stdin.write(input);
}
```

**Step 3: Verify the build compiles**

Run: `pnpm ts-check`
Expected: No type errors

**Step 4: Commit**

```bash
git add electron/services/run-command-service.ts
git commit -m "feat(run-commands): enable stdin pipe and add sendInput service method"
```

---

### Task 2: IPC + Preload — Wire `sendInput` from renderer to main

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

**Step 1: Add IPC handler in `handlers.ts`**

Add this handler right after the existing `project:commands:run:stopCommand` handler (around line 2413):

```typescript
ipcMain.handle(
  'project:commands:run:sendInput',
  (
    _,
    params: { taskId: string; runCommandId: string; input: string },
  ) => runCommandService.sendInput(params),
);
```

**Step 2: Add preload method**

In `electron/preload.ts`, inside the `runCommands` object (after `stopCommand`), add:

```typescript
sendInput: (params: { taskId: string; runCommandId: string; input: string }) =>
  ipcRenderer.invoke('project:commands:run:sendInput', params),
```

**Step 3: Add type to `api.ts`**

In `src/lib/api.ts`, inside the `runCommands` type (after the `stopCommand` type), add:

```typescript
sendInput: (params: {
  taskId: string;
  runCommandId: string;
  input: string;
}) => Promise<void>;
```

**Step 4: Add mock in `api.ts`**

In the mock/demo `runCommands` object further down in `api.ts`, add after `stopCommand`:

```typescript
sendInput: async () => {},
```

**Step 5: Verify the build compiles**

Run: `pnpm ts-check`
Expected: No type errors

**Step 6: Commit**

```bash
git add electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts
git commit -m "feat(run-commands): add sendInput IPC channel for stdin forwarding"
```

---

### Task 3: UI — Add stdin input field to `CommandLogsPane`

**Files:**
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx`

**Step 1: Add the stdin input component**

Add a new `CommandInput` component at the bottom of the file (before the closing of the file, after the `CommandLogsPane` export):

```tsx
function CommandInput({
  taskId,
  runCommandId,
}: {
  taskId: string;
  runCommandId: string;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    if (!value) return;
    api.runCommands.sendInput({
      taskId,
      runCommandId,
      input: value + '\n',
    });
    setValue('');
  }, [taskId, runCommandId, value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="border-glass-border flex items-center gap-2 border-t px-3 py-2">
      <span className="text-ink-3 text-xs font-mono select-none">{'>'}</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type input and press Enter..."
        className="text-ink-1 placeholder-ink-3 bg-transparent flex-1 font-mono text-xs leading-relaxed focus:outline-none"
      />
    </div>
  );
}
```

**Step 2: Render the input inside `CommandLogsPane`**

Inside the `CommandLogsPane` component, find the block that renders the log lines (the `<>` fragment containing the tabs and scrollable log area). Add the `CommandInput` component after the scrollable div and before the closing `</>`, conditionally rendered only when the active command is running:

Replace the fragment that starts after `{tabs.length > 0 ? (` and ends before `) : (` — specifically, add the `CommandInput` after the scrollable `<div ref={scrollRef} ...>...</div>`:

```tsx
{activeCommandId && runningCommandIds.has(activeCommandId) && (
  <CommandInput
    taskId={taskId}
    runCommandId={activeCommandId}
  />
)}
```

This goes right after the closing `</div>` of the scroll container (the `ref={scrollRef}` div) and before the closing `</>` of the fragment.

**Step 3: Add `React` to the import for `React.KeyboardEvent` (if needed)**

The component uses `React.KeyboardEvent`. Check the existing imports — the file already imports from `'react'`. You can either:
- Import `type { KeyboardEvent as ReactKeyboardEvent }` from `'react'` and use that, OR
- Use the pattern already used elsewhere in the codebase

Looking at the file's existing imports, they destructure from `'react'`. So update the `handleKeyDown` type to use the destructured import. Add `type KeyboardEvent as ReactKeyboardEvent` to the `react` import if needed, or just inline the type:

```tsx
const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLInputElement>) => {
```

Since the file doesn't import `React` as a namespace, use the already-imported pattern. The simplest fix: don't type the event parameter — let TypeScript infer it from the `onKeyDown` prop. Change to:

```tsx
const handleKeyDown = useCallback(
  (e: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
```

Or better, import `KeyboardEvent` from react (it's already imported by the file for other uses — check the imports). The file imports `{ useCallback, useEffect, ... }` from `'react'`. We don't need the type import — just use `React.KeyboardEvent` won't work without the namespace import.

**Simplest approach:** Don't annotate the event at all — TypeScript will infer it from `onKeyDown`:

```tsx
const handleKeyDown = useCallback(
  (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  },
  [handleSubmit],
);
```

And ensure `KeyboardEvent` is in the existing destructured import from `'react'` (it likely isn't — this file currently doesn't use keyboard events). Add it:

```typescript
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
```

Wait — the file already imports `KeyboardEvent` from `'react'`? Let's check. No, looking at the existing imports:

```typescript
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
```

So we need to add `type KeyboardEvent` to that import.

**Step 4: Verify the build compiles**

Run: `pnpm ts-check`
Expected: No type errors

**Step 5: Run lint**

Run: `pnpm lint --fix`

**Step 6: Commit**

```bash
git add src/features/task/ui-task-panel/command-logs-pane/index.tsx
git commit -m "feat(run-commands): add interactive stdin input to command logs pane"
```

---

### Task 4: Echo stdin input in the log as user feedback

**Files:**
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx`

**Step 1: Echo input to the log store**

When the user submits input, also append it to the log so they can see what they typed (many CLI programs don't echo stdin). Update `CommandInput` to import and use the store:

```tsx
function CommandInput({
  taskId,
  runCommandId,
}: {
  taskId: string;
  runCommandId: string;
}) {
  const [value, setValue] = useState('');
  const appendRunCommandLine = useTaskMessagesStore(
    (state) => state.appendRunCommandLine,
  );

  const handleSubmit = useCallback(() => {
    if (!value) return;
    api.runCommands.sendInput({
      taskId,
      runCommandId,
      input: value + '\n',
    });
    appendRunCommandLine(taskId, runCommandId, 'stdout', `> ${value}`);
    setValue('');
  }, [taskId, runCommandId, value, appendRunCommandLine]);

  // ... rest unchanged
}
```

This adds a `> ` prefixed echo line to the log so the user can see what they sent. The line appears as stdout-colored text, visually distinguished by the `> ` prefix.

**Step 2: Verify the build compiles**

Run: `pnpm ts-check`
Expected: No type errors

**Step 3: Commit**

```bash
git add src/features/task/ui-task-panel/command-logs-pane/index.tsx
git commit -m "feat(run-commands): echo stdin input in log for user feedback"
```

---

### Task 5: Add special key support (Ctrl+C) for signal forwarding

**Files:**
- Modify: `electron/services/run-command-service.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx`

**Step 1: Add `sendSignal` method to service**

In `run-command-service.ts`, add after `sendInput`:

```typescript
sendSignal({
  taskId,
  runCommandId,
  signal,
}: {
  taskId: string;
  runCommandId: string;
  signal: 'SIGINT' | 'SIGTERM';
}): void {
  const taskProcesses = this.runningProcesses.get(taskId);
  if (!taskProcesses) return;

  const tracked = taskProcesses.get(runCommandId);
  if (!tracked || tracked.status !== 'running' || !tracked.process.pid) return;

  // Send to process group so child processes also receive it
  try {
    process.kill(-tracked.process.pid, signal);
  } catch {
    // Process may already be dead
  }
}
```

**Step 2: Add IPC handler**

In `handlers.ts`, after the `sendInput` handler:

```typescript
ipcMain.handle(
  'project:commands:run:sendSignal',
  (
    _,
    params: {
      taskId: string;
      runCommandId: string;
      signal: 'SIGINT' | 'SIGTERM';
    },
  ) => runCommandService.sendSignal(params),
);
```

**Step 3: Add preload method**

In `preload.ts`, after `sendInput`:

```typescript
sendSignal: (params: {
  taskId: string;
  runCommandId: string;
  signal: 'SIGINT' | 'SIGTERM';
}) => ipcRenderer.invoke('project:commands:run:sendSignal', params),
```

**Step 4: Add type to `api.ts`**

After `sendInput` type:

```typescript
sendSignal: (params: {
  taskId: string;
  runCommandId: string;
  signal: 'SIGINT' | 'SIGTERM';
}) => Promise<void>;
```

And in the mock:

```typescript
sendSignal: async () => {},
```

**Step 5: Handle Ctrl+C in the input field**

In `CommandInput`, update the `handleKeyDown` to intercept Ctrl+C:

```tsx
const handleKeyDown = useCallback(
  (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
      // Only send SIGINT if input is empty (like a real terminal)
      // If text is selected, let default copy behavior happen
      if (!value) {
        e.preventDefault();
        api.runCommands.sendSignal({
          taskId,
          runCommandId,
          signal: 'SIGINT',
        });
        appendRunCommandLine(taskId, runCommandId, 'stdout', '^C');
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  },
  [handleSubmit, taskId, runCommandId, value, appendRunCommandLine],
);
```

**Step 6: Verify build and lint**

Run: `pnpm ts-check && pnpm lint --fix`

**Step 7: Commit**

```bash
git add electron/services/run-command-service.ts electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts src/features/task/ui-task-panel/command-logs-pane/index.tsx
git commit -m "feat(run-commands): add Ctrl+C signal forwarding to running processes"
```

---

### Task 6: Auto-focus input when switching tabs and command starts

**Files:**
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx`

**Step 1: Add auto-focus behavior**

Update `CommandInput` to accept and use a ref, and auto-focus when mounted:

```tsx
function CommandInput({
  taskId,
  runCommandId,
}: {
  taskId: string;
  runCommandId: string;
}) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const appendRunCommandLine = useTaskMessagesStore(
    (state) => state.appendRunCommandLine,
  );

  // Auto-focus on mount and when runCommandId changes
  useEffect(() => {
    inputRef.current?.focus();
  }, [runCommandId]);

  // ... rest of component
```

**Step 2: Verify build**

Run: `pnpm ts-check`

**Step 3: Commit**

```bash
git add src/features/task/ui-task-panel/command-logs-pane/index.tsx
git commit -m "feat(run-commands): auto-focus stdin input on tab switch"
```

---

### Task 7: Final verification

**Step 1: Full type check**

Run: `pnpm ts-check`
Expected: No type errors

**Step 2: Full lint**

Run: `pnpm lint --fix && pnpm lint`
Expected: No lint errors

---

## Summary of Changes

| Layer | File | Change |
|-------|------|--------|
| Service | `electron/services/run-command-service.ts` | `stdio: ['pipe', ...]`, `sendInput()`, `sendSignal()` |
| IPC | `electron/ipc/handlers.ts` | Two new handlers: `sendInput`, `sendSignal` |
| Preload | `electron/preload.ts` | Two new API methods |
| Types | `src/lib/api.ts` | Type definitions + mocks for new methods |
| UI | `command-logs-pane/index.tsx` | `CommandInput` component with stdin input, echo, Ctrl+C, auto-focus |

No new files created. No database changes. No new dependencies.
