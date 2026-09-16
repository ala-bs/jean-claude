import { describe, expect, it } from 'vitest';

import {
  formatDayLabel,
  groupCommitsByDay,
  layoutCommitLanes,
  traceBranchLine,
  traceRefLine,
} from './utils-commit-lanes';
import type { ProjectGitCommit, ProjectGitRef } from '@shared/types';

function commit(
  hash: string,
  parents: string[],
  date = '2026-09-06T10:00:00Z',
  refs: ProjectGitRef[] = [],
): ProjectGitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: 'PL',
    date,
    refs,
    subject: `subject ${hash}`,
  };
}

const DATE = '2026-09-06T10:00:00Z';

function branchRef(name: string): ProjectGitRef {
  return { name, kind: 'branch', isHead: false };
}

describe('layoutCommitLanes', () => {
  it('keeps a linear history in lane 0', () => {
    const { rows, maxLane } = layoutCommitLanes([
      commit('a', ['b']),
      commit('b', ['c']),
      commit('c', []),
    ]);

    expect(maxLane).toBe(0);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.every((row) => row.forks.length === 0)).toBe(true);
    expect(rows.every((row) => row.joins.length === 0)).toBe(true);
  });

  it('opens a lane for a merge and closes it at the branch point', () => {
    // a merges b (trunk) and c (topic); both reach d.
    const { rows, maxLane } = layoutCommitLanes([
      commit('a', ['b', 'c']),
      commit('b', ['d']),
      commit('c', ['d']),
      commit('d', []),
    ]);

    expect(maxLane).toBe(1);

    const [a, b, c, d] = rows;
    expect(a.isMerge).toBe(true);
    expect(a.lane).toBe(0);
    // The second parent forks out to a new lane on the right.
    expect(a.forks).toEqual([1]);

    expect(b.lane).toBe(0);
    expect(c.lane).toBe(1);
    // While c sits in lane 1, lane 0 is still open heading for d.
    expect(c.through).toEqual([0]);

    // d is awaited by both lanes: it lands on the leftmost and lane 1 joins in.
    expect(d.lane).toBe(0);
    expect(d.joins).toEqual([1]);
    expect(d.isMerge).toBe(false);
  });

  it('reuses a lane already heading for the same parent', () => {
    // Both of a's parents are b, which must not open a duplicate lane.
    const { rows, maxLane } = layoutCommitLanes([
      commit('a', ['b', 'b']),
      commit('b', []),
    ]);

    expect(maxLane).toBe(0);
    expect(rows[0].forks).toEqual([]);
  });

  it('frees a lane so later branches reuse it instead of drifting right', () => {
    const { maxLane } = layoutCommitLanes([
      commit('a', ['b', 'c']),
      commit('c', ['b']),
      commit('b', ['d', 'e']),
      commit('e', ['d']),
      commit('d', []),
    ]);

    // Two separate topic branches, but never open at the same time — so the
    // graph stays two lanes wide rather than growing one lane per branch.
    expect(maxLane).toBe(1);
  });

  it('starts a fresh lane for a commit nothing points at', () => {
    // A paged window can begin mid-history with no child in view.
    const { rows } = layoutCommitLanes([commit('a', ['b']), commit('z', [])]);

    expect(rows[1].lane).toBe(1);
    expect(rows[1].through).toEqual([0]);
  });
});

