import { describe, expect, it } from 'vitest';

import {
  buildGraphArgs,
  looksLikeCommitHash,
  parseCommitDetail,
  parseCommitDiffFiles,
  parseGraphLine,
  parseStatus,
  parseStatusFiles,
} from './utils-project-git-parse';

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

describe('parseStatusFiles', () => {
  it('reads ordinary, renamed, untracked and conflicted entries', () => {
    const files = parseStatusFiles(
      [
        '# branch.head main',
        '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
        '1 .M N... 100644 100644 100644 aaa bbb src/unstaged.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
        '? src/untracked.ts',
      ].join('\n'),
    );

    expect(files).toEqual([
      { path: 'src/staged.ts', state: 'staged' },
      { path: 'src/unstaged.ts', state: 'unstaged' },
      // A rename is reported under its new path; the old one is not listed.
      { path: 'src/new.ts', state: 'staged' },
      { path: 'src/conflict.ts', state: 'conflicted' },
      { path: 'src/untracked.ts', state: 'untracked' },
    ]);
  });

  it('lists a file modified on both sides once per side', () => {
    // This is what makes the totals match ProjectGitStatus's counts.
    const files = parseStatusFiles(
      '1 MM N... 100644 100644 100644 aaa bbb src/both.ts',
    );

    expect(files).toEqual([
      { path: 'src/both.ts', state: 'staged' },
      { path: 'src/both.ts', state: 'unstaged' },
    ]);
  });

  it('keeps spaces in a path intact', () => {
    // porcelain v2 leaves spaces unquoted, so the path must be re-joined
    // rather than read as a single whitespace-delimited field.
    const files = parseStatusFiles(
      '1 .M N... 100644 100644 100644 aaa bbb docs/my notes.md',
    );

    expect(files).toEqual([{ path: 'docs/my notes.md', state: 'unstaged' }]);
  });

  it('agrees with parseStatus on the counts', () => {
    const stdout = [
      '1 M. N... 100644 100644 100644 aaa bbb a.ts',
      '1 MM N... 100644 100644 100644 aaa bbb b.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc c.ts',
      '? d.ts',
    ].join('\n');

    const counts = parseStatus(stdout);
    const files = parseStatusFiles(stdout);
    const countOf = (state: string) =>
      files.filter((file) => file.state === state).length;

    expect(countOf('staged')).toBe(counts.staged);
    expect(countOf('unstaged')).toBe(counts.unstaged);
    expect(countOf('untracked')).toBe(counts.untracked);
    expect(countOf('conflicted')).toBe(counts.conflicted);
  });
});

describe('buildGraphArgs', () => {
  it('walks every ref and draws lane art when unfiltered', () => {
    const args = buildGraphArgs({ limit: 60 });

    expect(args).toContain('--graph');
    expect(args).toContain('--all');
    expect(args).not.toContain('--fixed-strings');
  });

  it('drops the lane art once a filter selects commits out of the history', () => {
    // The art describes a contiguous walk; keeping it would draw edges between
    // commits that are not actually parent and child.
    expect(buildGraphArgs({ limit: 60, query: 'fix' })).not.toContain('--graph');
    expect(buildGraphArgs({ limit: 60, branches: ['main'] })).not.toContain(
      '--graph',
    );
  });

  it('searches literally, so a query with regex characters is not a syntax error', () => {
    const args = buildGraphArgs({ limit: 60, query: 'fix(ui)' });

    expect(args).toContain('--grep=fix(ui)');
    expect(args).toContain('--fixed-strings');
    expect(args).toContain('--regexp-ignore-case');
  });

  it('replaces the ref set with explicit branches rather than adding to it', () => {
    const args = buildGraphArgs({ limit: 60, branches: ['main', 'feature/x'] });

    // `--all` alongside a branch list would silently walk everything.
    expect(args).not.toContain('--all');
    expect(args).toContain('main');
    expect(args).toContain('feature/x');
  });

  it('terminates revision parsing so a ref cannot be read as a path', () => {
    expect(buildGraphArgs({ limit: 60 }).at(-1)).toBe('--');
  });

  it('pages by commit offset', () => {
    expect(buildGraphArgs({ limit: 60, skip: 120 })).toContain('--skip=120');
    expect(buildGraphArgs({ limit: 60 })).not.toContain('--skip=0');
  });
});

