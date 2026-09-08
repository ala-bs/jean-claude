import type { ProjectGitCommit } from '@shared/types';

/**
 * Commit history laid out as lanes, computed from parent hashes.
 *
 * `git log --graph` also emits lane art, but only as ASCII glyphs that cannot
 * be styled, curved, or coloured per branch. Re-deriving the layout from
 * `commit.parents` gives real geometry to draw, and stays correct under
 * `--skip` paging where git's own art is only locally consistent.
 */
export interface CommitLaneRow {
  commit: ProjectGitCommit;
  /** Lane this commit's node sits in. */
  lane: number;
  /** Lanes that pass this row untouched and render as straight rails. */
  through: number[];
  /** Lanes forking down-right out of this node — a merge's extra parents. */
  forks: number[];
  /** Lanes arriving from above into this node — where a branch was created. */
  joins: number[];
  /** More than one parent, drawn as a hollow node. */
  isMerge: boolean;
}

export interface CommitLaneLayout {
  rows: CommitLaneRow[];
  /** Widest lane index used, so callers can size the graph column. */
  maxLane: number;
}

/**
 * Walks commits newest → oldest, tracking which parent hash each open lane is
 * waiting for.
 *
 * A lane is "open" while some already-rendered commit still needs it as a
 * parent. Reaching that parent closes the lane; a merge opens one new lane per
 * extra parent. Lanes are reused left-to-right so the graph stays narrow.
 *
 *   lane:  0   1              slots (hash each lane awaits)
 *   ●      A                  A → parents [B, C]: 0 keeps B, 1 opens for C
 *   │╲
 *   ●  │   B                  B → parent [D]: 0 keeps D
 *   │  ●   C                  C → parent [D]: D is already in lane 0 …
 *   │╱                        … so lane 1 joins lane 0 and closes
 *   ●      D
 */
export function layoutCommitLanes(
  commits: ProjectGitCommit[],
): CommitLaneLayout {
  /** Per lane, the hash it is waiting to reach. `null` means free. */
  const slots: (string | null)[] = [];
  const rows: CommitLaneRow[] = [];
  let maxLane = 0;

  const claimFreeLane = (): number => {
    const free = slots.indexOf(null);
    if (free !== -1) return free;
    slots.push(null);
    return slots.length - 1;
  };

  for (const commit of commits) {
    // Every lane awaiting this commit converges here. Grafts and paged windows
    // can leave a commit that nothing points at, which starts a fresh lane.
    const awaiting: number[] = [];
    slots.forEach((hash, index) => {
      if (hash === commit.hash) awaiting.push(index);
    });

    const lane = awaiting.length > 0 ? awaiting[0] : claimFreeLane();
    // The leftmost awaiting lane carries the node; the rest curve into it and
    // close, which is what a branch point looks like read top-down.
    const joins = awaiting.slice(1);
    for (const index of joins) slots[index] = null;

    const through: number[] = [];
    slots.forEach((hash, index) => {
      if (hash !== null && index !== lane && !awaiting.includes(index)) {
        through.push(index);
      }
    });

    const forks: number[] = [];
    const [firstParent, ...otherParents] = commit.parents;
    slots[lane] = firstParent ?? null;

    for (const parent of new Set(otherParents)) {
      // A malformed merge listing the same parent twice would otherwise draw a
      // curve from the node back into its own lane.
      if (parent === firstParent) continue;
      // If another lane is already heading for this parent, reuse it rather
      // than opening a duplicate that would immediately collapse again.
      const existing = slots.indexOf(parent);
      const target = existing !== -1 ? existing : claimFreeLane();
      slots[target] = parent;
      forks.push(target);
    }

    rows.push({
      commit,
      lane,
      through,
      forks,
      joins,
      isMerge: commit.parents.length > 1,
    });

    maxLane = Math.max(maxLane, lane, ...through, ...forks, ...joins);

    // Keep `slots` from growing forever on long histories; trailing free lanes
    // carry no state and would otherwise widen the graph column permanently.
    while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
  }

  return { rows, maxLane };
}

