import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ content: null as string | null }));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(async () => {
    if (storage.content === null) throw new Error('ENOENT');
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
