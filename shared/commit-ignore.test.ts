import { describe, expect, it } from 'vitest';
import ignore from 'ignore';

import {
  addCommitIgnoreEntries,
  canUnignoreCommitPaths,
  commitIgnoreMatchPaths,
  createCommitIgnoreMatcher,
  matchesCommitIgnore,
  removeCommitIgnoreEntries,
} from './commit-ignore';

describe('createCommitIgnoreMatcher', () => {
  it('returns null when there are no effective rules', () => {
    expect(createCommitIgnoreMatcher('')).toBeNull();
    expect(createCommitIgnoreMatcher('  \n\n')).toBeNull();
  });

  it('matches the raw content byte-for-byte like a .gitignore', () => {
    // Leading whitespace is significant to git, so an indented rule must NOT
    // match here either — otherwise the UI dims a row that still gets committed.
    const content = '*.log\n  indented.txt\n# comment\ndist/\n';
    const matcher = createCommitIgnoreMatcher(content);
    const reference = ignore().add(content);
    for (const path of [
      'a.log',
      'indented.txt',
      'dist/main.js',
      'src/index.ts',
      '# comment',
    ]) {
      expect(matchesCommitIgnore(matcher, path)).toBe(reference.ignores(path));
    }
  });

  it('honours negation rules', () => {
    const matcher = createCommitIgnoreMatcher('*.log\n!debug.log');
    expect(matchesCommitIgnore(matcher, 'a.log')).toBe(true);
    expect(matchesCommitIgnore(matcher, 'debug.log')).toBe(false);
  });
});

describe('matchesCommitIgnore', () => {
  it('never throws on paths the ignore package rejects', () => {
    const matcher = createCommitIgnoreMatcher('*.log');
    expect(matchesCommitIgnore(matcher, '/abs/a.log')).toBe(false);
    expect(matchesCommitIgnore(matcher, '')).toBe(false);
    expect(matchesCommitIgnore(null, 'a.log')).toBe(false);
  });
});

describe('commitIgnoreMatchPaths', () => {
  it('includes the rename source so either end can match', () => {
    expect(
      commitIgnoreMatchPaths({ path: 'new.ts', originalPath: 'old.ts' }),
    ).toEqual(['new.ts', 'old.ts']);
    expect(commitIgnoreMatchPaths({ path: 'a.ts' })).toEqual(['a.ts']);
    expect(
      commitIgnoreMatchPaths({ path: 'a.ts', originalPath: 'a.ts' }),
    ).toEqual(['a.ts']);
  });
});

describe('addCommitIgnoreEntries', () => {
  it('appends to empty content', () => {
    expect(addCommitIgnoreEntries('', ['a.ts'])).toBe('a.ts');
  });

  it('does not accumulate blank lines across appends', () => {
    const once = addCommitIgnoreEntries('*.log\n', ['a.ts']);
    expect(once).toBe('*.log\na.ts');
    expect(addCommitIgnoreEntries(once, ['b.ts'])).toBe('*.log\na.ts\nb.ts');
  });

  it('is a no-op when the rule is already present', () => {
    expect(addCommitIgnoreEntries('a.ts', ['a.ts'])).toBe('a.ts');
  });

  it('appends several paths at once', () => {
    expect(addCommitIgnoreEntries('a.ts', ['b.ts', 'c.ts'])).toBe(
      'a.ts\nb.ts\nc.ts',
    );
  });
});

describe('removeCommitIgnoreEntries', () => {
  it('removes only literal lines', () => {
    expect(removeCommitIgnoreEntries('*.log\na.ts\nb.ts', ['a.ts'])).toBe(
      '*.log\nb.ts',
    );
  });

  it('is a no-op when the path has no literal line', () => {
    const content = '*.log';
    expect(removeCommitIgnoreEntries(content, ['a.log'])).toBe(content);
  });
});

describe('canUnignoreCommitPaths', () => {
  it('is true for a path held only by its own literal line', () => {
    expect(canUnignoreCommitPaths('a.ts', ['a.ts'])).toBe(true);
  });

  it('is false for a path held by a glob', () => {
    expect(canUnignoreCommitPaths('*.log', ['debug.log'])).toBe(false);
  });

  it('is false when a glob AND a literal line both cover the path', () => {
    // Removing `debug.log` leaves `*.log` matching, so offering "Include in
    // commit" here would be an action that silently does nothing.
    expect(canUnignoreCommitPaths('*.log\ndebug.log', ['debug.log'])).toBe(
      false,
    );
  });

  it('is true when a negation already frees the path', () => {
    expect(canUnignoreCommitPaths('*.log\n!debug.log', ['debug.log'])).toBe(
      true,
    );
  });

  it('requires every path to come free', () => {
    const content = '*.log\ndebug.log\na.ts';
    expect(canUnignoreCommitPaths(content, ['a.ts'])).toBe(true);
    expect(canUnignoreCommitPaths(content, ['a.ts', 'debug.log'])).toBe(false);
  });
});

describe('add/remove round trip', () => {
  it('restores the original content', () => {
    const content = '*.log\ndist/';
    const added = addCommitIgnoreEntries(content, ['src/a.ts']);
    expect(matchesCommitIgnore(createCommitIgnoreMatcher(added), 'src/a.ts')).toBe(
      true,
    );
    const removed = removeCommitIgnoreEntries(added, ['src/a.ts']);
    expect(removed).toBe(content);
    expect(
      matchesCommitIgnore(createCommitIgnoreMatcher(removed), 'src/a.ts'),
    ).toBe(false);
  });
});
