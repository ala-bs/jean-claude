# Agent Message Comments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users select lines in agent assistant messages and add inline comments that flow through the review system into the prompt composer.

**Architecture:** The review comment infrastructure already supports message comments via `__message__:entryId` synthetic file paths and `MessageCommentParams`. We need a new `CommentableTextEntry` component that wraps the existing `TextEntry` with line-number gutters, line selection, and inline comment composer/bubbles — following the exact same pattern as `CommentableFileViewer`. The `PromptGroupEntry` passes the `ReviewContext` down so comments flow into the existing review pills and prompt synthesis pipeline.

**Tech Stack:** React, Zustand (existing review-comments store), shared `InlineCommentComposer`/`InlineCommentBubble` components, existing `ReviewContext`.

---

## Existing Infrastructure (no changes needed)

These pieces already exist and will be reused as-is:

- **`ReviewContext`** (`src/common/context/review-context/index.tsx`) — `MessageCommentParams` type, `addComment()` / `removeComment()` via context
- **`review-comments` store** (`src/stores/review-comments.ts`) — keyed by taskId, supports `__message__:entryId` anchor pattern
- **`ui-review-pills`** (`src/features/common/ui-review-pills/index.tsx`) — already handles `message` kind pills with cyan accent
- **`TaskPanel`** (`src/features/task/ui-task-panel/index.tsx:1030-1043`) — already creates `__message__:entryId` anchors for message comments
- **`InlineCommentComposer` / `InlineCommentBubble`** (`src/features/common/ui-inline-comments/index.tsx`) — shared comment UI
- **`synthesizeReviewPrompt`** — already synthesizes message comments (they have `selectedText` in anchor)
- **`handleSendMessage`** in TaskPanel (line 1883) — already appends all review comments to prompt

## What's Missing

Only the **selection UI** inside `TextEntry` — users can't currently select lines in assistant messages. We need:

1. A `CommentableTextEntry` component that renders message text as numbered lines with gutters
2. Line selection (mousedown/mouseup range) that opens the inline comment composer
3. Inline comment bubbles below commented lines
4. Wiring into `PromptGroupEntry` → `TimelineEntry` so the review context flows through

---

### Task 1: Create `CommentableTextEntry` Component

**Files:**
- Create: `src/features/agent/ui-message-stream/ui-commentable-text-entry/index.tsx`

This is the core new component. It takes the assistant message text, splits it into lines, renders them with a gutter (line numbers + comment icon on hover), handles line range selection, shows `InlineCommentComposer` and `InlineCommentBubble` for existing comments.

**Step 1: Create the component file**