describe('looksLikeCommitHash', () => {
  it('accepts hex strings long enough to name a commit', () => {
    expect(looksLikeCommitHash('5b5146a3')).toBe(true);
    expect(looksLikeCommitHash('ABCD')).toBe(true);
  });

  it('rejects text queries and prefixes too short to be worth resolving', () => {
    expect(looksLikeCommitHash('fix')).toBe(false);
    expect(looksLikeCommitHash('ab')).toBe(false);
    expect(looksLikeCommitHash('reduce task churn')).toBe(false);
    // 'g' is not a hex digit.
    expect(looksLikeCommitHash('deadbeeg')).toBe(false);
  });
});

describe('parseCommitDiffFiles', () => {
  const numstat = ['3\t1\tsrc/a.ts', '10\t0\tsrc/b.ts'].join('\n');

  it('joins name-status and numstat on the path', () => {
    const files = parseCommitDiffFiles({
      nameStatus: ['M\tsrc/a.ts', 'A\tsrc/b.ts'].join('\n'),
      numstat,
    });

    expect(files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 },
      { path: 'src/b.ts', status: 'added', additions: 10, deletions: 0 },
    ]);
  });

  it('reports a binary file as zero counts rather than NaN', () => {
    const files = parseCommitDiffFiles({
      nameStatus: 'M\tlogo.png',
      numstat: '-\t-\tlogo.png',
    });

    expect(files).toEqual([
      { path: 'logo.png', status: 'modified', additions: 0, deletions: 0 },
    ]);
  });

  it('keeps the new path of a rename, which is the side content can be read from', () => {
    const files = parseCommitDiffFiles({
      nameStatus: 'R100\tsrc/old.ts\tsrc/new.ts',
      numstat: '0\t0\tsrc/new.ts',
    });

    expect(files[0].path).toBe('src/new.ts');
    expect(files[0].status).toBe('modified');
  });

  it('falls back to zero counts for a path missing from numstat', () => {
    const files = parseCommitDiffFiles({
      nameStatus: 'D\tsrc/gone.ts',
      numstat: '',
    });

    expect(files).toEqual([
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 0 },
    ]);
  });
});

describe('parseCommitDetail', () => {
  const fields = (values: string[]) => values.join(US);

  it('reads the header emitted by COMMIT_DETAIL_FORMAT', () => {
    const detail = parseCommitDetail(
      fields([
        '5b5146a3f0',
        '5b5146a',
        'aaaa bbbb',
        'Patrick Lin',
        'patrick@example.dev',
        '2026-09-06T14:20:00+02:00',
        'HEAD -> refs/heads/main, refs/remotes/origin/main',
        'clarify active command focus',
        'A longer explanation.',
      ]),
    );

    expect(detail).not.toBeNull();
    expect(detail?.shortHash).toBe('5b5146a');
    expect(detail?.parents).toEqual(['aaaa', 'bbbb']);
    expect(detail?.authorEmail).toBe('patrick@example.dev');
    expect(detail?.subject).toBe('clarify active command focus');
    expect(detail?.body).toBe('A longer explanation.');
    expect(detail?.refs).toEqual([
      { name: 'main', kind: 'branch', isHead: true },
      { name: 'origin/main', kind: 'remote', isHead: false },
    ]);
  });

  it('treats a root commit as having no parents', () => {
    const detail = parseCommitDetail(
      fields([
        'aaaa',
        'aaaa',
        '',
        'Patrick Lin',
        'patrick@example.dev',
        '2026-09-06T14:20:00+02:00',
        '',
        'initial commit',
        '',
      ]),
    );

    expect(detail?.parents).toEqual([]);
  });

  it('keeps a body that itself contains the separator byte', () => {
    const detail = parseCommitDetail(
      fields([
        'aaaa',
        'aaaa',
        'bbbb',
        'Patrick Lin',
        'patrick@example.dev',
        '2026-09-06T14:20:00+02:00',
        '',
        'subject',
        `before${US}after`,
      ]),
    );

    expect(detail?.body).toBe(`before${US}after`);
  });

  it('returns null for output too short to be a commit header', () => {
    expect(parseCommitDetail('')).toBeNull();
    expect(parseCommitDetail(fields(['aaaa', 'aaaa']))).toBeNull();
  });
});
