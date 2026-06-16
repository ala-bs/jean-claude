# Raw Batched Command Logs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stream command logs as raw throttled batches from main process, then incrementally parse and render them in renderer without waiting for newline or reparsing full history.

**Architecture:** Main process stops splitting log output into lines. It buffers raw PTY output per running command and emits batched `{ text, stream }` events on interval, size threshold, and process exit. Renderer store owns parsing, chunking, memory caps, and exposes chunked log state to UI.

**Tech Stack:** Electron IPC, `node-pty`, React 19, Zustand, Vitest, TypeScript.

---

## Current State

- `electron/services/run-command-service.ts` currently parses PTY output into line events in `appendLogChunk()`.
- Current working tree has a partial fix using optional `partial?: boolean`; this plan replaces it.
- `src/stores/task-messages.ts` currently stores `lines: RunCommandLogEntry[]` per command.
- `src/features/common/interactive-log/index.tsx` renders flat line arrays.
- `src/features/task/ui-task-panel/command-logs-pane/index.tsx` searches and passes flat lines.

## Target Model

```ts
type RunCommandLogBatch = {
  taskId: string;
  runCommandId: string;
  stream: 'stdout' | 'stderr';
  text: string;
};

type RunCommandLogLine = {
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: number;
};

type RunCommandLogChunk = {
  id: string;
  lines: RunCommandLogLine[];
  lineCount: number;
};

type RunCommandLogState = {
  chunks: RunCommandLogChunk[];
  pendingLine: RunCommandLogLine | null;
  trailingText: string;
  updatedAt: number;
  version: number;
};
```

Constants:

```ts
const RUN_COMMAND_LOG_FLUSH_INTERVAL_MS = 50;
const RUN_COMMAND_LOG_FLUSH_BYTES = 16 * 1024;
const RUN_COMMAND_LOG_CHUNK_LINE_LIMIT = 200;
const MAX_RUN_COMMAND_LOG_LINES = 5000;
```

---

### Task 1: Update Shared Log Event Types

**Files:**
- Modify: `shared/run-command-types.ts:105-113`
- Modify: `src/lib/api.ts:1160-1167`

**Step 1: Update shared type**

Replace current `RunCommandLogEvent` fields:

```ts
export interface RunCommandLogEvent {
  taskId: string;
  runCommandId: string;
  stream: RunCommandLogStream;
  text: string;
}
```

Remove `line` and `partial` from this interface.

**Step 2: Update renderer API callback type**

In `src/lib/api.ts`, change `onLog` callback signature to:

```ts
onLog: (
  callback: (
    taskId: string,
    runCommandId: string,
    stream: 'stdout' | 'stderr',
    text: string,
  ) => void,
) => () => void;
```

**Step 3: Run typecheck subset**

Run: `pnpm ts-check`

Expected: Type errors in IPC/store call sites referencing `line` or `partial`. Do not fix until next tasks.

---

### Task 2: Replace Main Line Splitting With Raw Batch Flush

**Files:**
- Modify: `electron/services/run-command-service.ts:179-370`
- Modify: `electron/services/run-command-service.ts:507-548`
- Modify: `electron/ipc/handlers.ts:4320-4329`
- Modify: `electron/preload.ts:897-911`

**Step 1: Update callback names and tracked state**

In `run-command-service.ts`, change `LogCallback` to use `text`:

```ts
type LogCallback = (
  taskId: string,
  runCommandId: string,
  stream: RunCommandLogStream,
  text: string,
) => void;
```

Replace `TrackedProcess.outputBuffers` with raw batch fields:

```ts
pendingLogBatches: Record<RunCommandLogStream, string>;
logFlushTimer: NodeJS.Timeout | null;
```

**Step 2: Add batching helpers**

Replace `notifyLog`, `flushBuffer`, and `appendLogChunk` with:

```ts
private notifyLog(
  taskId: string,
  runCommandId: string,
  stream: RunCommandLogStream,
  text: string,
): void {
  this.logCallbacks.forEach((cb) => cb(taskId, runCommandId, stream, text));
}

private flushLogBatches({
  taskId,
  tracked,
}: {
  taskId: string;
  tracked: TrackedProcess;
}): void {
  if (tracked.logFlushTimer) {
    clearTimeout(tracked.logFlushTimer);
    tracked.logFlushTimer = null;
  }

  for (const stream of ['stdout', 'stderr'] as const) {
    const text = tracked.pendingLogBatches[stream];
    if (!text) continue;
    tracked.pendingLogBatches[stream] = '';
    this.notifyLog(taskId, tracked.commandId, stream, text);
  }
}

private appendLogChunk({
  taskId,
  tracked,
  stream,
  chunk,
}: {
  taskId: string;
  tracked: TrackedProcess;
  stream: RunCommandLogStream;
  chunk: string;
}): void {
  tracked.pendingLogBatches[stream] += chunk;

  if (tracked.pendingLogBatches[stream].length >= RUN_COMMAND_LOG_FLUSH_BYTES) {
    this.flushLogBatches({ taskId, tracked });
    return;
  }

  if (!tracked.logFlushTimer) {
    tracked.logFlushTimer = setTimeout(() => {
      this.flushLogBatches({ taskId, tracked });
    }, RUN_COMMAND_LOG_FLUSH_INTERVAL_MS);
  }
}
```

Add constants near top of file:

```ts
const RUN_COMMAND_LOG_FLUSH_INTERVAL_MS = 50;
const RUN_COMMAND_LOG_FLUSH_BYTES = 16 * 1024;
```

**Step 3: Initialize tracked state**

In `spawnTrackedCommand()`, initialize:

```ts
pendingLogBatches: { stdout: '', stderr: '' },
logFlushTimer: null,
```

**Step 4: Flush on exit**

In `ptyProcess.onExit`, replace both `flushBuffer()` calls with:

```ts
this.flushLogBatches({ taskId, tracked: trackedProcess });
```

**Step 5: Update IPC forwarding**

In `electron/ipc/handlers.ts`, forward `text` instead of `line`:

```ts
runCommandService.onLog((taskId, runCommandId, stream, text) => {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(
        'project:commands:run:log',
        taskId,
        runCommandId,
        stream,
        text,
      );
    }
  });
});
```

In `electron/preload.ts`, rename callback param to `text` and pass it through.

**Step 6: Run tests expected to fail only at renderer types**

Run: `pnpm ts-check`

Expected: Type errors remain in renderer store and message manager only.

---

### Task 3: Add Incremental Renderer Parser Tests

**Files:**
- Create: `src/stores/utils-run-command-log-parser.ts`
- Create: `src/stores/utils-run-command-log-parser.test.ts`

**Step 1: Write failing tests**

Create `src/stores/utils-run-command-log-parser.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { parseRunCommandLogBatch } from './utils-run-command-log-parser';

describe('parseRunCommandLogBatch', () => {
  it('keeps output without newline as pending line', () => {
    const result = parseRunCommandLogBatch({
      trailingText: '',
      stream: 'stdout',
      text: 'building...',
      timestamp: 1,
    });

    expect(result.completedLines).toEqual([]);
    expect(result.pendingLine).toMatchObject({ line: 'building...' });
    expect(result.trailingText).toBe('building...');
  });

  it('converts pending text into completed line when newline arrives', () => {
    const result = parseRunCommandLogBatch({
      trailingText: 'building...',
      stream: 'stdout',
      text: 'done\nnext',
      timestamp: 2,
    });

    expect(result.completedLines.map((line) => line.line)).toEqual([
      'building...done',
    ]);
    expect(result.pendingLine?.line).toBe('next');
    expect(result.trailingText).toBe('next');
  });

  it('normalizes crlf and carriage-return overwrites', () => {
    const result = parseRunCommandLogBatch({
      trailingText: '',
      stream: 'stdout',
      text: '10%\r20%\r100%\r\ndone\r\n',
      timestamp: 3,
    });

    expect(result.completedLines.map((line) => line.line)).toEqual([
      '100%',
      'done',
    ]);
    expect(result.pendingLine).toBeNull();
    expect(result.trailingText).toBe('');
  });
});
```