```tsx
import clsx from 'clsx';
import { MessageSquarePlus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { useReviewContext } from '@/common/context/review-context';
import {
  COMMENT_ACCENT,
  InlineCommentBubble,
  InlineCommentComposer,
} from '@/features/common/ui-inline-comments';
import { useReviewComments } from '@/stores/review-comments';
import {
  getCommentedLineSet,
  groupCommentsByLine,
} from '@/stores/utils-comment-store';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { MarkdownContent } from '../../ui-markdown-content';

/**
 * Renders an assistant message as numbered lines with gutters.
 * Supports line selection for inline comments via ReviewContext.
 */
export function CommentableTextEntry({
  text,
  entryId,
  taskId,
  onFilePathClick,
}: {
  text: string;
  entryId: string;
  taskId: string;
  onFilePathClick?: (
    filePath: string,
    lineStart?: number,
    lineEnd?: number,
  ) => void;
}) {
  const reviewContext = useReviewContext();
  const [composerLineRange, setComposerLineRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);

  // Get existing comments for this message entry from review store
  const allComments = useReviewComments(taskId);
  const messageFilePath = `__message__:${entryId}`;
  const messageComments = useMemo(
    () => allComments.filter((c) => c.anchor.filePath === messageFilePath),
    [allComments, messageFilePath],
  );

  const commentsByLine = useMemo(
    () => groupCommentsByLine(messageComments),
    [messageComments],
  );
  const commentedLines = useMemo(
    () => getCommentedLineSet(messageComments),
    [messageComments],
  );

  const lines = useMemo(() => text.split('\n'), [text]);

  const handleLineMouseDown = useCallback((lineNumber: number) => {
    setSelectionStart(lineNumber);
  }, []);

  const handleLineMouseUp = useCallback(
    (lineNumber: number) => {
      if (selectionStart === null) return;
      const start = Math.min(selectionStart, lineNumber);
      const end = Math.max(selectionStart, lineNumber);
      setComposerLineRange({ start, end });
      setSelectionStart(null);
    },
    [selectionStart],
  );

  const handleMouseLeave = useCallback(() => {
    setSelectionStart(null);
    setHoveredLine(null);
  }, []);

  const isLineInSelection = useCallback(
    (lineNumber: number) => {
      if (selectionStart === null || hoveredLine === null) return false;
      const start = Math.min(selectionStart, hoveredLine);
      const end = Math.max(selectionStart, hoveredLine);
      return lineNumber >= start && lineNumber <= end;
    },
    [selectionStart, hoveredLine],
  );

  const isLineInComposerRange = useCallback(
    (lineNumber: number) => {
      if (!composerLineRange) return false;
      return (
        lineNumber >= composerLineRange.start &&
        lineNumber <= composerLineRange.end
      );
    },
    [composerLineRange],
  );

  const getSelectedText = useCallback(
    (start: number, end?: number) => {
      const startIdx = Math.max(0, start - 1);
      const endIdx = Math.min(lines.length - 1, (end ?? start) - 1);
      return lines.slice(startIdx, endIdx + 1).join('\n');
    },
    [lines],
  );

  const handleComposerSubmit = useCallback(
    (body: string, images: PromptImagePart[]) => {
      if (!composerLineRange || !reviewContext) return;
      const selectedText = getSelectedText(
        composerLineRange.start,
        composerLineRange.end,
      );
      reviewContext.addComment({
        kind: 'message',
        stepLabel: '',
        entryId,
        anchorLabel: `msg`,
        selectedText,
        body,
        presets: [],
        images: images.length > 0 ? images : undefined,
      });
      setComposerLineRange(null);
    },
    [composerLineRange, reviewContext, entryId, getSelectedText],
  );

  const handleComposerCancel = useCallback(() => {
    setComposerLineRange(null);
  }, []);

  // If no review context, fall back to plain rendering
  if (!reviewContext?.enabled) {
    return (
      <div className="relative pl-6">
        <div className="bg-ink-3 absolute top-2.5 -left-1 h-2 w-2 rounded-full" />
        <div className="text-ink-1 py-1.5 pr-3 text-xs">
          <MarkdownContent content={text} onFilePathClick={onFilePathClick} />
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-6">
      {/* Dot - gray for text */}
      <div className="bg-ink-3 absolute top-2.5 -left-1 h-2 w-2 rounded-full" />
      <div className="py-1.5 pr-3">
        <table
          className="w-full border-collapse"
          onMouseLeave={handleMouseLeave}
        >
          <tbody>
            {lines.map((lineContent, i) => {
              const lineNumber = i + 1;
              const isHovered = hoveredLine === lineNumber;
              const isSelected = isLineInSelection(lineNumber);
              const isInComposer = isLineInComposerRange(lineNumber);
              const hasComment = commentedLines.has(lineNumber);
              const lineComments = commentsByLine.get(lineNumber);
              const showComposer =
                composerLineRange && lineNumber === composerLineRange.end;

              return (
                <MessageLineRow
                  key={lineNumber}
                  lineNumber={lineNumber}
                  lineContent={lineContent}
                  isHovered={isHovered}
                  isSelected={isSelected}
                  isInComposerRange={isInComposer}
                  hasComment={hasComment}
                  onMouseEnter={() => setHoveredLine(lineNumber)}
                  onMouseDown={() => handleLineMouseDown(lineNumber)}
                  onMouseUp={() => handleLineMouseUp(lineNumber)}
                  onFilePathClick={onFilePathClick}
                  inlineComments={lineComments}
                  onRemoveComment={(commentId) =>
                    reviewContext.removeComment(commentId)
                  }
                  showComposer={!!showComposer}
                  composerLineRange={composerLineRange}
                  onComposerSubmit={handleComposerSubmit}
                  onComposerCancel={handleComposerCancel}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MessageLineRow({
  lineNumber,
  lineContent,
  isHovered,
  isSelected,
  isInComposerRange,
  hasComment,
  onMouseEnter,
  onMouseDown,
  onMouseUp,
  onFilePathClick,
  inlineComments,
  onRemoveComment,
  showComposer,
  composerLineRange,
  onComposerSubmit,
  onComposerCancel,
}: {
  lineNumber: number;
  lineContent: string;
  isHovered: boolean;
  isSelected: boolean;
  isInComposerRange: boolean;
  hasComment: boolean;
  onMouseEnter: () => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
  onFilePathClick?: (
    filePath: string,
    lineStart?: number,
    lineEnd?: number,
  ) => void;
  inlineComments:
    | Array<{
        id: string;
        anchor: { lineStart: number; lineEnd?: number };
        body: string;
        images?: PromptImagePart[];
      }>
    | undefined;
  onRemoveComment: (commentId: string) => void;
  showComposer: boolean;
  composerLineRange: { start: number; end: number } | null;
  onComposerSubmit: (body: string, images: PromptImagePart[]) => void;
  onComposerCancel: () => void;
}) {
  // Empty lines still need to render as a row for line selection
  const isEmpty = !lineContent.trim();

  return (
    <>
      <tr
        className={clsx('group/line', {
          'bg-blue-500/30': isSelected,
          'bg-blue-500/10': !isSelected && isInComposerRange,
        })}
        onMouseEnter={onMouseEnter}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        style={{
          cursor: 'pointer',
          ...(hasComment && !isSelected && !isInComposerRange
            ? { background: COMMENT_ACCENT.bg }
            : {}),
        }}
      >
        {/* Gutter */}
        <td
          className={clsx(
            'relative w-6 pr-1 text-right align-top select-none',
            hasComment && !isSelected && !isInComposerRange
              ? 'text-acc-ink'
              : 'text-ink-4',
          )}
          style={
            hasComment && !isSelected && !isInComposerRange
              ? { borderLeft: `2px solid ${COMMENT_ACCENT.barSoft}` }
              : undefined
          }
        >
          <span
            className={clsx(
              'font-mono text-[9px]',
              isHovered && 'invisible',
            )}
          >
            {lineNumber}
          </span>
          {isHovered && (
            <span className="text-acc-ink absolute inset-0 flex items-center justify-center">
              <MessageSquarePlus className="h-2.5 w-2.5" aria-hidden />
            </span>
          )}
        </td>
        {/* Content */}
        <td className="text-ink-1 select-none text-xs">
          {isEmpty ? (
            <span className="inline-block h-4" />
          ) : (
            <MarkdownContent
              content={lineContent}
              onFilePathClick={onFilePathClick}
            />
          )}
        </td>
      </tr>

      {/* Inline comments for this line */}
      {inlineComments && inlineComments.length > 0 && (
        <tr>
          <td colSpan={2} className="p-0">
            <div
              className="px-2 py-1.5"
              style={{
                background: COMMENT_ACCENT.bg,
                borderTop: `1px solid ${COMMENT_ACCENT.border}`,
                borderBottom: `1px solid ${COMMENT_ACCENT.border}`,
              }}
            >
              {inlineComments.map((comment) => (
                <InlineCommentBubble
                  key={comment.id}
                  lineStart={comment.anchor.lineStart}
                  lineEnd={comment.anchor.lineEnd}
                  body={comment.body}
                  images={comment.images}
                  onRemove={() => onRemoveComment(comment.id)}
                />
              ))}
            </div>
          </td>
        </tr>
      )}

      {/* Comment composer */}
      {showComposer && composerLineRange && (
        <tr>
          <td colSpan={2} className="p-0">
            <div
              className="px-4 py-3"
              style={{
                background: COMMENT_ACCENT.bgLight,
                borderTop: `1px solid ${COMMENT_ACCENT.borderStrong}`,
                borderBottom: `1px solid ${COMMENT_ACCENT.borderStrong}`,
              }}
            >
              <InlineCommentComposer
                lineStart={composerLineRange.start}
                lineEnd={
                  composerLineRange.start !== composerLineRange.end
                    ? composerLineRange.end
                    : undefined
                }
                onSubmit={onComposerSubmit}
                onCancel={onComposerCancel}
              />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
```

