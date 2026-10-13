import { describe, expect, it } from 'vitest';

import { repositoryPathFromGitCommonDir } from './mobile-build-store-path';

describe('repositoryPathFromGitCommonDir', () => {
  it('resolves the main repository for a regular checkout', () => {
    expect(repositoryPathFromGitCommonDir('/projects/mobile-app', '.git'))
      .toBe('/projects/mobile-app');
  });

  it('resolves the main repository for a worktree', () => {
    expect(repositoryPathFromGitCommonDir(
      '/worktrees/mobile-app-feature',
      '/projects/mobile-app/.git',
    )).toBe('/projects/mobile-app');
  });

  it('ignores an empty Git result', () => {
    expect(repositoryPathFromGitCommonDir('/projects/mobile-app', '  ')).toBeNull();
  });
});