describe('traceBranchLine', () => {
  const trace = (commits: ProjectGitCommit[], hash: string | null) =>
    traceBranchLine({ rows: layoutCommitLanes(commits).rows, hash });

  it('walks both directions from the selection along first parents', () => {
    // trunk a → b → c, all one lane.
    const line = trace(
      [commit('a', ['b']), commit('b', ['c']), commit('c', [])],
      'b',
    );

    expect([...line].sort()).toEqual(['a', 'b', 'c']);
  });

  it('stops where the branch merges instead of running down the trunk', () => {
    //  ●   m      merge, lane 0
    //  │╲
    //  ●  │  t1   trunk, lane 0
    //  │  ●  f1   feature, lane 1
    //  │╱
    //  ●   base
    const commits = [
      commit('m', ['t1', 'f1']),
      commit('t1', ['base']),
      commit('f1', ['base']),
      commit('base', []),
    ];

    // Selecting the feature commit must not drag in the trunk or the base.
    expect([...trace(commits, 'f1')]).toEqual(['f1']);
    // The trunk line continues through its own lane.
    expect([...trace(commits, 't1')].sort()).toEqual(['base', 'm', 't1']);
  });

  it('does not highlight an unrelated branch that reuses a freed lane', () => {
    // `feat` closes lane 1 at `t0`; `fix` is then handed the same free lane.
    // Both branches are two commits long so the walk actually traverses and
    // has to stop in the right place, rather than halting on its first step.
    const commits = [
      commit('head', ['featmerge']),
      commit('featmerge', ['t0', 'feat2']),
      commit('feat2', ['feat1']),
      commit('feat1', ['t0']),
      commit('t0', ['fixmerge']),
      commit('fixmerge', ['t1', 'fix2']),
      commit('fix2', ['fix1']),
      commit('fix1', ['t1']),
      commit('t1', []),
    ];
    const { rows } = layoutCommitLanes(commits);
    const laneOf = (hash: string) =>
      rows.find((row) => row.commit.hash === hash)?.lane;

    // Precondition: the two branches genuinely share a lane index.
    expect(laneOf('feat1')).toBe(laneOf('fix1'));

    // Each branch traces its own two commits and stops — no bleed across the
    // reused lane, which is what a same-lane implementation would get wrong.
    expect([...trace(commits, 'feat1')].sort()).toEqual(['feat1', 'feat2']);
    expect([...trace(commits, 'fix2')].sort()).toEqual(['fix1', 'fix2']);
  });

  it('traces a single-commit topic branch', () => {
    // Squash-merge repos are mostly these; the highlight must not skip them.
    const commits = [
      commit('m', ['t1', 'f1']),
      commit('t1', ['base']),
      commit('f1', ['base']),
      commit('base', []),
    ];

    expect([...trace(commits, 'f1')]).toEqual(['f1']);
  });

  it('covers every row on a linear history, letting callers opt out', () => {
    // No branching means one chain through the whole window. Callers use the
    // "line is all of it" signal to skip highlighting entirely.
    const commits = [commit('a', ['b']), commit('b', ['c']), commit('c', [])];
    const { rows } = layoutCommitLanes(commits);

    expect(traceBranchLine({ rows, hash: 'b' }).size).toBe(rows.length);
  });

  it('returns nothing for no selection or an unloaded commit', () => {
    const commits = [commit('a', [])];
    expect(trace(commits, null).size).toBe(0);
    expect(trace(commits, 'not-loaded').size).toBe(0);
  });

  it('terminates on a cycle in malformed history', () => {
    const line = trace([commit('a', ['b']), commit('b', ['a'])], 'a');
    expect(line.has('a')).toBe(true);
  });
});

