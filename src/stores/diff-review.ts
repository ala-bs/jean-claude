import { useCallback, useMemo } from 'react';
import type { AutoReviewRule } from '@shared/types';
import { create } from 'zustand';
import { matchAutoReviewRules } from '@/lib/auto-review';
import { persist } from 'zustand/middleware';
import { useSetting } from '@/hooks/use-settings';

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
const EMPTY_RULES: AutoReviewRule[] = [];
const EMPTY_OVERRIDDEN: Record<string, number> = {};
const EMPTY_AUTO: Map<string, AutoReviewRule> = new Map();

interface DiffReviewState {
  /** taskId -> file path -> what was reviewed */
  reviewedByTask: Record<string, Record<string, ReviewedFileRecord>>;
  /**
   * taskId -> path -> when the user un-checked it even though an auto-review
   * rule matches. Without this, un-checking an auto-marked file would be undone
   * on the next render, because the rule would just re-derive it as reviewed.
   * Timestamped so a pull request scope holding only overrides can still age
   * out of storage like any other.
   */
  overriddenByTask: Record<string, Record<string, number>>;
  /** taskId -> open tab file paths (ordered) */
  tabsByTask: Record<string, string[]>;
  /** taskId -> user-made tab groups */
  groupsByTask: Record<string, DiffTabGroup[]>;
  treatment: ReviewedTreatment;

  setReviewed: (
    taskId: string,
    entries: Array<{ path: string; signature: string; autoMatched?: boolean }>,
    reviewed: boolean,
    now: number,
  ) => void;
  /** Forget overrides for files that are no longer in the diff. */
  pruneOverridesToPaths: (taskId: string, paths: Set<string>) => void;
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
      overriddenByTask: {},
      tabsByTask: {},
      groupsByTask: {},
      treatment: 'dim',

      setReviewed: (taskId, entries, reviewed, now) =>
        set((state) => {
          const current = { ...(state.reviewedByTask[taskId] ?? EMPTY_REVIEWED) };
          const overridden = {
            ...(state.overriddenByTask[taskId] ?? EMPTY_OVERRIDDEN),
          };
          for (const { path, signature, autoMatched } of entries) {
            if (reviewed) {
              current[path] = { signature, reviewedAt: now };
              // Re-checking a file clears any standing "I want to read this".
              delete overridden[path];
            } else {
              delete current[path];
              // Only auto-matched files need an override recorded; for every
              // other file, dropping the record is already enough to un-review.
              if (autoMatched) overridden[path] = now;
            }
          }
          // Writing an empty record set would create a scope key that
          // `prunePrScopes` deliberately refuses to expire (no timestamp to age
          // on), so an un-check-only pull request would linger in storage for
          // good. Drop the key instead when nothing is left in it.
          const reviewedByTask = { ...state.reviewedByTask };
          if (Object.keys(current).length > 0) reviewedByTask[taskId] = current;
          else delete reviewedByTask[taskId];

          const overriddenByTask = { ...state.overriddenByTask };
          if (Object.keys(overridden).length > 0)
            overriddenByTask[taskId] = overridden;
          else delete overriddenByTask[taskId];

          return { reviewedByTask, overriddenByTask };
        }),