**Step 2: Run parser tests**

Run: `pnpm test -- src/stores/utils-run-command-log-parser.test.ts`

Expected: FAIL because module does not exist.

---

### Task 4: Implement Incremental Parser

**Files:**
- Modify: `src/stores/utils-run-command-log-parser.ts`

**Step 1: Add parser implementation**

Create `src/stores/utils-run-command-log-parser.ts`:

```ts
import type { RunCommandLogStream } from '@shared/run-command-types';

export interface ParsedRunCommandLogLine {
  stream: RunCommandLogStream;
  line: string;
  timestamp: number;
}

export function applyRunCommandLineOverwrites(line: string): string {
  let result = line;

  // eslint-disable-next-line no-control-regex
  const eraseMatch = /\x1b\[2?K/g;
  let lastEraseEnd = -1;
  let match;
  while ((match = eraseMatch.exec(result)) !== null) {
    lastEraseEnd = match.index + match[0].length;
  }
  if (lastEraseEnd > 0) result = result.substring(lastEraseEnd);

  const cursorHomeIdx = result.lastIndexOf('\x1b[1G');
  if (cursorHomeIdx !== -1) result = result.substring(cursorHomeIdx + 4);

  const crIdx = result.lastIndexOf('\r');
  if (crIdx !== -1) result = result.substring(crIdx + 1);

  return result;
}

export function parseRunCommandLogBatch({
  trailingText,
  stream,
  text,
  timestamp,
}: {
  trailingText: string;
  stream: RunCommandLogStream;
  text: string;
  timestamp: number;
}): {
  completedLines: ParsedRunCommandLogLine[];
  pendingLine: ParsedRunCommandLogLine | null;
  trailingText: string;
} {
  const normalized = text.replace(/\r\n/g, '\n');
  const combined = trailingText + normalized;
  const parts = combined.split('\n');
  const nextTrailingText = parts.pop() ?? '';

  return {
    completedLines: parts.map((line) => ({
      stream,
      line: applyRunCommandLineOverwrites(line),
      timestamp,
    })),
    pendingLine: nextTrailingText
      ? {
          stream,
          line: applyRunCommandLineOverwrites(nextTrailingText),
          timestamp,
        }
      : null,
    trailingText: applyRunCommandLineOverwrites(nextTrailingText),
  };
}
```

**Step 2: Run parser tests**

Run: `pnpm test -- src/stores/utils-run-command-log-parser.test.ts`

Expected: PASS.

---

### Task 5: Replace Flat Store Log Lines With Chunked State

**Files:**
- Modify: `src/stores/task-messages.ts:15-29`
- Modify: `src/stores/task-messages.ts:99-106`
- Modify: `src/stores/task-messages.ts:327-364`
- Modify: `src/stores/task-messages.test.ts`

**Step 1: Update store types**

In `src/stores/task-messages.ts`, replace log entry/state types with:

```ts
const MAX_RUN_COMMAND_LOG_LINES = 5000;
const RUN_COMMAND_LOG_CHUNK_LINE_LIMIT = 200;

export interface RunCommandLogLine {
  stream: RunCommandLogStream;
  line: string;
  timestamp: number;
}

export interface RunCommandLogChunk {
  id: string;
  lines: RunCommandLogLine[];
  lineCount: number;
}

interface RunCommandLogState {
  chunks: RunCommandLogChunk[];
  pendingLine: RunCommandLogLine | null;
  trailingText: string;
  totalLineCount: number;
  updatedAt: number;
  version: number;
}
```

Change action signature:

```ts
appendRunCommandLogBatch: (
  taskId: string,
  runCommandId: string,
  stream: RunCommandLogStream,
  text: string,
) => void;
```

Remove `appendRunCommandLine` from interface and implementation.

**Step 2: Add chunk helpers above store**

