import { describe, expect, it } from 'vitest';

import type { AutoReviewRule } from '@shared/types';
import { matchAutoReviewRules } from './auto-review';

function rule(partial: Partial<AutoReviewRule> & { pattern: string }) {
  return {
    id: partial.pattern,
    color: '#888888',
    enabled: true,
    ...partial,
  } satisfies AutoReviewRule;
}

describe('matchAutoReviewRules', () => {
  it('matches files against a glob', () => {
    const matched = matchAutoReviewRules({
      paths: ['src/a.ts', 'src/a.test.ts'],
      rules: [rule({ pattern: '**/*.test.ts' })],
    });
    expect([...matched.keys()]).toEqual(['src/a.test.ts']);
  });

  it('ignores disabled rules', () => {
    const matched = matchAutoReviewRules({
      paths: ['src/a.test.ts'],
      rules: [rule({ pattern: '**/*.test.ts', enabled: false })],
    });
    expect(matched.size).toBe(0);
  });

  it('lets an earlier rule shadow a later one', () => {
    const matched = matchAutoReviewRules({
      paths: ['src/a.test.ts'],
      rules: [
        rule({ pattern: '**/*.test.ts', id: 'tests', color: '#ff0000' }),
        rule({ pattern: 'src/**', id: 'source', color: '#00ff00' }),
      ],
    });
    expect(matched.get('src/a.test.ts')?.id).toBe('tests');
  });

  it('matches inside dot directories', () => {
    const matched = matchAutoReviewRules({
      paths: ['.github/workflows/ci.yml'],
      rules: [rule({ pattern: '**/*.yml' })],
    });
    expect(matched.size).toBe(1);
  });

  it('treats an unparseable pattern as matching nothing rather than throwing', () => {
    expect(() =>
      matchAutoReviewRules({
        paths: ['src/a.ts'],
        rules: [rule({ pattern: '[' })],
      }),
    ).not.toThrow();
  });

  it('skips blank patterns so a half-typed rule matches nothing', () => {
    const matched = matchAutoReviewRules({
      paths: ['src/a.ts'],
      rules: [rule({ pattern: '   ' })],
    });
    expect(matched.size).toBe(0);
  });
});

describe('repo-absolute pull request paths', () => {
  // Worktree diffs use "src/a.ts"; pull request diffs use "/src/a.ts". A rule
  // that works in one must work in the other.
  it('matches a root-level pattern against an absolute path', () => {
    const matched = matchAutoReviewRules({
      paths: ['/pnpm-lock.yaml'],
      rules: [rule({ pattern: 'pnpm-lock.yaml' })],
    });
    expect(matched.size).toBe(1);
  });

  it('matches a directory pattern against an absolute path', () => {
    const matched = matchAutoReviewRules({
      paths: ['/src/a.ts'],
      rules: [rule({ pattern: 'src/**' })],
    });
    expect(matched.size).toBe(1);
  });

  it('keys results by the original path, not the normalized one', () => {
    const matched = matchAutoReviewRules({
      paths: ['/src/a.test.ts'],
      rules: [rule({ pattern: '**/*.test.ts' })],
    });
    expect([...matched.keys()]).toEqual(['/src/a.test.ts']);
  });

  it('matches the same rule in both path conventions', () => {
    const rules = [rule({ pattern: 'docs/*.md' })];
    expect(
      matchAutoReviewRules({ paths: ['docs/x.md'], rules }).size,
    ).toBe(1);
    expect(
      matchAutoReviewRules({ paths: ['/docs/x.md'], rules }).size,
    ).toBe(1);
  });
});