**Step 2: Verify no TypeScript errors**

Run: `pnpm ts-check`
Expected: PASS (component is self-contained, uses existing imports)

**Step 3: Commit**

```bash
git add src/features/agent/ui-message-stream/ui-commentable-text-entry/index.tsx
git commit -m "feat: add CommentableTextEntry component for message line comments"
```

---

### Task 2: Wire `CommentableTextEntry` into `TimelineEntry`

**Files:**
- Modify: `src/features/agent/ui-message-stream/ui-timeline-entry/index.tsx` (lines 817-837, 1028-1052)

The `TimelineEntry` currently renders `TextEntry` for `assistant-message` type. We need to:
1. Add `taskId` and `entryId` props to `TimelineEntry`
2. Render `CommentableTextEntry` instead of `TextEntry` for assistant messages when taskId is available

**Step 1: Update `TimelineEntry` to accept new props and use `CommentableTextEntry`**

In `src/features/agent/ui-message-stream/ui-timeline-entry/index.tsx`:

Add import at top:
```tsx
import { CommentableTextEntry } from '../ui-commentable-text-entry';
```

Update the `TimelineEntry` function signature (around line 1028) to accept `taskId`:
```tsx
export function TimelineEntry({
  entry,
  resultDurationMs,
  onFilePathClick,
  onToolDiffClick,
  taskId,
}: {
  entry: NormalizedEntry;
  resultDurationMs?: number;
  onFilePathClick?: (
    filePath: string,
    lineStart?: number,
    lineEnd?: number,
  ) => void;
  onToolDiffClick?: (
    filePath: string,
    oldString: string,
    newString: string,
  ) => void;
  taskId?: string;
}) {
```