```ts
function appendLinesToChunks({
  chunks,
  lines,
  runCommandId,
}: {
  chunks: RunCommandLogChunk[];
  lines: RunCommandLogLine[];
  runCommandId: string;
}): RunCommandLogChunk[] {
  if (lines.length === 0) return chunks;

  const nextChunks = chunks.slice();
  let current = nextChunks[nextChunks.length - 1];

  for (const line of lines) {
    if (!current || current.lineCount >= RUN_COMMAND_LOG_CHUNK_LINE_LIMIT) {
      current = {
        id: `${runCommandId}:${Date.now()}:${nextChunks.length}`,
        lines: [],
        lineCount: 0,
      };
      nextChunks.push(current);
    }

    current = {
      ...current,
      lines: [...current.lines, line],
      lineCount: current.lineCount + 1,
    };
    nextChunks[nextChunks.length - 1] = current;
  }

  return nextChunks;
}

function capLogChunks({
  chunks,
  totalLineCount,
}: {
  chunks: RunCommandLogChunk[];
  totalLineCount: number;
}): { chunks: RunCommandLogChunk[]; totalLineCount: number } {
  let nextChunks = chunks;
  let nextLineCount = totalLineCount;

  while (nextLineCount > MAX_RUN_COMMAND_LOG_LINES && nextChunks.length > 1) {
    const [removed, ...rest] = nextChunks;
    nextChunks = rest;
    nextLineCount -= removed.lineCount;
  }

  return { chunks: nextChunks, totalLineCount: nextLineCount };
}
```

**Step 3: Implement batch append**

Use parser from Task 4:

```ts
appendRunCommandLogBatch: (taskId, runCommandId, stream, text) => {
  set((state) => {
    const now = Date.now();
    const taskLogs = state.runCommandLogs[taskId] ?? {};
    const existingLog = taskLogs[runCommandId] ?? {
      chunks: [],
      pendingLine: null,
      trailingText: '',
      totalLineCount: 0,
      updatedAt: now,
      version: 0,
    };

    const parsed = parseRunCommandLogBatch({
      trailingText: existingLog.trailingText,
      stream,
      text,
      timestamp: now,
    });

    const chunks = appendLinesToChunks({
      chunks: existingLog.chunks,
      lines: parsed.completedLines,
      runCommandId,
    });
    const capped = capLogChunks({
      chunks,
      totalLineCount: existingLog.totalLineCount + parsed.completedLines.length,
    });

    return {
      runCommandLogs: {
        ...state.runCommandLogs,
        [taskId]: {
          ...taskLogs,
          [runCommandId]: {
            chunks: capped.chunks,
            pendingLine: parsed.pendingLine,
            trailingText: parsed.trailingText,
            totalLineCount: capped.totalLineCount,
            updatedAt: now,
            version: existingLog.version + 1,
          },
        },
      },
    };
  });
},
```

**Step 4: Update store tests**

Replace current partial-line test with:

```ts
it('keeps no-newline output visible as pending line', () => {
  const store = useTaskMessagesStore.getState();

  store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'build');
  store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'ing');

  const log = useTaskMessagesStore.getState().runCommandLogs['task-1']['cmd-1'];

  expect(log.chunks).toHaveLength(0);
  expect(log.pendingLine?.line).toBe('building');
});

it('moves pending output into chunks after newline', () => {
  const store = useTaskMessagesStore.getState();

  store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'build');
  store.appendRunCommandLogBatch('task-1', 'cmd-1', 'stdout', 'ing\nnext');

  const log = useTaskMessagesStore.getState().runCommandLogs['task-1']['cmd-1'];

  expect(log.chunks[0].lines.map((entry) => entry.line)).toEqual(['building']);
  expect(log.pendingLine?.line).toBe('next');
});
```

**Step 5: Run store tests**

Run: `pnpm test -- src/stores/task-messages.test.ts src/stores/utils-run-command-log-parser.test.ts`

Expected: PASS.

---

### Task 6: Update Renderer Subscription