describe('groupCommitsByDay', () => {
  it('buckets consecutive commits sharing a local date', () => {
    const { rows } = layoutCommitLanes([
      commit('a', ['b'], '2026-09-06T10:00:00'),
      commit('b', ['c'], '2026-09-06T09:00:00'),
      commit('c', [], '2026-09-04T09:00:00'),
    ]);

    const groups = groupCommitsByDay(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it('labels an unparseable date rather than dropping the commit', () => {
    const { rows } = layoutCommitLanes([commit('a', [], 'not-a-date')]);
    const groups = groupCommitsByDay(rows);

    expect(groups[0].label).toBe('Unknown date');
    expect(groups[0].rows).toHaveLength(1);
  });
});

describe('formatDayLabel', () => {
  const now = new Date(2026, 8, 6, 14, 20);

  it('names the two most recent days', () => {
    expect(formatDayLabel(new Date(2026, 8, 6, 1, 0), now)).toBe('Today');
    expect(formatDayLabel(new Date(2026, 8, 5, 23, 0), now)).toBe('Yesterday');
  });

  it('omits the year only within the current year', () => {
    expect(formatDayLabel(new Date(2026, 8, 1), now)).not.toMatch(/2026/);
    expect(formatDayLabel(new Date(2025, 8, 1), now)).toMatch(/2025/);
  });
});

describe('traceRefLine', () => {
  it('stops at the first commit another branch already claims', () => {
    const { rows } = layoutCommitLanes([
      commit('t1', ['t0'], DATE, [branchRef('feat/x')]),
      commit('t0', ['base']),
      commit('base', ['older'], DATE, [branchRef('main')]),
      commit('older', []),
    ]);

    const line = traceRefLine({ rows, hash: 't1', refKey: 'feat/x' });

    expect([...line].sort()).toEqual(['t0', 't1']);
  });

  it('walks past a lane change, unlike the lane-shaped trace', () => {
    // `side` merges trunk in, so its first-parent chain leaves lane 0.
    const { rows } = layoutCommitLanes([
      commit('m', ['s1', 'x1'], DATE, [branchRef('side')]),
      commit('x1', ['root']),
      commit('s1', ['root']),
      commit('root', []),
    ]);

    const line = traceRefLine({ rows, hash: 'm', refKey: 'side' });

    // Exact equality matters: `x1` is the second parent, and its absence is
    // the only thing proving the walk follows `parents[0]` rather than all
    // parents. An inclusion-only assertion would pass for a full traversal.
    expect([...line].sort()).toEqual(['m', 'root', 's1']);
  });

  it('does not stop at the focused branch own remote', () => {
    // `origin/feat/x` is two commits behind local `feat/x`. Those unpushed
    // commits are still on the branch and must not be dimmed away.
    const { rows } = layoutCommitLanes([
      commit('c3', ['c2'], DATE, [branchRef('feat/x')]),
      commit('c2', ['c1']),
      commit('c1', ['base'], DATE, [
        { name: 'origin/feat/x', kind: 'remote', isHead: false },
      ]),
      commit('base', [], DATE, [branchRef('main')]),
    ]);

    const line = traceRefLine({ rows, hash: 'c3', refKey: 'feat/x' });

    expect([...line].sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('still stops at an unrelated branch remote', () => {
    const { rows } = layoutCommitLanes([
      commit('c2', ['c1'], DATE, [branchRef('feat/x')]),
      commit('c1', ['base'], DATE, [
        { name: 'origin/other', kind: 'remote', isHead: false },
      ]),
      commit('base', []),
    ]);

    expect([...traceRefLine({ rows, hash: 'c2', refKey: 'feat/x' })]).toEqual([
      'c2',
    ]);
  });

  it('ignores tags, which do not claim a commit for another branch', () => {
    const { rows } = layoutCommitLanes([
      commit('c2', ['c1'], DATE, [branchRef('main')]),
      commit('c1', ['base'], DATE, [
        { name: 'v1.0.0', kind: 'tag', isHead: false },
      ]),
      commit('base', []),
    ]);

    expect([...traceRefLine({ rows, hash: 'c2', refKey: 'main' })].sort()).toEqual(
      ['base', 'c1', 'c2'],
    );
  });

  it('is empty without a hash or a ref', () => {
    const { rows } = layoutCommitLanes([commit('a', [])]);

    expect(traceRefLine({ rows, hash: null, refKey: 'main' }).size).toBe(0);
    expect(traceRefLine({ rows, hash: 'a', refKey: null }).size).toBe(0);
    expect(traceRefLine({ rows, hash: 'missing', refKey: 'main' }).size).toBe(0);
  });

  it('terminates on a history with a cycle', () => {
    const { rows } = layoutCommitLanes([
      commit('a', ['b'], DATE, [branchRef('main')]),
      commit('b', ['a']),
    ]);

    expect(traceRefLine({ rows, hash: 'a', refKey: 'main' }).size).toBe(2);
  });
});
