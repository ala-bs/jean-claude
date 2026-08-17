import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertProjectPathUnchanged,
  omitProjectPath,
} from './project-update-validation';

describe('assertProjectPathUnchanged', () => {
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

  it('preserves updates without a supplied path', async () => {
    await expect(
      assertProjectPathUnchanged({
        currentPath: '/stored/project',
        suppliedPath: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts the exact current project path', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'jc-project-update-'));
    cleanupPaths.push(parentPath);
    const currentPath = join(parentPath, 'project');
    await mkdir(currentPath);

    await expect(
      assertProjectPathUnchanged({ currentPath, suppliedPath: currentPath }),
    ).resolves.toBeUndefined();
  });

  it('rejects a symlink alias of the current project path', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'jc-project-update-'));
    cleanupPaths.push(parentPath);
    const currentPath = join(parentPath, 'project');
    const aliasPath = join(parentPath, 'project-alias');
    await mkdir(currentPath);
    await symlink(currentPath, aliasPath);

    await expect(
      assertProjectPathUnchanged({ currentPath, suppliedPath: aliasPath }),
    ).rejects.toThrow('Project path cannot be changed');
  });

  it('rejects a different supplied project path', async () => {
    const parentPath = await mkdtemp(join(tmpdir(), 'jc-project-update-'));
    cleanupPaths.push(parentPath);
    const currentPath = join(parentPath, 'project');
    const suppliedPath = join(parentPath, 'other');
    await mkdir(currentPath);
    await mkdir(suppliedPath);

    await expect(
      assertProjectPathUnchanged({ currentPath, suppliedPath }),
    ).rejects.toThrow('Project path cannot be changed');
  });

  it('omits an unchanged path while preserving other settings', () => {
    expect(
      omitProjectPath({
        path: '/stored/project',
        name: 'Updated name',
        showPrsInFeed: true,
      }),
    ).toEqual({ name: 'Updated name', showPrsInFeed: true });
  });
});