Update the `assistant-message` case (around line 1050-1052):
```tsx
    case 'assistant-message':
      if (!entry.value.trim()) return null;
      if (taskId) {
        return (
          <CommentableTextEntry
            text={entry.value}
            entryId={entry.id}
            taskId={taskId}
            onFilePathClick={onFilePathClick}
          />
        );
      }
      return <TextEntry text={entry.value} onFilePathClick={onFilePathClick} />;
```

**Step 2: Pass `taskId` through `PromptGroupEntry` → `TimelineEntry`**

In `src/features/agent/ui-message-stream/ui-prompt-group-entry/index.tsx`:

Add `taskId` to `PromptGroupEntry` props (around line 644):
```tsx
export function PromptGroupEntry({
  group,
  isLast = false,
  isTaskRunning = false,
  previousPromptDate,
  onFilePathClick,
  onToolDiffClick,
  onPromptContextMenu,
  onEntryContextMenu,
  onToolUseContextMenu,
  onResultContextMenu,
  rootPath,
  taskId,
}: {
  // ... existing props ...
  taskId?: string;
}) {
```

Pass it to the `TimelineEntry` call (around line 999-1003):
```tsx
<TimelineEntry
  entry={dm.entry}
  onFilePathClick={onFilePathClick}
  onToolDiffClick={onToolDiffClick}
  taskId={taskId}
/>
```

**Step 3: Pass `taskId` from `MessageStream` → `PromptGroupEntry`**

In `src/features/agent/ui-message-stream/index.tsx`, the `MessageStream` component already receives `taskId` or can derive it. Find where `PromptGroupEntry` is rendered (around line 377-387) and pass `taskId`:

```tsx
<PromptGroupEntry
  // ... existing props ...
  taskId={taskId}
/>
```

Check if `MessageStream` already has `taskId` in scope — it likely comes from its parent or from route params. If not available, thread it from `TaskPanel`.

**Step 4: Also pass `taskId` to `SubagentEntry` → `TimelineEntry`**

In `src/features/agent/ui-message-stream/ui-subagent-entry/index.tsx`, add `taskId` prop and pass it to `TimelineEntry` calls inside. Same pattern.

**Step 5: Verify no TypeScript errors**

Run: `pnpm ts-check`
Expected: PASS

**Step 6: Commit**

```bash
git add src/features/agent/ui-message-stream/ui-timeline-entry/index.tsx \
        src/features/agent/ui-message-stream/ui-prompt-group-entry/index.tsx \
        src/features/agent/ui-message-stream/index.tsx \
        src/features/agent/ui-message-stream/ui-subagent-entry/index.tsx
git commit -m "feat: wire CommentableTextEntry into message stream for assistant messages"
```

---

### Task 3: Fix Comment Anchoring for Line-Level Message Comments

**Files:**
- Modify: `src/features/task/ui-task-panel/index.tsx` (around line 1030-1043)
- Modify: `src/features/common/ui-review-pills/index.tsx` (around line 32-44)

Currently `MessageCommentParams` stores `lineStart: 0` for all message comments (line 1035 in TaskPanel). The new `CommentableTextEntry` adds comments via `ReviewContext.addComment()` with proper line ranges from the `MessageCommentParams` type. But the `TaskPanel`'s `reviewContextValue.addComment` handler (line 1030-1043) currently hardcodes `lineStart: 0`.

We need to update it to pass through the `lineStart`/`lineEnd` from `MessageCommentParams` so line-level anchoring works.

**Step 1: Update the message comment branch in TaskPanel's reviewContextValue**

In `src/features/task/ui-task-panel/index.tsx`, around line 1030-1043, the message comment branch currently does:

```tsx
return addReviewCommentAction(taskId, {
  anchor: {
    filePath: `__message__:${params.entryId}`,
    lineStart: 0,
    selectedText: params.selectedText,
  },
  // ...
});
```

We don't need to change this — the `MessageCommentParams` doesn't have `lineStart`/`lineEnd` fields. But we should **add** those fields to `MessageCommentParams` so `CommentableTextEntry` can pass them.

