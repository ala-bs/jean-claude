import type { ProjectGitRef } from '@shared/types';

/**
 * One badge's worth of refs on a commit.
 *
 * A commit that is the tip of `main` almost always also carries `origin/main`,
 * and rendering both as peers doubles the visual noise while saying nothing —
 * they are the same branch, in sync. The remote is therefore folded into the
 * local badge as a marker, and only refs with no local counterpart get a badge
 * of their own.
 *
 *   refs:  main, origin/main, feat/x, v1.2.0
 *   groups: [main •(origin/main)] [feat/x] [v1.2.0]
 */
export interface CommitRefGroup {
  /** The ref the badge is named after — the local branch when there is one. */
  ref: ProjectGitRef;
  /**
   * Stable identity for this group, used as the focused-branch value. Equal to
   * `ref.name`, extracted so call sites read as intent rather than coincidence.
   */
  key: string;
  /** Remote refs collapsed into this badge, e.g. `origin/main` under `main`. */
  remotes: ProjectGitRef[];
}

/** `origin/feature/x` → `feature/x`. Returns null for a name with no remote. */
function stripRemote(name: string): string | null {
  const slash = name.indexOf('/');
  if (slash <= 0 || slash === name.length - 1) return null;
  return name.slice(slash + 1);
}

/** A ref that names a line of development, i.e. one worth focusing. */
export function isBranchish(gitRef: ProjectGitRef): boolean {
  return gitRef.kind === 'branch' || gitRef.kind === 'remote';
}

/**
 * Rank used to order badges. The checked-out branch first — it is the one the
 * working tree actually is — then local branches, then remotes with no local
 * counterpart, then tags, then anything else git decorated the commit with.
 *
 * `isHead` is deliberately only honoured for a real branch: a detached HEAD
 * arrives from `parseRef` as a bare `{ name: 'HEAD', kind: 'other', isHead }`
 * decoration, and ranking that first would make the focused "branch" the
 * literal string `HEAD` while the actual branch sits behind the `+N` menu.
 */
function rank(gitRef: ProjectGitRef): number {
  if (gitRef.kind === 'branch') return gitRef.isHead ? 0 : 1;
  if (gitRef.kind === 'remote') return 2;
  if (gitRef.kind === 'tag') return 3;
  return 4;
}

export function groupCommitRefs(refs: ProjectGitRef[]): CommitRefGroup[] {
  const locals = new Map<string, CommitRefGroup>();
  const groups: CommitRefGroup[] = [];

  for (const gitRef of refs) {
    if (gitRef.kind !== 'branch') continue;
    const group: CommitRefGroup = { ref: gitRef, key: gitRef.name, remotes: [] };
    locals.set(gitRef.name, group);
    groups.push(group);
  }

  for (const gitRef of refs) {
    if (gitRef.kind === 'branch') continue;
    // `origin/main` belongs under `main`; `origin/gone` (deleted locally) does
    // not, and keeps its own badge so the commit does not look ref-less.
    const local =
      gitRef.kind === 'remote' ? locals.get(stripRemote(gitRef.name) ?? '') : undefined;
    if (local) {
      local.remotes.push(gitRef);
      continue;
    }
    groups.push({ ref: gitRef, key: gitRef.name, remotes: [] });
  }

  // Stable sort: ties keep git's own `%D` order rather than being reshuffled.
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => rank(a.group.ref) - rank(b.group.ref) || a.index - b.index)
    .map((entry) => entry.group);
}

/**
 * The group a freshly selected commit focuses, or null when it carries no
 * branch-like ref.
 *
 * Restricted to branches and remotes: a release commit decorated only with
 * `v1.2.0` would otherwise auto-focus the tag and have the diff pane announce
 * it as the focused *branch*. Tags stay visible as badges and can still be
 * picked deliberately from the menu — they are just never the default.
 */
export function defaultFocusedRef(refs: ProjectGitRef[]): string | null {
  return groupCommitRefs(refs).find((group) => isBranchish(group.ref))?.key ?? null;
}

/**
 * Whether `name` refers to the same line of development as `refKey`.
 *
 * `traceRefLine` needs this to tell "another branch already has this commit"
 * (stop the walk) from "this branch's own remote is a few commits behind"
 * (keep going). It cannot use `groupCommitRefs` for the job: grouping only
 * sees one commit's decorations, and a lagging `origin/feat/x` sits on an
 * *ancestor* of the `feat/x` tip, never alongside it.
 *
 * Heuristic, deliberately: git does not report the remote set here, so
 * `upstream/main` also matches local `main`. Treating two refs that genuinely
 * track the same branch as one is the benign direction — the alternative dims
 * every commit made since the last push.
 */
export function isSameBranch({
  name,
  refKey,
}: {
  name: string;
  refKey: string;
}): boolean {
  return (
    name === refKey ||
    stripRemote(name) === refKey ||
    stripRemote(refKey) === name
  );
}