/**
 * Hashes on the same branch line as `hash`, walking both directions.
 *
 * "Same branch" is not a property git stores on a commit, and it deliberately
 * is not "same lane": `layoutCommitLanes` recycles a lane index once its branch
 * converges, so an unrelated branch inherits both the lane and its colour.
 *
 * The line is instead the first-parent chain, which is what the eye reads as
 * one continuous rail. Walking stops where the chain changes lane — that is the
 * point the branch merges into another, and following further would highlight
 * the whole trunk.
 *
 *   ● 9x0y   descendant: its parents[0] is the selection, same lane → included
 *   ◉ c3d4   selected
 *   ● a1b2   ancestor: selection's parents[0], same lane → included
 *   ●/ e5f6  ancestor of a1b2 but sits in lane 0 → chain stops above it
 *
 * Returns an empty set when `hash` is not in `rows` (e.g. the row is on a page
 * that has not loaded yet), so callers highlight nothing rather than guessing.
 *
 * Only reasons about loaded rows: a chain continuing past the end of the
 * loaded window stops there, and the line grows as further pages arrive. That
 * is why callers should treat this as "the branch line *so far*" rather than a
 * closed set.
 */
export function traceBranchLine({
  rows,
  hash,
}: {
  rows: CommitLaneRow[];
  hash: string | null;
}): Set<string> {
  const line = new Set<string>();
  if (!hash) return line;

  const byHash = new Map<string, CommitLaneRow>();
  /** First-parent children, i.e. the rows continuing a lane upward. */
  const childrenOf = new Map<string, CommitLaneRow[]>();
  for (const row of rows) {
    byHash.set(row.commit.hash, row);
    const firstParent = row.commit.parents[0];
    if (!firstParent) continue;
    const siblings = childrenOf.get(firstParent);
    if (siblings) siblings.push(row);
    else childrenOf.set(firstParent, [row]);
  }

  const start = byHash.get(hash);
  if (!start) return line;
  line.add(hash);

  // Downward: the selection's own first-parent chain, while it holds the lane.
  let current: CommitLaneRow | undefined = start;
  while (current) {
    const parent: string | undefined = current.commit.parents[0];
    const next: CommitLaneRow | undefined = parent
      ? byHash.get(parent)
      : undefined;
    // `line.has` also guards against a cycle in malformed history.
    if (!next || next.lane !== current.lane || line.has(next.commit.hash)) break;
    line.add(next.commit.hash);
    current = next;
  }

  // Upward: commits whose first parent leads back here in the same lane. A
  // branch point gives one commit several such children, so this fans out.
  const queue: CommitLaneRow[] = [start];
  while (queue.length > 0) {
    const row = queue.pop() as CommitLaneRow;
    for (const child of childrenOf.get(row.commit.hash) ?? []) {
      if (child.lane !== row.lane || line.has(child.commit.hash)) continue;
      line.add(child.commit.hash);
      queue.push(child);
    }
  }

  return line;
}

/** Lanes still open above a row, used to draw rails through a day separator. */
export function openLanesAt(row: CommitLaneRow | undefined): number[] {
  if (!row) return [];
  return [...new Set([row.lane, ...row.through, ...row.joins])].sort(
    (a, b) => a - b,
  );
}

export interface CommitDayGroup {
  key: string;
  label: string;
  rows: CommitLaneRow[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** `Today` / `Yesterday` / `Sep 6` / `Sep 6, 2025` for a commit's local date. */
export function formatDayLabel(date: Date, now = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * Buckets rows into consecutive day runs.
 *
 * Grouping is positional rather than by sorted date: `--date-order` can place
 * an older commit above a newer one across branches, and re-sorting would
 * break the lane geometry the rows were laid out with.
 */
export function groupCommitsByDay(rows: CommitLaneRow[]): CommitDayGroup[] {
  const groups: CommitDayGroup[] = [];
  const now = new Date();

  for (const row of rows) {
    const date = new Date(row.commit.date);
    const key = Number.isNaN(date.getTime())
      ? 'unknown'
      : String(startOfDay(date));
    const last = groups[groups.length - 1];

    if (last && last.key === key) {
      last.rows.push(row);
      continue;
    }

    groups.push({
      key,
      label: key === 'unknown' ? 'Unknown date' : formatDayLabel(date, now),
      rows: [row],
    });
  }

  return groups;
}