**In `src/common/context/review-context/index.tsx`**, add optional `lineStart` and `lineEnd` to `MessageCommentParams`:

```tsx
export interface MessageCommentParams {
  kind: 'message';
  stepLabel: string;
  entryId: string;
  anchorLabel: string;
  selectedText?: string;
  /** Line number within the message text (1-based) */
  lineStart?: number;
  lineEnd?: number;
  body: string;
  presets: string[];
  images?: PromptImagePart[];
}
```

**In `src/features/task/ui-task-panel/index.tsx`**, update the message branch (around line 1032-1043):

```tsx
return addReviewCommentAction(taskId, {
  anchor: {
    filePath: `__message__:${params.entryId}`,
    lineStart: params.lineStart ?? 0,
    lineEnd: params.lineEnd,
    selectedText: params.selectedText,
  },
  body: params.body,
  images: params.images,
  presets: params.presets as ReviewPresetId[],
  status: 'open',
  resolved: false,
});
```

**Step 2: Update pill anchor label to include line info**

In `src/features/common/ui-review-pills/index.tsx`, around line 34-44, update the message branch:

```tsx
if (comment.anchor.filePath.startsWith('__message__:')) {
  const lineLabel =
    comment.anchor.lineStart > 0
      ? comment.anchor.lineEnd
        ? `:L${comment.anchor.lineStart}-${comment.anchor.lineEnd}`
        : `:L${comment.anchor.lineStart}`
      : '';
  return {
    id: comment.id,
    kind: 'message',
    anchorLabel: `msg${lineLabel}`,
    body: comment.body || comment.presets.join(', '),
    source: {
      kind: 'message',
      entryId: comment.anchor.filePath.replace('__message__:', ''),
    },
  };
}
```

**Step 3: Update `CommentableTextEntry` to pass `lineStart`/`lineEnd`**

In `src/features/agent/ui-message-stream/ui-commentable-text-entry/index.tsx`, update the `handleComposerSubmit` to pass line info:

```tsx
reviewContext.addComment({
  kind: 'message',
  stepLabel: '',
  entryId,
  anchorLabel: `msg`,
  selectedText,
  lineStart: composerLineRange.start,
  lineEnd:
    composerLineRange.start !== composerLineRange.end
      ? composerLineRange.end
      : undefined,
  body,
  presets: [],
  images: images.length > 0 ? images : undefined,
});
```

**Step 4: Verify**

Run: `pnpm ts-check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/common/context/review-context/index.tsx \
        src/features/task/ui-task-panel/index.tsx \
        src/features/common/ui-review-pills/index.tsx \
        src/features/agent/ui-message-stream/ui-commentable-text-entry/index.tsx
git commit -m "feat: support line-level anchoring for agent message comments"
```

---

### Task 4: Lint & Final Verification

**Step 1: Install deps**

Run: `pnpm install`

**Step 2: Auto-fix lint**

Run: `pnpm lint --fix`

**Step 3: TypeScript check**

Run: `pnpm ts-check`
Expected: PASS

**Step 4: Remaining lint**

Run: `pnpm lint`
Expected: PASS (or only pre-existing warnings)

**Step 5: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes for agent message comments"
```

---

## How It All Flows Together

```
User selects lines in assistant message
  → CommentableTextEntry opens InlineCommentComposer
  → User types comment, hits Cmd+Enter
  → CommentableTextEntry calls reviewContext.addComment({ kind: 'message', lineStart, lineEnd, ... })
  → TaskPanel's ReviewProvider handler creates review comment with anchor { filePath: '__message__:entryId', lineStart, lineEnd }
  → Review comment appears as pill in composer (cyan "message" kind)
  → Comment bubble shows inline below the message line
  → On send: synthesizeReviewPrompt() includes all open comments (diff + message) in prompt
  → Comments auto-resolved after send
```

## Design Decisions

1. **Reuse ReviewContext, not a new store** — Message comments are review comments. Same lifecycle (open → send → resolved). Same pills in composer. Same prompt synthesis.

2. **Line-level granularity on markdown source lines** — We split the raw markdown `text` by `\n`. Each line renders independently via `MarkdownContent`. This means a line like `## Heading` renders as a heading in its own row. Good enough — matches how code comments work on source lines.

3. **Fallback to plain TextEntry when no ReviewContext** — Outside TaskPanel (e.g. standalone previews), messages render normally without comment gutter. Zero visual regression.

4. **No line numbers visible by default** — Line numbers only appear in the gutter (tiny `text-[9px]`). Hover shows comment icon. Minimal visual noise for a non-code surface.