      pruneOverridesToPaths: (taskId, paths) =>
        set((state) => {
          const current = state.overriddenByTask[taskId];
          if (!current) return state;
          const kept = Object.entries(current).filter(([path]) =>
            paths.has(path),
          );
          if (kept.length === Object.keys(current).length) return state;
          const overriddenByTask = { ...state.overriddenByTask };
          if (kept.length > 0)
            overriddenByTask[taskId] = Object.fromEntries(kept);
          else delete overriddenByTask[taskId];
          return { overriddenByTask };
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
            overriddenByTask: keep(state.overriddenByTask),
            tabsByTask: keep(state.tabsByTask),
            groupsByTask: keep(state.groupsByTask),
          };
        }),

      prunePrScopes: (cutoff) =>
        set((state) => {
          // A scope's age is the most recent thing the user did in it, whether
          // that was marking a file reviewed or un-checking an auto-marked one.
          // Considering only the former would strand a pull request the user
          // merely un-checked things in.
          const scopeIds = new Set([
            ...Object.keys(state.reviewedByTask),
            ...Object.keys(state.overriddenByTask),
          ]);
          const expired = new Set(
            [...scopeIds]
              .filter((scopeId) => scopeId.startsWith(PR_REVIEW_SCOPE_PREFIX))
              .filter((scopeId) => {
                const times = [
                  ...Object.values(state.reviewedByTask[scopeId] ?? {}).map(
                    (record) => record.reviewedAt,
                  ),
                  ...Object.values(state.overriddenByTask[scopeId] ?? {}),
                ];
                // No timestamps means nothing to age out on. Leave it alone
                // rather than reading "empty" as "ancient" — the scope's tabs
                // and groups hang off the same key.
                if (times.length === 0) return false;
                return Math.max(...times) < cutoff;
              }),
          );
          if (expired.size === 0) return state;
          const drop = <T,>(record: Record<string, T>) =>
            Object.fromEntries(
              Object.entries(record).filter(([scopeId]) => !expired.has(scopeId)),
            );
          return {
            reviewedByTask: drop(state.reviewedByTask),
            overriddenByTask: drop(state.overriddenByTask),
            tabsByTask: drop(state.tabsByTask),
            groupsByTask: drop(state.groupsByTask),
          };
        }),
    }),
    {
      name: 'jean-claude-diff-review',
      version: 3,
      // v2 had no override map; persisted state predating it rehydrates with
      // `overriddenByTask` undefined, which would throw on first un-check.
      // Guarded against a null/garbage blob so a corrupt entry degrades to
      // "no review state" instead of failing rehydration at boot.
      migrate: (persisted) => {
        const previous = (persisted ?? {}) as Partial<DiffReviewState>;
        return {
          ...previous,
          overriddenByTask: previous.overriddenByTask ?? {},
        } as DiffReviewState;
      },
    },
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
  const overriddenPaths = useDiffReviewStore(
    (state) => state.overriddenByTask[taskId] ?? EMPTY_OVERRIDDEN,
  );
  const treatment = useDiffReviewStore((state) => state.treatment);
  const setReviewedAction = useDiffReviewStore((state) => state.setReviewed);
  const setTreatment = useDiffReviewStore((state) => state.setTreatment);

  const { data: autoReview, isPending: autoReviewPending } =
    useSetting('autoReview');
  const rules = autoReview?.rules ?? EMPTY_RULES;

  const overridden = useMemo(
    () => new Set(Object.keys(overriddenPaths)),
    [overriddenPaths],
  );

  /**
   * Path -> the rule that claimed it. Derived every render rather than stored,
   * which is what makes a settings edit take effect immediately instead of
   * leaving stale marks behind.
   */
  const autoReviewedBy = useMemo(() => {
    if (!signatures || rules.length === 0) return EMPTY_AUTO;
    return matchAutoReviewRules({ paths: signatures.keys(), rules });
  }, [signatures, rules]);

  const reviewed = useMemo(() => {
    const out = new Set(Object.keys(records));
    for (const path of autoReviewedBy.keys()) {
      if (!overridden.has(path)) out.add(path);
    }
    return out;
  }, [records, autoReviewedBy, overridden]);
  /**
   * Reviewed earlier, but the file changed since.
   *
   * Only files the user marked by hand can go stale. A file reviewed purely
   * because a rule claimed it is deliberately exempt: the point of the rule is
   * "I don't read these", so re-flagging it on every edit would reintroduce
   * exactly the noise the rule exists to remove. The asymmetry is intentional —
   * a file that is both hand-marked and rule-matched keeps its hand-marked
   * staleness, because the explicit action is the stronger signal.
   */
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
          // While the rules are still loading we cannot tell whether a rule
          // claims this file, so record the override anyway. An override on a
          // file no rule matches is inert (it only ever subtracts from the auto
          // set), whereas guessing `false` here would silently discard the
          // un-check as soon as the settings landed a tick later.
          autoMatched: autoReviewPending || autoReviewedBy.has(path),
        })),
        isReviewed,
        Date.now(),
      ),
    [taskId, setReviewedAction, signatures, autoReviewedBy, autoReviewPending],
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
    /** Path -> matching auto-review rule, for tinting rows in the file tree. */
    autoReviewedBy,
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

  /** Forget tabs, group entries and overrides for files that left the diff. */
  const pruneToPaths = useCallback(
    (paths: Set<string>) => {
      const state = useDiffReviewStore.getState();
      state.pruneOverridesToPaths(taskId, paths);
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
