import { describe, expect, it } from 'vitest';

import {
  defaultFocusedRef,
  groupCommitRefs,
  isSameBranch,
} from './utils-commit-refs';
import type { ProjectGitRef } from '@shared/types';

function ref(
  name: string,
  kind: ProjectGitRef['kind'],
  isHead = false,
): ProjectGitRef {
  return { name, kind, isHead };
}

describe('groupCommitRefs', () => {
  it('folds a remote into its local branch', () => {
    const groups = groupCommitRefs([
      ref('main', 'branch'),
      ref('origin/main', 'remote'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('main');
    expect(groups[0].remotes.map((remote) => remote.name)).toEqual([
      'origin/main',
    ]);
  });

  it('folds a remote whose branch name contains slashes', () => {
    const groups = groupCommitRefs([
      ref('jean-claude/feat-x', 'branch'),
      ref('origin/jean-claude/feat-x', 'remote'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].remotes).toHaveLength(1);
  });

  it('keeps a remote with no local counterpart as its own badge', () => {
    const groups = groupCommitRefs([
      ref('main', 'branch'),
      ref('origin/gone', 'remote'),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['main', 'origin/gone']);
    expect(groups[0].remotes).toHaveLength(0);
  });

  it('orders HEAD first, then locals, remotes, tags', () => {
    const groups = groupCommitRefs([
      ref('v1.2.0', 'tag'),
      ref('origin/gone', 'remote'),
      ref('feat/x', 'branch'),
      ref('main', 'branch', true),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      'main',
      'feat/x',
      'origin/gone',
      'v1.2.0',
    ]);
  });

  it('keeps git decoration order between refs of equal rank', () => {
    const groups = groupCommitRefs([
      ref('b-branch', 'branch'),
      ref('a-branch', 'branch'),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['b-branch', 'a-branch']);
  });
});

describe('groupCommitRefs — detached HEAD', () => {
  it('does not let a bare HEAD decoration outrank the real branch', () => {
    // `parseRef` emits `{ name: 'HEAD', kind: 'other', isHead: true }` for a
    // detached HEAD. Ranking on `isHead` alone would make the focused
    // "branch" the literal string HEAD.
    const groups = groupCommitRefs([
      ref('HEAD', 'other', true),
      ref('main', 'branch'),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['main', 'HEAD']);
  });
});

describe('groupCommitRefs — degenerate input', () => {
  it('returns nothing for an undecorated commit', () => {
    expect(groupCommitRefs([])).toEqual([]);
  });

  it('keeps a remote with no branch part as its own badge', () => {
    const groups = groupCommitRefs([ref('main', 'branch'), ref('origin', 'remote')]);

    expect(groups.map((group) => group.key)).toEqual(['main', 'origin']);
    expect(groups[0].remotes).toHaveLength(0);
  });
});

describe('defaultFocusedRef', () => {
  it('is null for an undecorated commit', () => {
    expect(defaultFocusedRef([])).toBeNull();
  });

  it('prefers the checked-out branch', () => {
    expect(
      defaultFocusedRef([ref('feat/x', 'branch'), ref('main', 'branch', true)]),
    ).toBe('main');
  });

  it('never returns a remote when a local branch exists', () => {
    expect(
      defaultFocusedRef([ref('origin/main', 'remote'), ref('main', 'branch')]),
    ).toBe('main');
  });

  it('never auto-focuses a tag-only commit', () => {
    // Otherwise the diff pane announces a tag as the focused *branch*.
    expect(defaultFocusedRef([ref('v1.2.0', 'tag')])).toBeNull();
  });

  it('skips a tag in favour of a branch on the same commit', () => {
    expect(
      defaultFocusedRef([ref('v1.2.0', 'tag'), ref('main', 'branch')]),
    ).toBe('main');
  });
});

describe('isSameBranch', () => {
  it('matches a branch against its own remote, in both directions', () => {
    expect(isSameBranch({ name: 'origin/main', refKey: 'main' })).toBe(true);
    expect(isSameBranch({ name: 'main', refKey: 'origin/main' })).toBe(true);
  });

  it('matches a nested branch name against its remote', () => {
    expect(
      isSameBranch({ name: 'origin/jean-claude/feat-x', refKey: 'jean-claude/feat-x' }),
    ).toBe(true);
  });

  it('does not match unrelated branches', () => {
    expect(isSameBranch({ name: 'origin/other', refKey: 'feat/x' })).toBe(false);
    expect(isSameBranch({ name: 'main', refKey: 'feat/x' })).toBe(false);
  });
});
