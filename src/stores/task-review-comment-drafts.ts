import { useCallback, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface TaskReviewCommentDraft {
  body: string;
  lineStart: number;
  lineEnd?: number;
}

function lineRangeKey(lineStart: number, lineEnd?: number): string {
  return lineEnd !== undefined && lineEnd !== lineStart
    ? `${lineStart}-${lineEnd}`
    : `${lineStart}`;
}

interface TaskReviewCommentDraftsState {
  drafts: Record<string, Record<string, TaskReviewCommentDraft>>;
  setDraft: (fileKey: string, draft: TaskReviewCommentDraft) => void;
  clearDraft: (fileKey: string, lineStart: number, lineEnd?: number) => void;
}

export const useTaskReviewCommentDraftsStore =
  create<TaskReviewCommentDraftsState>()(
    persist(
      (set) => ({
        drafts: {},

        setDraft: (fileKey, draft) =>
          set((state) => {
            const lrKey = lineRangeKey(draft.lineStart, draft.lineEnd);
            const fileDrafts = state.drafts[fileKey] ?? {};
            return {
              drafts: {
                ...state.drafts,
                [fileKey]: { ...fileDrafts, [lrKey]: draft },
              },
            };
          }),

        clearDraft: (fileKey, lineStart, lineEnd) =>
          set((state) => {
            const lrKey = lineRangeKey(lineStart, lineEnd);
            const fileDrafts = state.drafts[fileKey];
            if (!fileDrafts?.[lrKey]) return state;
            const { [lrKey]: _, ...rest } = fileDrafts;
            if (Object.keys(rest).length === 0) {
              const { [fileKey]: __, ...restFiles } = state.drafts;
              return { drafts: restFiles };
            }
            return { drafts: { ...state.drafts, [fileKey]: rest } };
          }),
      }),
      { name: 'jean-claude-task-review-comment-drafts' },
    ),
  );

export function taskReviewFileKey({
  taskId,
  filePath,
  commitHash,
}: {
  taskId: string;
  filePath: string;
  commitHash?: string;
}) {
  return `${taskId}:${commitHash ?? 'worktree'}:${filePath}`;
}

export function useTaskReviewFileDrafts({
  taskId,
  filePath,
  commitHash,
}: {
  taskId: string;
  filePath: string;
  commitHash?: string;
}) {
  const fileKey = taskReviewFileKey({ taskId, filePath, commitHash });
  const setDraftAction = useTaskReviewCommentDraftsStore(
    (state) => state.setDraft,
  );
  const clearDraftAction = useTaskReviewCommentDraftsStore(
    (state) => state.clearDraft,
  );

  const setDraft = useCallback(
    (draft: TaskReviewCommentDraft) => setDraftAction(fileKey, draft),
    [fileKey, setDraftAction],
  );

  const clearDraft = useCallback(
    (lineStart: number, lineEnd?: number) =>
      clearDraftAction(fileKey, lineStart, lineEnd),
    [fileKey, clearDraftAction],
  );

  const getBody = useCallback(
    (lineStart: number, lineEnd?: number) => {
      const lrKey = lineRangeKey(lineStart, lineEnd);
      return (
        useTaskReviewCommentDraftsStore.getState().drafts[fileKey]?.[lrKey]
          ?.body ?? ''
      );
    },
    [fileKey],
  );

  const getAllDrafts = useCallback(
    () => useTaskReviewCommentDraftsStore.getState().drafts[fileKey] ?? {},
    [fileKey],
  );

  const defaultCommentFormLineRanges = useMemo(() => {
    const drafts = getAllDrafts();
    return Object.values(drafts).map((draft) => ({
      start: draft.lineStart,
      end: draft.lineEnd ?? draft.lineStart,
    }));
  }, [getAllDrafts]);

  return { setDraft, clearDraft, getBody, defaultCommentFormLineRanges };
}

export function clearTaskReviewDraftsForTask(taskId: string) {
  const prefix = `${taskId}:`;
  useTaskReviewCommentDraftsStore.setState((state) => {
    let changed = false;
    const next = { ...state.drafts };
    for (const fileKey of Object.keys(next)) {
      if (fileKey.startsWith(prefix)) {
        delete next[fileKey];
        changed = true;
      }
    }
    return changed ? { drafts: next } : state;
  });
}

export function pruneOrphanedTaskReviewDrafts(activeTaskIds: Set<string>) {
  const state = useTaskReviewCommentDraftsStore.getState();
  const taskIds = new Set<string>();
  for (const fileKey of Object.keys(state.drafts)) {
    const taskId = fileKey.slice(0, fileKey.indexOf(':'));
    if (taskId) taskIds.add(taskId);
  }

  for (const taskId of taskIds) {
    if (!activeTaskIds.has(taskId)) {
      clearTaskReviewDraftsForTask(taskId);
    }
  }
}

export function useTaskReviewDraftCountByFile({
  taskId,
  commitHash,
}: {
  taskId: string;
  commitHash?: string | null;
}) {
  const prefix = `${taskId}:${commitHash ?? 'worktree'}:`;
  const prevRef = useRef<Record<string, number>>({});

  const selector = useCallback(
    (state: TaskReviewCommentDraftsState) => {
      const counts: Record<string, number> = {};
      for (const [fileKey, fileDrafts] of Object.entries(state.drafts)) {
        if (!fileKey.startsWith(prefix)) continue;
        const filePath = fileKey.slice(prefix.length);
        const count = Object.keys(fileDrafts).length;
        if (count > 0) counts[filePath] = count;
      }

      if (shallowRecordEqual(prevRef.current, counts)) {
        return prevRef.current;
      }

      prevRef.current = counts;
      return counts;
    },
    [prefix],
  );

  return useTaskReviewCommentDraftsStore(selector);
}

function shallowRecordEqual(
  a: Record<string, number>,
  b: Record<string, number>,
) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
