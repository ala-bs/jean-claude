import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** How reviewed files are rendered in the diff file tree. */
export type ReviewedTreatment = 'dim' | 'hide' | 'bottom';

export interface DiffTabGroup {
  id: string;
  label: string;
  paths: string[];
}

/**
 * What was reviewed, not just that it was reviewed: `signature` snapshots the
 * file's diff at the moment it was marked, so later changes make it stale.
 */
export interface ReviewedFileRecord {
  signature: string;
  reviewedAt: number;
}

/**
 * Fingerprint of a file's contribution to the diff: always the diff stats, plus
 * a content hash when the file's content is loaded. Two parts so a file marked
 * from a bulk action (stats only) can still be compared against one marked
 * while open (stats + hash) without a false "changed" flag.
 */
export function diffFileSignature({
  status,
  additions = 0,
  deletions = 0,
  content,
  revision,
}: {
  status: string;
  additions?: number;
  deletions?: number;
  content?: string | null;
  /**
   * Opaque marker for the revision the diff was read at. Pull request changes
   * carry no line counts, so `status` alone almost never moves — without this,
   * a file reviewed from the tree could never be detected as changed. Callers
   * with real diff stats (worktree diffs) can omit it.
   */
  revision?: string;
}) {
  const stats =
    `s:${status}:${additions}:${deletions}` +
    (revision ? `:r:${hashContent(revision)}` : '');
  return content == null ? stats : `${stats}#c:${hashContent(content)}`;
}