**Files:**
- Modify: `src/features/agent/task-message-manager/index.tsx:153-161`

**Step 1: Rename selected store action**

Replace selector:

```ts
const appendRunCommandLogBatch = useTaskMessagesStore(
  (s) => s.appendRunCommandLogBatch,
);
```

**Step 2: Update callback**

```ts
useEffect(() => {
  const unsub = api.runCommands.onLog((taskId, runCommandId, stream, text) => {
    appendRunCommandLogBatch(taskId, runCommandId, stream, text);
  });

  return unsub;
}, [appendRunCommandLogBatch]);
```

**Step 3: Run typecheck**

Run: `pnpm ts-check`

Expected: Remaining errors only in UI references to `.lines`.

---

### Task 7: Update Command Logs Pane Selectors And Search

**Files:**
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx:95-129`
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx:222-229`
- Modify: `src/features/task/ui-task-panel/command-logs-pane/index.tsx:334-345`

**Step 1: Add local helpers above component**

```ts
function hasLogContent(log: RunCommandLogs[string] | undefined): boolean {
  return !!log && (log.totalLineCount > 0 || !!log.pendingLine);
}

function logMatchesSearch(
  log: RunCommandLogs[string] | undefined,
  query: string,
): boolean {
  if (!log) return false;
  if (log.pendingLine?.line.toLowerCase().includes(query)) return true;
  return log.chunks.some((chunk) =>
    chunk.lines.some((entry) => entry.line.toLowerCase().includes(query)),
  );
}
```

**Step 2: Update tab presence**

Change tab filter from `.lines.length` to:

```ts
hasLogContent(runCommandLogs[command.id]) || runningCommandIds.has(command.id)
```

**Step 3: Update search filter**

Change log search branch to:

```ts
return logMatchesSearch(runCommandLogs[tab.id], normalizedSearchQuery);
```

**Step 4: Build active view object**

Replace `filteredActiveLines` with:

```ts
const activeLogView = useMemo(() => {
  if (!activeLog) return null;
  if (!normalizedSearchQuery) return activeLog;

  return {
    ...activeLog,
    chunks: activeLog.chunks
      .map((chunk) => ({
        ...chunk,
        lines: chunk.lines.filter((entry) =>
          entry.line.toLowerCase().includes(normalizedSearchQuery),
        ),
      }))
      .filter((chunk) => chunk.lines.length > 0),
    pendingLine: activeLog.pendingLine?.line
      .toLowerCase()
      .includes(normalizedSearchQuery)
      ? activeLog.pendingLine
      : null,
  };
}, [activeLog, normalizedSearchQuery]);
```

Search path may create new chunk objects; acceptable because search is explicit user action, not hot log path.

**Step 5: Pass chunked log to `InteractiveLog`**

```tsx
<InteractiveLog
  log={activeLogView}
  taskId={taskId}
  runCommandId={activeCommandId}
  isRunning={isActiveRunning}
  emptyText={...}
/>
```

**Step 6: Run typecheck**

Run: `pnpm ts-check`

Expected: Remaining errors in `InteractiveLog` prop type.

---

### Task 8: Render Log Chunks Without Flattening Hot Path

**Files:**
- Modify: `src/features/common/interactive-log/index.tsx:1-138`

**Step 1: Update props**

Import types:

```ts
import type { RunCommandLogState } from '@/stores/task-messages';
```

Change props from `lines` to:

```ts
log: RunCommandLogState | null;
```

Ensure `RunCommandLogState` is exported from `src/stores/task-messages.ts` in Task 5.

**Step 2: Add memoized chunk renderer**

Below constants:

