import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  content: null as string | null,
  /** When set, `readFile` rejects with this instead of reading `content`. */
  readError: null as NodeJS.ErrnoException | null,
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(async () => {
    if (storage.readError) throw storage.readError;
    if (storage.content === null) {
      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return storage.content;
  }),
}));
vi.mock('write-file-atomic', () => ({
  default: vi.fn(async (_path: string, content: string) => {
    storage.content = content;
  }),
}));

import {
  addGlobalPermission,
  readGlobalPermissions,
  validatePermissionScope,
} from './global-permissions-service';

beforeEach(() => {
  storage.content = null;
  storage.readError = null;
});

describe('readGlobalPermissions transient failures', () => {
  /**
   * Fresh module instance so the last-known-good cache starts empty and does
   * not leak between cases.
   */
  async function loadService() {
    vi.resetModules();
    return import('./global-permissions-service');
  }

  const SETTINGS = JSON.stringify({
    version: 1,
    permissions: { read: 'allow', bash: { 'git *': 'allow' } },
  });

  it('reuses the last known good scope when the read transiently fails', async () => {
    const service = await loadService();
    storage.content = SETTINGS;
    const good = await service.readGlobalPermissions();
    expect(good).toEqual({ read: 'allow', bash: { 'git *': 'allow' } });

    // Bust the in-memory cache the way a write does, then fail the next read.
    await service.removeGlobalPermission({ tool: 'nonexistent' });
    storage.readError = Object.assign(new Error('EMFILE'), { code: 'EMFILE' });

    // Must NOT collapse to {} — that would drop every allowed tool to `ask`.
    expect(await service.readGlobalPermissions()).toEqual({
      read: 'allow',
      bash: { 'git *': 'allow' },
    });
  });

  it('reuses the last known good scope when the file is unparseable', async () => {
    const service = await loadService();
    storage.content = SETTINGS;
    await service.readGlobalPermissions();

    await service.removeGlobalPermission({ tool: 'nonexistent' });
    storage.content = '{ truncated';

    expect(await service.readGlobalPermissions()).toEqual({
      read: 'allow',
      bash: { 'git *': 'allow' },
    });
  });

  it('returns an empty scope when the file genuinely does not exist', async () => {
    const service = await loadService();
    storage.content = null;
    expect(await service.readGlobalPermissions()).toEqual({});
  });

  it('does not serve a revoked rule when the post-write read fails', async () => {
    const service = await loadService();
    storage.content = SETTINGS;
    await service.readGlobalPermissions();

    // User revokes the bash rule. The write busts the cache, so the refresh
    // that follows goes to disk — and that read is the one that fails.
    await service.removeGlobalPermission({ tool: 'bash' });
    storage.readError = Object.assign(new Error('EMFILE'), { code: 'EMFILE' });

    // Must NOT resurrect `bash` — that would be wider than disk.
    expect(await service.readGlobalPermissions()).toEqual({ read: 'allow' });
  });

  it('reports empty when the settings file disappears', async () => {
    const service = await loadService();
    storage.content = SETTINGS;
    await service.readGlobalPermissions();

    // A vanished file is a real "no rules" answer, not an unknown one — unlike
    // a failed read, it must NOT fall back to the last known good scope.
    await service.removeGlobalPermission({ tool: 'nonexistent' });
    storage.content = null;
    expect(await service.readGlobalPermissions()).toEqual({});
  });

  it('does not hand out a mutable reference to the cached scope', async () => {
    const service = await loadService();
    storage.content = SETTINGS;

    const first = await service.readGlobalPermissions();
    delete first.read;

    expect(await service.readGlobalPermissions()).toEqual({
      read: 'allow',
      bash: { 'git *': 'allow' },
    });
  });
});

describe('addGlobalPermission', () => {
  it.each(['***', '?*', '*?', ' * ? '])(
    'rejects wildcard-only Bash pattern %j',
    async (command) => {
      await expect(
        addGlobalPermission({
          toolName: 'Bash',
          input: { command },
        }),
      ).resolves.toBe(false);
    },
  );

  it('allows Bash patterns containing literal command content', () => {
    expect(
      validatePermissionScope({ bash: { 'git *': 'allow' } }),
    ).toEqual({ bash: { 'git *': 'allow' } });
  });

  it('rolls back targeted global rule when step persistence fails', async () => {
    await expect(
      addGlobalPermission({
        toolName: 'Read',
        input: {},
        afterPersisted: async () => {
          throw new Error('step write failed');
        },
      }),
    ).rejects.toThrow('step write failed');

    expect(await readGlobalPermissions()).toEqual({});
  });

  it('does not let rollback remove a concurrent grant', async () => {
    let releaseFirst!: () => void;
    let markFirstPersisted!: () => void;
    const firstPersisted = new Promise<void>((resolve) => {
      markFirstPersisted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = addGlobalPermission({
      toolName: 'Bash',
      input: { command: 'pnpm test' },
      afterPersisted: async () => {
        markFirstPersisted();
        await release;
        throw new Error('step write failed');
      },
    });
    await firstPersisted;
    const second = addGlobalPermission({
      toolName: 'Bash',
      input: { command: 'pnpm lint' },
    });

    releaseFirst();
    await expect(first).rejects.toThrow('step write failed');
    await expect(second).resolves.toBe(true);

    expect(await readGlobalPermissions()).toEqual({
      bash: { 'pnpm lint': 'allow' },
    });
  });
});

describe('global external directories', () => {
  it('stores a directory grant and resolves it into allowed directories', async () => {
    vi.resetModules();
    const service = await import('./global-permissions-service');
    const { getAllowedDirectories } = await import('./directory-access');

    const directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'jc-global-dir-')),
    );
    try {
      await expect(
        service.addGlobalPermission({
          toolName: 'external_directory',
          input: { permissionPatterns: [`${directory}/**`] },
          action: 'allow',
        }),
      ).resolves.toBe(true);

      expect(await service.readGlobalPermissions()).toEqual({
        external_directory: { [`${directory}/**`]: 'allow' },
      });

      // The rules global scope contributes must survive into the list the
      // backends hand to the agent as additional writable roots.
      expect(getAllowedDirectories(await service.resolveGlobalRules())).toEqual([
        directory,
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('drops a global directory grant that a later deny cancels', async () => {
    vi.resetModules();
    const service = await import('./global-permissions-service');
    const { getAllowedDirectories } = await import('./directory-access');

    const directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), 'jc-global-dir-')),
    );
    try {
      await service.addGlobalPermission({
        toolName: 'external_directory',
        input: { permissionPatterns: [`${directory}/**`] },
        action: 'deny',
      });

      expect(getAllowedDirectories(await service.resolveGlobalRules())).toEqual(
        [],
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