/** FNV-1a — good enough to notice an edit, cheap enough to run per file. */
function hashContent(content: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Whether a file changed since it was reviewed. The content hash only counts
 * when both signatures carry one; otherwise the diff stats decide.
 */
export function isStaleSignature(stored: string, current: string) {
  const [storedStats, storedHash] = stored.split('#');
  const [currentStats, currentHash] = current.split('#');
  if (storedStats !== currentStats) return true;
  if (storedHash && currentHash && storedHash !== currentHash) return true;
  return false;
}

/**
 * Review state is keyed by an opaque scope id. Tasks use their task id; pull
 * requests use this prefixed key so the two never collide and so PR scopes are
 * skipped by task pruning (a PR is not a task, it would be wiped otherwise).
 */
export const PR_REVIEW_SCOPE_PREFIX = 'pr:';

export function prReviewScopeId({
  projectId,
  prId,
}: {
  projectId: string;
  prId: number;
}) {
  return `${PR_REVIEW_SCOPE_PREFIX}${projectId}:${prId}`;
}

const EMPTY_PATHS: string[] = [];
const EMPTY_GROUPS: DiffTabGroup[] = [];
const EMPTY_REVIEWED: Record<string, ReviewedFileRecord> = {};

interface DiffReviewState {
  /** taskId -> file path -> what was reviewed */
  reviewedByTask: Record<string, Record<string, ReviewedFileRecord>>;
  /** taskId -> open tab file paths (ordered) */
  tabsByTask: Record<string, string[]>;
  /** taskId -> user-made tab groups */
  groupsByTask: Record<string, DiffTabGroup[]>;
  treatment: ReviewedTreatment;

  setReviewed: (
    taskId: string,
    entries: Array<{ path: string; signature: string }>,
    reviewed: boolean,
    now: number,
  ) => void;
  setTabs: (taskId: string, paths: string[]) => void;
  setGroups: (taskId: string, groups: DiffTabGroup[]) => void;
  setTreatment: (treatment: ReviewedTreatment) => void;
  pruneTasks: (activeTaskIds: Set<string>) => void;
  prunePrScopes: (cutoff: number) => void;
}

/**
 * PR review state has no lifecycle signal to hang cleanup on — a merged PR is
 * still fetchable and a reviewer may come back to it — so it expires by age
 * instead: a PR untouched for this long drops out of storage.
 */
export const PR_REVIEW_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

export const useDiffReviewStore = create<DiffReviewState>()(
  persist(
    (set) => ({
      reviewedByTask: {},
      tabsByTask: {},
      groupsByTask: {},
      treatment: 'dim',

      setReviewed: (taskId, entries, reviewed, now) =>
        set((state) => {
          const current = { ...(state.reviewedByTask[taskId] ?? EMPTY_REVIEWED) };
          for (const { path, signature } of entries) {
            if (reviewed) current[path] = { signature, reviewedAt: now };
            else delete current[path];
          }
          return {
            reviewedByTask: { ...state.reviewedByTask, [taskId]: current },
          };
        }),

      setTabs: (taskId, paths) =>
        set((state) => ({
          tabsByTask: { ...state.tabsByTask, [taskId]: paths },
        })),

      setGroups: (taskId, groups) =>
        set((state) => ({
          groupsByTask: { ...state.groupsByTask, [taskId]: groups },
        })),

      setTreatment: (treatment) => set({ treatment }),

      pruneTasks: (activeTaskIds) =>
        set((state) => {
          const keep = <T,>(record: Record<string, T>) =>
            Object.fromEntries(
              Object.entries(record).filter(
                ([scopeId]) =>
                  scopeId.startsWith(PR_REVIEW_SCOPE_PREFIX) ||
                  activeTaskIds.has(scopeId),
              ),
            );
          return {
            reviewedByTask: keep(state.reviewedByTask),
            tabsByTask: keep(state.tabsByTask),
            groupsByTask: keep(state.groupsByTask),
          };
        }),

      prunePrScopes: (cutoff) =>
        set((state) => {
          const expired = new Set(
            Object.entries(state.reviewedByTask)
              .filter(([scopeId]) => scopeId.startsWith(PR_REVIEW_SCOPE_PREFIX))
              .filter(([, records]) => {
                const times = Object.values(records).map((r) => r.reviewedAt);
                // No reviewed files means no timestamp to age out on. Leave it
                // alone rather than reading "empty" as "ancient" — the scope's
                // tabs and groups hang off the same key.
                if (times.length === 0) return false;
                return Math.max(...times) < cutoff;
              })
              .map(([scopeId]) => scopeId),
          );
          if (expired.size === 0) return state;
          const drop = <T,>(record: Record<string, T>) =>
            Object.fromEntries(
              Object.entries(record).filter(([scopeId]) => !expired.has(scopeId)),
            );
          return {
            reviewedByTask: drop(state.reviewedByTask),
            tabsByTask: drop(state.tabsByTask),
            groupsByTask: drop(state.groupsByTask),
          };
        }),
    }),
    { name: 'jean-claude-diff-review', version: 2 },
  ),
);

/**
 * Reviewed-file state and actions for a task.
 *
 * `signatures` maps each file path to its current diff signature; a reviewed
 * file whose signature moved on is reported as stale (needs a re-read).
 */
export function useDiffReview(
  taskId: string,
  signatures?: Map<string, string>,
) {
  const records = useDiffReviewStore(
    (state) => state.reviewedByTask[taskId] ?? EMPTY_REVIEWED,
  );
  const treatment = useDiffReviewStore((state) => state.treatment);
  const setReviewedAction = useDiffReviewStore((state) => state.setReviewed);
  const setTreatment = useDiffReviewStore((state) => state.setTreatment);

  const reviewed = useMemo(() => new Set(Object.keys(records)), [records]);
  /** Reviewed earlier, but the file changed since. */
  const stale = useMemo(() => {
    const out = new Set<string>();
    if (!signatures) return out;
    for (const [path, record] of Object.entries(records)) {
      const current = signatures.get(path);
      // An empty stored signature means the diff wasn't known when the file was
      // marked; there's nothing to compare against, so don't cry "changed".
      if (!record.signature) continue;
      if (current && isStaleSignature(record.signature, current)) out.add(path);
    }
    return out;
  }, [records, signatures]);

  const setReviewed = useCallback(
    (paths: string[], isReviewed: boolean) =>
      setReviewedAction(
        taskId,
        paths.map((path) => ({
          path,
          signature: signatures?.get(path) ?? '',
        })),
        isReviewed,
        Date.now(),
      ),
    [taskId, setReviewedAction, signatures],
  );
  const toggleReviewed = useCallback(
    (path: string) => setReviewed([path], !reviewed.has(path)),
    [setReviewed, reviewed],
  );
  const cycleTreatment = useCallback(
    () =>
      setTreatment(
        treatment === 'dim' ? 'hide' : treatment === 'hide' ? 'bottom' : 'dim',
      ),
    [treatment, setTreatment],
  );

  return {
    reviewed,
    stale,
    treatment,
    setReviewed,
    toggleReviewed,
    cycleTreatment,
  };
}

/** Open diff tabs and user-made groups for a task. */
export function useDiffTabs(taskId: string) {
  const tabs = useDiffReviewStore(
    (state) => state.tabsByTask[taskId] ?? EMPTY_PATHS,
  );
  const groups = useDiffReviewStore(
    (state) => state.groupsByTask[taskId] ?? EMPTY_GROUPS,
  );
  const setTabsAction = useDiffReviewStore((state) => state.setTabs);
  const setGroupsAction = useDiffReviewStore((state) => state.setGroups);

  const setTabs = useCallback(
    (paths: string[]) => setTabsAction(taskId, paths),
    [taskId, setTabsAction],
  );
  const setGroups = useCallback(
    (next: DiffTabGroup[]) => setGroupsAction(taskId, next),
    [taskId, setGroupsAction],
  );

  const openTab = useCallback(
    (path: string) => {
      const current =
        useDiffReviewStore.getState().tabsByTask[taskId] ?? EMPTY_PATHS;
      if (current.includes(path)) return;
      setTabsAction(taskId, [...current, path]);
    },
    [taskId, setTabsAction],
  );

  const closeTabs = useCallback(
    (paths: string[]) => {
      const state = useDiffReviewStore.getState();
      const closing = new Set(paths);
      setTabsAction(
        taskId,
        (state.tabsByTask[taskId] ?? EMPTY_PATHS).filter(
          (path) => !closing.has(path),
        ),
      );
      const nextGroups = (state.groupsByTask[taskId] ?? EMPTY_GROUPS)
        .map((group) => ({
          ...group,
          paths: group.paths.filter((path) => !closing.has(path)),
        }))
        .filter((group) => group.paths.length > 0);
      setGroupsAction(taskId, nextGroups);
    },
    [taskId, setTabsAction, setGroupsAction],
  );

  /** Forget tabs and group entries for files that left the diff. */
  const pruneToPaths = useCallback(
    (paths: Set<string>) => {
      const state = useDiffReviewStore.getState();
      const currentTabs = state.tabsByTask[taskId] ?? EMPTY_PATHS;
      const nextTabs = currentTabs.filter((path) => paths.has(path));
      if (nextTabs.length !== currentTabs.length) setTabsAction(taskId, nextTabs);

      const currentGroups = state.groupsByTask[taskId] ?? EMPTY_GROUPS;
      const nextGroups = currentGroups
        .map((group) => ({
          ...group,
          paths: group.paths.filter((path) => paths.has(path)),
        }))
        .filter((group) => group.paths.length > 0);
      const changed =
        nextGroups.length !== currentGroups.length ||
        nextGroups.some(
          (group, index) =>
            group.paths.length !== currentGroups[index]?.paths.length,
        );
      if (changed) setGroupsAction(taskId, nextGroups);
    },
    [taskId, setTabsAction, setGroupsAction],
  );

  return { tabs, groups, setTabs, setGroups, openTab, closeTabs, pruneToPaths };
}

export function pruneOrphanedDiffReviewState(activeTaskIds: Set<string>) {
  useDiffReviewStore.getState().pruneTasks(activeTaskIds);
}

/** Drop review state for pull requests untouched for {@link PR_REVIEW_MAX_AGE_MS}. */
export function pruneStalePrReviewState(now = Date.now()) {
  useDiffReviewStore.getState().prunePrScopes(now - PR_REVIEW_MAX_AGE_MS);
}
