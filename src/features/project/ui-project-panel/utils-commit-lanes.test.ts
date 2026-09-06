import { describe, expect, it } from 'vitest';

import { formatDayLabel, groupCommitsByDay, layoutCommitLanes } from './utils-commit-lanes';
import type { ProjectGitCommit } from '@shared/types';

function commit(
  hash: string,
  parents: string[],
  date = '2026-09-06T10:00:00Z',
): ProjectGitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: 'PL',
    date,
    refs: [],
    subject: `subject ${hash}`,
  };
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
