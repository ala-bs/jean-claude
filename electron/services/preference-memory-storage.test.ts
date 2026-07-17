import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertSafeProjectPreferenceMemoryTree,
  getPreferenceMemoryProjectKey,
  getPreferenceMemoryProjectsDir,
  getPreferenceMemoryRootDir,
  getProjectPreferenceMemoryDir,
  removeProjectPreferenceMemory,
  writeProjectPreferenceMemoryMetadata,
} from './preference-memory-storage';

let homeDirectory: string;

beforeEach(async () => {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  homeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'jc-preference-memory-storage-'),
  );
});

afterEach(async () => {
  await fs.rm(homeDirectory, { force: true, recursive: true });
});

describe('preference memory storage', () => {
  it('builds global root and project paths', () => {
    expect(getPreferenceMemoryRootDir(homeDirectory)).toBe(
      path.join(homeDirectory, '.jean-claude', 'memory'),
    );
    expect(getPreferenceMemoryProjectsDir(homeDirectory)).toBe(
      path.join(homeDirectory, '.jean-claude', 'memory', 'projects'),
    );
    expect(getProjectPreferenceMemoryDir('project-1', homeDirectory)).toBe(
      path.join(
        homeDirectory,
        '.jean-claude',
        'memory',
        'projects',
        'project-1',
      ),
    );
  });

  it.each([
    '',
    '.',
    '..',
    '../project',
    'team/project',
    'team\\project',
    '项目:1',
    'Project-1',
    'con',
  ])(
    'maps nonportable project ID %j to a deterministic safe key',
    (projectId) => {
      const key = getPreferenceMemoryProjectKey(projectId);
      expect(key).toMatch(/^\.hashed-[a-f0-9]{32}$/);
      expect(getPreferenceMemoryProjectKey(projectId)).toBe(key);
      expect(path.basename(getProjectPreferenceMemoryDir(projectId, homeDirectory))).toBe(
        key,
      );
    },
  );

  it('accepts generated and caller-provided safe project IDs', () => {
    expect(() =>
      getProjectPreferenceMemoryDir(
        '0123456789abcdef0123456789abcdef',
        homeDirectory,
      ),
    ).not.toThrow();
    expect(() =>
      getProjectPreferenceMemoryDir('project_1-alpha', homeDirectory),
    ).not.toThrow();
  });

  it('creates project metadata', async () => {
    const projectMemoryDir = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );

    await writeProjectPreferenceMemoryMetadata({
      projectId: 'project-1',
      name: 'Jean-Claude',
      sourcePath: '/projects/jean-claude',
      homeDirectory,
      projectMemoryDir,
    });

    await expect(
      fs.readFile(path.join(projectMemoryDir, 'project.json'), 'utf-8'),
    ).resolves.toBe(
      `${JSON.stringify(
        {
          id: 'project-1',
          name: 'Jean-Claude',
          sourcePath: '/projects/jean-claude',
        },
        null,
        2,
      )}\n`,
    );
  });

  it('atomically renames project metadata from the same directory', async () => {
    const projectMemoryDir = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    const rename = vi.spyOn(fs, 'rename');

    try {
      await writeProjectPreferenceMemoryMetadata({
        projectId: 'project-1',
        name: 'Jean-Claude',
        sourcePath: '/projects/jean-claude',
        homeDirectory,
        projectMemoryDir,
      });
      expect(rename).toHaveBeenCalledOnce();
      const [tempPath, metadataPath] = rename.mock.calls[0];
      expect(path.dirname(String(tempPath))).toBe(projectMemoryDir);
      expect(String(metadataPath)).toBe(
        path.join(projectMemoryDir, 'project.json'),
      );
    } finally {
      rename.mockRestore();
    }
  });

  it('cleans metadata temp files when activation fails', async () => {
    const projectMemoryDir = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    const rename = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('rename failed'));

    try {
      await expect(
        writeProjectPreferenceMemoryMetadata({
          projectId: 'project-1',
          name: 'Jean-Claude',
          sourcePath: '/projects/jean-claude',
          homeDirectory,
          projectMemoryDir,
        }),
      ).rejects.toThrow('rename failed');
    } finally {
      rename.mockRestore();
    }

    await expect(fs.readdir(projectMemoryDir)).resolves.toEqual([]);
  });

  it('recursively removes project memory', async () => {
    const projectMemoryDir = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    await fs.mkdir(path.join(projectMemoryDir, 'user-reviews'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectMemoryDir, 'user-reviews', 'review.jsonl'),
      '{}\n',
      'utf-8',
    );

    await removeProjectPreferenceMemory({
      projectId: 'project-1',
      homeDirectory,
    });

    await expect(fs.stat(projectMemoryDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows cleanup when project memory does not exist', async () => {
    await expect(
      removeProjectPreferenceMemory({
        projectId: 'missing-project',
        homeDirectory,
      }),
    ).resolves.toBeUndefined();
  });

  it('safely removes memory for a nonportable project ID', async () => {
    const projectId = '../outside/项目';
    const projectMemoryDir = getProjectPreferenceMemoryDir(
      projectId,
      homeDirectory,
    );
    const outsidePath = path.join(
      getPreferenceMemoryProjectsDir(homeDirectory),
      'outside.txt',
    );
    await fs.mkdir(projectMemoryDir, { recursive: true });
    await fs.writeFile(outsidePath, 'keep', 'utf-8');

    await removeProjectPreferenceMemory({ projectId, homeDirectory });

    await expect(fs.stat(projectMemoryDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe('keep');
  });

  it('stores original nonportable project ID in metadata', async () => {
    const projectId = 'team/project:项目';
    const projectMemoryDir = getProjectPreferenceMemoryDir(
      projectId,
      homeDirectory,
    );

    await writeProjectPreferenceMemoryMetadata({
      projectId,
      name: 'Unicode Project',
      sourcePath: '/projects/unicode',
      homeDirectory,
      projectMemoryDir,
    });

    await expect(
      fs.readFile(path.join(projectMemoryDir, 'project.json'), 'utf-8'),
    ).resolves.toContain(`"id": "${projectId}"`);
  });

  it.each([0, 1, 2])(
    'rejects a symlink at managed parent level %i',
    async (symlinkIndex) => {
      const managedPaths = [
        path.join(homeDirectory, '.jean-claude'),
        path.join(homeDirectory, '.jean-claude', 'memory'),
        path.join(homeDirectory, '.jean-claude', 'memory', 'projects'),
      ];
      for (const directoryPath of managedPaths.slice(0, symlinkIndex)) {
        await fs.mkdir(directoryPath);
      }
      const outsidePath = await fs.mkdtemp(
        path.join(os.tmpdir(), 'jc-preference-memory-outside-'),
      );
      await fs.symlink(outsidePath, managedPaths[symlinkIndex]);

      try {
        await expect(
          writeProjectPreferenceMemoryMetadata({
            projectId: 'project-1',
            name: 'Jean-Claude',
            sourcePath: '/projects/jean-claude',
            homeDirectory,
          }),
        ).rejects.toThrow('Unsafe preference memory directory');
        await expect(fs.readdir(outsidePath)).resolves.toEqual([]);
      } finally {
        await fs.rm(outsidePath, { force: true, recursive: true });
      }
    },
  );

  it('rejects a nested symlink in project memory', async () => {
    const projectMemoryDir = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    const outsidePath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'jc-preference-memory-nested-'),
    );
    await fs.mkdir(projectMemoryDir, { recursive: true });
    await fs.symlink(outsidePath, path.join(projectMemoryDir, 'user-reviews'));

    try {
      await expect(
        assertSafeProjectPreferenceMemoryTree(projectMemoryDir),
      ).rejects.toThrow('Unsafe symlink in project memory');
    } finally {
      await fs.rm(outsidePath, { force: true, recursive: true });
    }
  });
});
