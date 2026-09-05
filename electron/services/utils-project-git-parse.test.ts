import { describe, expect, it } from 'vitest';

import { parseGraphLine, parseStatus } from './utils-project-git-parse';

const NUL = String.fromCharCode(0);
const US = String.fromCharCode(31);

/** Builds a `git log --graph` line the way our --pretty=format produces it. */
function graphLine(
  graph: string,
  fields: {
    hash?: string;
    shortHash?: string;
    parents?: string;
    author?: string;
    date?: string;
    refs?: string;
    subject?: string;
  } = {},
): string {
  return (
    graph +
    NUL +
    [
      fields.hash ?? 'a'.repeat(40),
      fields.shortHash ?? 'aaaaaaa',
      fields.parents ?? 'b'.repeat(40),
      fields.author ?? 'Ada',
      fields.date ?? '2026-01-01T00:00:00+00:00',
      fields.refs ?? '',
      fields.subject ?? 'do a thing',
    ].join(US)
  );
}

describe('parseStatus', () => {
  it('reads branch, upstream and ahead/behind counts', () => {
    const result = parseStatus(
      [
        '# branch.oid 0b11b37a',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +3 -2',
      ].join('\n'),
    );

    expect(result.branch).toBe('main');
    expect(result.upstream).toBe('origin/main');
    expect(result.ahead).toBe(3);
    expect(result.behind).toBe(2);
    expect(result.isDetached).toBe(false);
  });

  it('leaves ahead/behind null when the branch has no upstream', () => {
    // git omits the `# branch.ab` header entirely for unpublished branches.
    // Reporting 0/0 there would tell the user they are in sync with a remote
    // that does not exist.
    const result = parseStatus(
      ['# branch.oid 0b11b37a', '# branch.head feature'].join('\n'),
    );

    expect(result.upstream).toBeNull();
    expect(result.ahead).toBeNull();
    expect(result.behind).toBeNull();
  });

  it('detects a detached HEAD', () => {
    expect(parseStatus('# branch.head (detached)').isDetached).toBe(true);
  });

  it('counts staged, unstaged, untracked and conflicted entries', () => {
    const result = parseStatus(
      [
        '# branch.head main',
        // XY = 'M.' -> staged only
        '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
        // XY = '.M' -> unstaged only
        '1 .M N... 100644 100644 100644 aaa bbb unstaged.ts',
        // XY = 'MM' -> counts once on each side
        '1 MM N... 100644 100644 100644 aaa bbb both.ts',
        // renames use the '2 ' prefix but the same XY field
        '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
        '? untracked-one.ts',
        '? untracked-two.ts',
      ].join('\n'),
    );

    expect(result.staged).toBe(3); // staged.ts, both.ts, new.ts
    expect(result.unstaged).toBe(2); // unstaged.ts, both.ts
    expect(result.conflicted).toBe(1);
    expect(result.untracked).toBe(2);
  });

  it('reports a clean tree as all zeroes', () => {
    const result = parseStatus('# branch.head main\n# branch.ab +0 -0');

    expect(result.staged).toBe(0);
    expect(result.unstaged).toBe(0);
    expect(result.untracked).toBe(0);
    expect(result.conflicted).toBe(0);
  });
});

describe('parseGraphLine', () => {
  it('splits lane art from commit data', () => {
    const row = parseGraphLine(
      graphLine('* ', { shortHash: '0b11b37', subject: 'feat: add graph' }),
    );

    expect(row?.graph).toBe('*');
    expect(row?.commit?.shortHash).toBe('0b11b37');
    expect(row?.commit?.subject).toBe('feat: add graph');
  });

  it('keeps lane art for indented commits on other branches', () => {
    const row = parseGraphLine(graphLine('| * '));

    expect(row?.graph).toBe('| *');
    expect(row?.commit).not.toBeNull();
  });

  it('parses multiple parents for a merge commit', () => {
    const row = parseGraphLine(
      graphLine('*   ', { parents: `${'b'.repeat(40)} ${'c'.repeat(40)}` }),
    );

    expect(row?.commit?.parents).toHaveLength(2);
  });

  it('returns an empty parents list for a root commit', () => {
    const row = parseGraphLine(graphLine('* ', { parents: '' }));

    expect(row?.commit?.parents).toEqual([]);
  });

  it('classifies refs by git namespace rather than by name shape', () => {
    const row = parseGraphLine(
      graphLine('* ', {
        // git keeps the literal `tag: ` prefix even under --decorate=full.
        refs:
          'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0',
      }),
    );

    expect(row?.commit?.refs).toEqual([
      { name: 'main', kind: 'branch', isHead: true },
      { name: 'origin/main', kind: 'remote', isHead: false },
      { name: 'v1.0', kind: 'tag', isHead: false },
    ]);
  });

  it('treats a slash-containing local branch as a branch, not a remote', () => {
    // The app names its own worktree branches `jean-claude/<task>`, so a
    // name-shape heuristic would mislabel every one of them as remote.
    const row = parseGraphLine(
      graphLine('* ', { refs: 'refs/heads/jean-claude/add-feature' }),
    );

    expect(row?.commit?.refs).toEqual([
      { name: 'jean-claude/add-feature', kind: 'branch', isHead: false },
    ]);
  });

  it('marks a detached HEAD', () => {
    const row = parseGraphLine(graphLine('* ', { refs: 'HEAD' }));

    expect(row?.commit?.refs).toEqual([
      { name: 'HEAD', kind: 'other', isHead: true },
    ]);
  });

  it('yields no refs when the commit is undecorated', () => {
    expect(parseGraphLine(graphLine('* ', { refs: '' }))?.commit?.refs).toEqual(
      [],
    );
  });

  it('keeps connector-only rows so lanes stay aligned', () => {
    // git emits these between commits to route merge edges. Dropping them
    // would make the lane art fail to line up vertically.
    const row = parseGraphLine('|\\  ');

    expect(row).toEqual({ graph: '|\\', commit: null });
  });

  it('ignores blank trailing lines', () => {
    expect(parseGraphLine('')).toBeNull();
  });

  it('keeps the lane art when a record is malformed', () => {
    // Dropping the row would misalign every row beneath it — the same failure
    // the connector-row handling exists to prevent.
    const row = parseGraphLine(`* ${NUL}only${US}two`);

    expect(row).toEqual({ graph: '*', commit: null });
  });

  it('keeps a subject that itself contains the field separator', () => {
    const row = parseGraphLine(graphLine('* ', { subject: `odd${US}subject` }));

    expect(row?.commit?.subject).toBe(`odd${US}subject`);
  });

  it('preserves punctuation that collides with the ref delimiter', () => {
    // Refs are split on ', ' — a subject containing one must not be affected.
    const row = parseGraphLine(graphLine('* ', { subject: 'fix: a, b -> c' }));

    expect(row?.commit?.subject).toBe('fix: a, b -> c');
  });
});