```tsx
const LogChunkView = memo(function LogChunkView({
  lines,
}: {
  lines: RunCommandLogState['chunks'][number]['lines'];
}) {
  return (
    <>
      {lines.map((entry, index) => (
        <LogLineView key={`${entry.timestamp}-${index}`} entry={entry} />
      ))}
    </>
  );
});

const LogLineView = memo(function LogLineView({
  entry,
}: {
  entry: RunCommandLogState['chunks'][number]['lines'][number];
}) {
  return (
    <div
      className={clsx(
        '-mx-1 border-l-2 px-2 break-words whitespace-pre-wrap transition-colors hover:bg-white/[0.03]',
        entry.stream === 'stderr'
          ? 'border-status-fail/70 text-status-fail hover:bg-status-fail/5'
          : 'text-ink-1 border-ink-4/25 hover:border-ink-3/60',
      )}
    >
      <AnsiLine line={entry.line} />
    </div>
  );
});
```

Add `memo` to React imports.

**Step 3: Update auto-scroll dependencies**

Replace `lineCount` logic with:

```ts
const logVersion = log?.version ?? 0;
useLayoutEffect(() => {
  const el = scrollRef.current;
  if (el && isAtBottomRef.current) {
    el.scrollTop = el.scrollHeight;
  }
}, [logVersion, runCommandId]);
```

**Step 4: Render chunks + pending line**

Replace flat map render with:

```tsx
{!log || (log.totalLineCount === 0 && !log.pendingLine) ? (
  <p className="text-ink-4">{emptyText}</p>
) : (
  <>
    {log.chunks.map((chunk) => (
      <LogChunkView key={chunk.id} lines={chunk.lines} />
    ))}
    {log.pendingLine && <LogLineView entry={log.pendingLine} />}
  </>
)}
```

**Step 5: Run relevant tests and typecheck**

Run: `pnpm test -- src/stores/task-messages.test.ts src/stores/utils-run-command-log-parser.test.ts`

Expected: PASS.

Run: `pnpm ts-check`

Expected: PASS or only unrelated existing errors. Fix any errors from changed files.

---

### Task 9: Remove Obsolete Main-Side Line Parser

**Files:**
- Modify: `electron/services/run-command-service.ts:137-177`

**Step 1: Delete `applyLineOverwrites()` from main**

Remove function entirely. Renderer parser now owns line semantics.

**Step 2: Search for stale symbols**

Run: `rg "appendRunCommandLine|partial|applyLineOverwrites|outputBuffers|line:" electron src shared`

Expected:
- No `appendRunCommandLine`
- No log-event `partial`
- No main `applyLineOverwrites`
- No `outputBuffers`
- `line:` only allowed in renderer parsed log types/tests/UI

**Step 3: Run typecheck**

Run: `pnpm ts-check`

Expected: PASS.

---

### Task 10: Full Verification

**Files:**
- No source edits unless failures require fixes.

**Step 1: Install**

Run: `pnpm install`

Expected: completes. Node engine warning may appear if local Node is not `>=20.18 <21`.

**Step 2: Full tests**

Run: `pnpm test`

Expected: all tests pass.

**Step 3: Lint autofix**

Run: `pnpm lint --fix`

Expected: completes.

**Step 4: TypeScript**

Run: `pnpm ts-check`

Expected: PASS.

**Step 5: Final lint**

Run: `pnpm lint`

Expected: PASS.

**Step 6: Manual smoke check**

Run app manually if available. Start command that emits no newline:

```bash
node -e "let i=0; setInterval(() => process.stdout.write('tick '+(++i)+' '), 500)"
```

Expected:
- Logs panel updates before newline.
- Auto-scroll follows pending output when at bottom.
- Search finds pending and completed output.
- Clearing logs clears chunks and pending line.

---

## Implementation Notes

- Keep IPC channel name `project:commands:run:log`; only payload semantics change from line to raw text.
- Do not keep compatibility for old `line`/`partial` shape; no persisted log event data exists.
- Search can flatten/filter chunks because search is user-initiated and not hot path.
- Normal render path must not flatten all chunks on every log batch.
- Avoid creating new chunk objects for existing chunks during append. Only clone the active chunk and add new chunk objects.
- Preserve existing `MAX_RUN_COMMAND_LOG_LINES = 5000` behavior via chunk caps.
- Keep stdout/stderr separate in batch buffers even though current PTY `onData` emits stdout only; types already support both.
