import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import { getProjectPreferenceMemoryDir } from '../../services/preference-memory-storage';
import { up } from './074_migrate_preference_memory';

let db: Kysely<unknown>;
let homeDirectory: string;
let projectPath: string;

beforeEach(async () => {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  homeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'jc-preference-memory-migration-home-'),
  );
  projectPath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'jc-preference-memory-migration-project-'),
  );
  db = {
    selectFrom: () => ({
      select: () => ({
        execute: async () => [
          { id: 'project-1', name: 'Jean-Claude', path: projectPath },
        ],
      }),
    }),
  } as unknown as Kysely<unknown>;
});

afterEach(async () => {
  await fs.rm(homeDirectory, { force: true, recursive: true });
  await fs.rm(projectPath, { force: true, recursive: true });
});

describe('074_migrate_preference_memory', () => {
  it('moves legacy memory and writes project metadata', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    await fs.mkdir(path.join(sourcePath, 'user-reviews'), { recursive: true });
    await fs.writeFile(
      path.join(sourcePath, 'user-reviews', 'review.jsonl'),
      '{"review":true}\n',
      'utf-8',
    );

    await up(db, homeDirectory);

    await expect(
      fs.readFile(
        path.join(destinationPath, 'user-reviews', 'review.jsonl'),
        'utf-8',
      ),
    ).resolves.toBe('{"review":true}\n');
    await expect(
      fs.readFile(path.join(destinationPath, 'project.json'), 'utf-8'),
    ).resolves.toBe(
      `${JSON.stringify(
        {
          id: 'project-1',
          name: 'Jean-Claude',
          sourcePath: projectPath,
        },
        null,
        2,
      )}\n`,
    );
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves legacy memory untouched when destination exists', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    await fs.mkdir(destinationPath, { recursive: true });
    await fs.writeFile(
      path.join(destinationPath, 'existing.txt'),
      'existing',
      'utf-8',
    );

    await up(db, homeDirectory);

    await expect(
      fs.readFile(path.join(sourcePath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
    await expect(
      fs.readFile(path.join(destinationPath, 'existing.txt'), 'utf-8'),
    ).resolves.toBe('existing');
  });

  it('does nothing when legacy memory is missing', async () => {
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );

    await up(db, homeDirectory);

    await expect(fs.stat(destinationPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('accepts a nonportable project ID when legacy memory is missing', async () => {
    const projectId = '../outside:项目';
    db = {
      selectFrom: () => ({
        select: () => ({
          execute: async () => [
            { id: projectId, name: 'Legacy ID', path: projectPath },
          ],
        }),
      }),
    } as unknown as Kysely<unknown>;

    await expect(up(db, homeDirectory)).resolves.toBeUndefined();
    await expect(
      fs.stat(getProjectPreferenceMemoryDir(projectId, homeDirectory)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('migrates legacy memory for a nonportable project ID', async () => {
    const projectId = 'team/project:项目';
    db = {
      selectFrom: () => ({
        select: () => ({
          execute: async () => [
            { id: projectId, name: 'Legacy ID', path: projectPath },
          ],
        }),
      }),
    } as unknown as Kysely<unknown>;
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      projectId,
      homeDirectory,
    );
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');

    await up(db, homeDirectory);

    await expect(
      fs.readFile(path.join(destinationPath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
    await expect(
      fs.readFile(path.join(destinationPath, 'project.json'), 'utf-8'),
    ).resolves.toContain(`"id": "${projectId}"`);
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a symlinked legacy root untouched', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const realMemoryPath = path.join(homeDirectory, 'real-memory');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(realMemoryPath, { recursive: true });
    await fs.writeFile(path.join(realMemoryPath, 'outside.txt'), 'keep', 'utf-8');
    await fs.symlink(realMemoryPath, sourcePath);

    await up(db, homeDirectory);

    expect((await fs.lstat(sourcePath)).isSymbolicLink()).toBe(true);
    await expect(
      fs.readFile(path.join(realMemoryPath, 'outside.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    await expect(
      fs.stat(getProjectPreferenceMemoryDir('project-1', homeDirectory)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips legacy memory redirected through a symlinked ancestor', async () => {
    const externalJeanClaudePath = path.join(
      homeDirectory,
      'external-jean-claude',
    );
    const externalMemoryPath = path.join(externalJeanClaudePath, 'memory');
    const externalFilePath = path.join(externalMemoryPath, 'outside.txt');
    await fs.mkdir(externalMemoryPath, { recursive: true });
    await fs.writeFile(externalFilePath, 'keep', 'utf-8');
    await fs.symlink(
      externalJeanClaudePath,
      path.join(projectPath, '.jean-claude'),
    );

    await expect(up(db, homeDirectory)).resolves.toBeUndefined();

    await expect(fs.readFile(externalFilePath, 'utf-8')).resolves.toBe('keep');
    expect(
      (await fs.lstat(path.join(projectPath, '.jean-claude'))).isSymbolicLink(),
    ).toBe(true);
    await expect(
      fs.stat(getProjectPreferenceMemoryDir('project-1', homeDirectory)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows a symlinked project root with real memory descendants', async () => {
    const realProjectPath = path.join(homeDirectory, 'real-project');
    const sourcePath = path.join(realProjectPath, '.jean-claude', 'memory');
    await fs.rm(projectPath, { recursive: true });
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    await fs.symlink(realProjectPath, projectPath);

    await up(db, homeDirectory);

    await expect(
      fs.readFile(
        path.join(
          getProjectPreferenceMemoryDir('project-1', homeDirectory),
          'legacy.txt',
        ),
        'utf-8',
      ),
    ).resolves.toBe('legacy');
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves legacy memory containing a symlink untouched', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const outsidePath = path.join(homeDirectory, 'outside.json');
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(outsidePath, '{"keep":true}\n', 'utf-8');
    await fs.symlink(outsidePath, path.join(sourcePath, 'project.json'));

    await up(db, homeDirectory);

    expect((await fs.lstat(path.join(sourcePath, 'project.json'))).isSymbolicLink()).toBe(
      true,
    );
    await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe(
      '{"keep":true}\n',
    );
    await expect(
      fs.stat(getProjectPreferenceMemoryDir('project-1', homeDirectory)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves legacy memory when destination is a symlink', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    const outsidePath = path.join(homeDirectory, 'outside-destination');
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.mkdir(outsidePath);
    await fs.symlink(outsidePath, destinationPath);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await up(db, homeDirectory);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('migration skipped for project project-1'),
        expect.any(Error),
      );
    } finally {
      warning.mockRestore();
    }

    await expect(
      fs.readFile(path.join(sourcePath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
    expect((await fs.lstat(destinationPath)).isSymbolicLink()).toBe(true);
    await expect(fs.readdir(outsidePath)).resolves.toEqual([]);
  });

  it('warns and preserves legacy memory when managed root is a symlink', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const outsidePath = path.join(homeDirectory, 'outside-managed-root');
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    await fs.mkdir(outsidePath);
    await fs.symlink(outsidePath, path.join(homeDirectory, '.jean-claude'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(up(db, homeDirectory)).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'migration skipped for project project-1 because the managed destination is unsafe',
        ),
        expect.any(Error),
      );
    } finally {
      warning.mockRestore();
    }

    await expect(
      fs.readFile(path.join(sourcePath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
    await expect(fs.readdir(outsidePath)).resolves.toEqual([]);
  });

  it('rethrows operational managed-root setup failures', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const managedRootPath = path.join(homeDirectory, '.jean-claude');
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    const setupError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const realMkdir = fs.mkdir;
    const mkdir = vi.spyOn(fs, 'mkdir').mockImplementation((target, options) => {
      if (String(target) === managedRootPath) return Promise.reject(setupError);
      return realMkdir(target, options);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(up(db, homeDirectory)).rejects.toBe(setupError);
      expect(warning).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
      warning.mockRestore();
    }

    await expect(
      fs.readFile(path.join(sourcePath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
  });

  it('cleans only the exact project staging directory before retrying', async () => {
    const projectsDir = path.dirname(
      getProjectPreferenceMemoryDir('project-1', homeDirectory),
    );
    const stalePath = path.join(projectsDir, '.staging-project-1');
    const otherProjectStagingPath = path.join(
      projectsDir,
      '.staging-project-1-other',
    );
    await fs.mkdir(stalePath, { recursive: true });
    await fs.mkdir(otherProjectStagingPath, { recursive: true });
    await fs.writeFile(path.join(stalePath, 'partial.txt'), 'partial', 'utf-8');
    await fs.mkdir(path.join(projectPath, '.jean-claude', 'memory'), {
      recursive: true,
    });

    await up(db, homeDirectory);

    await expect(fs.stat(stalePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(otherProjectStagingPath)).resolves.toBeDefined();
  });

  it('cleans partial staging and preserves source when copy fails', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const projectsDir = path.dirname(
      getProjectPreferenceMemoryDir('project-1', homeDirectory),
    );
    const stagingPath = path.join(projectsDir, '.staging-project-1');
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    const cp = vi.spyOn(fs, 'cp').mockImplementation(async (_source, target) => {
      await fs.mkdir(String(target), { recursive: true });
      await fs.writeFile(path.join(String(target), 'partial.txt'), 'partial');
      throw new Error('copy failed');
    });

    try {
      await expect(up(db, homeDirectory)).rejects.toThrow('copy failed');
    } finally {
      cp.mockRestore();
    }

    await expect(fs.stat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.readFile(path.join(sourcePath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
  });

  it('cleans staging and preserves source when activation rename fails', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    const stagingPath = path.join(
      path.dirname(destinationPath),
      '.staging-project-1',
    );
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    const realRename = fs.rename;
    const rename = vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (String(to) === destinationPath) {
        return Promise.reject(new Error('activation failed'));
      }
      return realRename(from, to);
    });

    try {
      await expect(up(db, homeDirectory)).rejects.toThrow('activation failed');
    } finally {
      rename.mockRestore();
    }

    await expect(fs.stat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.readFile(path.join(sourcePath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
  });

  it('preserves legacy memory when it changes during migration', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    const reviewPath = path.join(sourcePath, 'user-reviews', 'review.jsonl');
    await fs.mkdir(path.dirname(reviewPath), { recursive: true });
    await fs.writeFile(reviewPath, '{"review":1}\n', 'utf-8');
    const realCp = fs.cp;
    const cp = vi.spyOn(fs, 'cp').mockImplementation(async (source, target, options) => {
      await realCp(source, target, options);
      await fs.appendFile(reviewPath, '{"review":2}\n', 'utf-8');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(up(db, homeDirectory)).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('changed during migration'),
      );
    } finally {
      cp.mockRestore();
      warning.mockRestore();
    }

    await expect(fs.readFile(reviewPath, 'utf-8')).resolves.toBe(
      '{"review":1}\n{"review":2}\n',
    );
    await expect(
      fs.readFile(
        path.join(destinationPath, 'user-reviews', 'review.jsonl'),
        'utf-8',
      ),
    ).resolves.toBe('{"review":1}\n');
  });

  it('detects tree changes that collide with unframed digest records', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'a'), 'Xf:b\0Y', 'utf-8');
    const realCp = fs.cp;
    const cp = vi.spyOn(fs, 'cp').mockImplementation(async (source, target, options) => {
      await realCp(source, target, options);
      await fs.writeFile(path.join(sourcePath, 'a'), 'X', 'utf-8');
      await fs.writeFile(path.join(sourcePath, 'b'), 'Y', 'utf-8');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(up(db, homeDirectory)).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('changed during migration'),
      );
    } finally {
      cp.mockRestore();
      warning.mockRestore();
    }

    await expect(fs.readFile(path.join(sourcePath, 'a'), 'utf-8')).resolves.toBe(
      'X',
    );
    await expect(fs.readFile(path.join(sourcePath, 'b'), 'utf-8')).resolves.toBe(
      'Y',
    );
    await expect(
      fs.readFile(path.join(destinationPath, 'a'), 'utf-8'),
    ).resolves.toBe('Xf:b\0Y');
  });

  it('continues after source cleanup failure and preserves rerun semantics', async () => {
    const sourcePath = path.join(projectPath, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      'project-1',
      homeDirectory,
    );
    await fs.mkdir(sourcePath, { recursive: true });
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'legacy', 'utf-8');
    const realRm = fs.rm;
    const rm = vi.spyOn(fs, 'rm').mockImplementation((target, options) => {
      if (String(target) === sourcePath) {
        return Promise.reject(new Error('cleanup failed'));
      }
      return realRm(target, options);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(up(db, homeDirectory)).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('legacy source cleanup failed'),
        expect.any(Error),
      );
    } finally {
      rm.mockRestore();
      warning.mockRestore();
    }
    await expect(
      fs.readFile(path.join(destinationPath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
    await fs.writeFile(path.join(sourcePath, 'legacy.txt'), 'changed', 'utf-8');

    await up(db, homeDirectory);

    await expect(
      fs.readFile(path.join(destinationPath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('legacy');
    await expect(
      fs.readFile(path.join(sourcePath, 'legacy.txt'), 'utf-8'),
    ).resolves.toBe('changed');
  });
});
