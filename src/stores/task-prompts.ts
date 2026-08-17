import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCallback } from 'react';

import type { PromptFilePart } from '@shared/agent-backend-types';
import {
  deleteAttachmentFiles,
  findMissingAttachmentPaths,
} from '@/lib/prompt-attachment-cleanup';

const MAX_TASKS = 100;

const EMPTY_FILES: PromptFilePart[] = [];

interface TaskPromptEntry {
  text: string;
  updatedAt: number;
  /**
   * File attachments (including large pasted content written to disk).
   * Optional so drafts persisted before attachments were supported still hydrate.
   */
  files?: PromptFilePart[];
  /**
   * Project path that owns the attachment files. Persisted on the entry so the
   * imperative prune path can delete them without resolving the task first.
   */
  projectPath?: string;
}

type FilesUpdate =
  | PromptFilePart[]
  | ((prev: PromptFilePart[]) => PromptFilePart[]);

interface TaskPromptsState {
  drafts: Record<string, TaskPromptEntry>;
  setDraft: (taskId: string, text: string) => void;
  setFiles: (
    taskId: string,
    update: FilesUpdate,
    projectPath: string | null,
  ) => void;
  clearDraft: (taskId: string) => void;
}

/**
 * Trim the draft map to `limit` entries, keeping the most recently updated.
 * Returns the evicted entries so the caller can reclaim their files *after*
 * the state update — store updaters must stay free of side effects.
 */
function evictOldest(
  drafts: Record<string, TaskPromptEntry>,
  limit: number,
): { drafts: Record<string, TaskPromptEntry>; evicted: TaskPromptEntry[] } {
  const entries = Object.entries(drafts);
  if (entries.length <= limit) return { drafts, evicted: [] };

  const sorted = entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
  return {
    drafts: Object.fromEntries(sorted.slice(0, limit)),
    evicted: sorted.slice(limit).map(([, entry]) => entry),
  };
}

function reclaim(entries: TaskPromptEntry[]) {
  for (const entry of entries) {
    void deleteAttachmentFiles({
      projectPath: entry.projectPath,
      files: entry.files,
    });
  }
}

/**
 * Write one draft entry, dropping it entirely when nothing is left to remember.
 *
 * Empty entries matter: submitting clears the text and files, and without this
 * every sent message would leave a `{text:'', files:[]}` placeholder behind.
 * Enough of those fill the LRU cap and start evicting — and eviction now
 * deletes attachment files, so junk entries could cost a real task its files.
 */
function writeEntry(
  drafts: Record<string, TaskPromptEntry>,
  taskId: string,
  entry: TaskPromptEntry,
): { drafts: Record<string, TaskPromptEntry>; evicted: TaskPromptEntry[] } {
  if (entry.text === '' && !entry.files?.length) {
    const { [taskId]: _dropped, ...rest } = drafts;
    return { drafts: rest, evicted: [] };
  }

  return evictOldest({ ...drafts, [taskId]: entry }, MAX_TASKS);
}

const useStore = create<TaskPromptsState>()(
  persist(
    (set, get) => ({
      drafts: {},

      setDraft: (taskId, text) => {
        const prev = get().drafts[taskId];
        const { drafts, evicted } = writeEntry(get().drafts, taskId, {
          ...prev,
          text,
          updatedAt: Date.now(),
        });

        set({ drafts });
        reclaim(evicted);
      },

      setFiles: (taskId, update, projectPath) => {
        const prev = get().drafts[taskId];
        const files =
          typeof update === 'function'
            ? update(prev?.files ?? EMPTY_FILES)
            : update;

        const { drafts, evicted } = writeEntry(get().drafts, taskId, {
          ...prev,
          text: prev?.text ?? '',
          files,
          projectPath: projectPath ?? prev?.projectPath,
          updatedAt: Date.now(),
        });

        set({ drafts });
        reclaim(evicted);
      },

      clearDraft: (taskId) =>
        set((state) => {
          const { [taskId]: _, ...rest } = state.drafts;
          return { drafts: rest };
        }),
    }),
    { name: 'task-prompts' },
  ),
);

// Direct store access for non-React contexts
export const useTaskPromptsStore = useStore;

/**
 * Imperative cleanup — call outside React to clear a task's prompt draft.
 * Does NOT delete attachment files: this runs on submit, where the sent message
 * still references their paths.
 */
export function clearTaskPromptDraft(taskId: string) {
  useStore.getState().clearDraft(taskId);
}

/** Remove persisted prompt drafts for tasks that no longer exist or are completed. */
export function pruneOrphanedTaskPrompts(activeTaskIds: Set<string>) {
  const state = useStore.getState();
  for (const taskId of Object.keys(state.drafts)) {
    if (!activeTaskIds.has(taskId)) {
      const entry = state.drafts[taskId];
      state.clearDraft(taskId);
      void deleteAttachmentFiles({
        projectPath: entry.projectPath,
        files: entry.files,
      });
    }
  }
}

/**
 * Drop persisted attachments whose file no longer exists on disk. Silent by
 * design — the user can just re-attach.
 */
export async function reconcileTaskPromptFiles(taskId: string) {
  const snapshot = useStore.getState().drafts[taskId];
  if (!Array.isArray(snapshot?.files) || snapshot.files.length === 0) return;

  const missing = await findMissingAttachmentPaths(snapshot.files);
  if (missing.size === 0) return;

  // Re-read through a functional update: files attached while the existence
  // checks were in flight must survive.
  useStore
    .getState()
    .setFiles(
      taskId,
      (current) => current.filter((file) => !missing.has(file.filePath)),
      null,
    );
}

export function useTaskPrompt(taskId: string) {
  const text = useStore((state) => state.drafts[taskId]?.text ?? '');
  // Returns the stored array reference or a module-level constant, so the
  // selector output is already referentially stable.
  const files = useStore((state) => state.drafts[taskId]?.files ?? EMPTY_FILES);
  const setDraftAction = useStore((state) => state.setDraft);
  const setFilesAction = useStore((state) => state.setFiles);
  const clearDraftAction = useStore((state) => state.clearDraft);

  const setDraft = useCallback(
    (newText: string) => setDraftAction(taskId, newText),
    [taskId, setDraftAction],
  );

  const setFiles = useCallback(
    (update: FilesUpdate, projectPath: string | null) =>
      setFilesAction(taskId, update, projectPath),
    [taskId, setFilesAction],
  );

  const clearDraft = useCallback(
    () => clearDraftAction(taskId),
    [taskId, clearDraftAction],
  );

  return { text, files, setDraft, setFiles, clearDraft };
}
