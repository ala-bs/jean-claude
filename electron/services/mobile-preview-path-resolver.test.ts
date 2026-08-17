import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resolvePathInsideRoot,
  resolveTrustedTaskRoot,
} from './mobile-preview-path-resolver';

describe('resolvePathInsideRoot', () => {
  const cleanupPaths: string[] = [];

  beforeEach(async () => {
    await mkdir(tmpdir(), { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((cleanupPath) =>
        rm(cleanupPath, { recursive: true, force: true }),
      ),
    );
  });

  it('returns canonical path for app inside root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'jc-preview-root-'));
    cleanupPaths.push(rootPath);
    const appPath = join(rootPath, 'apps', 'mobile');
    await mkdir(appPath, { recursive: true });

    await expect(
      resolvePathInsideRoot({ rootPath, relativePath: 'apps/mobile' }),
    ).resolves.toBe(await realpath(appPath));
  });

  it.each(['/tmp/app', '../app'])(
    'rejects untrusted path %s',
    async (relativePath) => {
      const rootPath = await mkdtemp(join(tmpdir(), 'jc-preview-root-'));
      cleanupPaths.push(rootPath);

      await expect(
        resolvePathInsideRoot({ rootPath, relativePath }),
      ).rejects.toThrow(/relative path|outside task scope/);
    },
  );

  it('rejects symlinks that escape root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'jc-preview-root-'));
    const outsidePath = await mkdtemp(join(tmpdir(), 'jc-preview-outside-'));
    cleanupPaths.push(rootPath, outsidePath);
    await symlink(outsidePath, join(rootPath, 'mobile'));

    await expect(
      resolvePathInsideRoot({ rootPath, relativePath: 'mobile' }),
    ).rejects.toThrow('App path resolves outside task scope');
  });

  it('accepts a genuine worktree from the project repository', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'jc-preview-git-'));
    cleanupPaths.push(parentPath);
    const projectPath = join(parentPath, 'project');
    const worktreePath = join(parentPath, 'worktree');
    await mkdir(projectPath);
    await mkdir(worktreePath);
    const commonDir = join(parentPath, 'git-common');
    const getRepositoryIdentity = vi.fn(async (repositoryPath: string) => ({
      commonDir,
      topLevel: repositoryPath,
    }));

    await expect(
      resolveTrustedTaskRoot({
        projectPath,
        worktreePath,
        getRepositoryIdentity,
      }),
    ).resolves.toBe(await realpath(worktreePath));
  });

  it('rejects a worktree path belonging to another repository', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'jc-preview-git-'));
    cleanupPaths.push(parentPath);
    const projectPath = join(parentPath, 'project');
    const unrelatedPath = join(parentPath, 'unrelated');
    await mkdir(projectPath);
    await mkdir(unrelatedPath);
    const canonicalProjectPath = await realpath(projectPath);
    const getRepositoryIdentity = vi.fn(async (repositoryPath: string) => ({
      commonDir:
        repositoryPath === canonicalProjectPath
          ? join(parentPath, 'project-git')
          : join(parentPath, 'unrelated-git'),
      topLevel: repositoryPath,
    }));

    await expect(
      resolveTrustedTaskRoot({
        projectPath,
        worktreePath: unrelatedPath,
        getRepositoryIdentity,
      }),
    ).rejects.toThrow('Task worktree does not belong to project repository');
  });

  it('maps a project repository subdirectory into the task worktree', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'jc-preview-git-'));
    cleanupPaths.push(parentPath);
    const repositoryPath = join(parentPath, 'repository');
    const projectPath = join(repositoryPath, 'apps', 'mobile');
    const worktreePath = join(parentPath, 'worktree');
    const mappedProjectPath = join(worktreePath, 'apps', 'mobile');
    await mkdir(projectPath, { recursive: true });
    await mkdir(mappedProjectPath, { recursive: true });
    const canonicalRepositoryPath = await realpath(repositoryPath);
    const canonicalProjectPath = await realpath(projectPath);
    const canonicalWorktreePath = await realpath(worktreePath);
    const commonDir = join(parentPath, 'git-common');
    const getRepositoryIdentity = vi.fn(async (repositoryPath: string) => ({
      commonDir,
      topLevel:
        repositoryPath === canonicalProjectPath
          ? canonicalRepositoryPath
          : canonicalWorktreePath,
    }));

    await expect(
      resolveTrustedTaskRoot({
        projectPath,
        worktreePath,
        getRepositoryIdentity,
      }),
    ).resolves.toBe(await realpath(mappedProjectPath));
  });
});
