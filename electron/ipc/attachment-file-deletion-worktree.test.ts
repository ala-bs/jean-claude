import { describe, expect, it } from 'vitest';

import { isManagedAttachmentPath } from './attachment-file-deletion';

/**
 * PR draft images are written under the *worktree* rather than the project, so
 * confirm the existing attachment guard scopes correctly against a worktree
 * base. This is what keeps a draft from deleting files outside its own tmp dir.
 */
describe('pr draft image paths', () => {
  const worktreePath = '/root/.jean-claude/worktrees/proj/my-task';

  it('accepts files inside the worktree tmp dir', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: worktreePath,
        filePath: `${worktreePath}/.jean-claude/tmp/ab12cd34-shot.png`,
      }),
    ).toBe(true);
  });

  it('refuses the tmp dir itself', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: worktreePath,
        filePath: `${worktreePath}/.jean-claude/tmp`,
      }),
    ).toBe(false);
  });

  it('refuses traversal out of the tmp dir', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: worktreePath,
        filePath: `${worktreePath}/.jean-claude/tmp/../../../secrets.env`,
      }),
    ).toBe(false);
  });

  it('refuses source files in the worktree itself', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: worktreePath,
        filePath: `${worktreePath}/src/index.ts`,
      }),
    ).toBe(false);
  });

  it('refuses a sibling worktree tmp dir', () => {
    expect(
      isManagedAttachmentPath({
        projectPath: worktreePath,
        filePath:
          '/root/.jean-claude/worktrees/proj/other-task/.jean-claude/tmp/x.png',
      }),
    ).toBe(false);
  });
});
