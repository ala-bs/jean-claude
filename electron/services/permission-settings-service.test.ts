import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('write-file-atomic', async () => {
  const mockedFs = await import('fs/promises');
  return {
    default: (filePath: string, content: string) =>
      mockedFs.writeFile(filePath, content, 'utf-8'),
  };
});

import {
  addWorktreePermission,
  addProjectPermissionRule,
  compileForOpenCode,
  evaluatePermission,
  normalizeToolRequest,
  isUnrestrictedBashPattern,
  readProjectPermissions,
  readSettings,
} from './permission-settings-service';

const tempDirs: string[] = [];

async function createTempProject(): Promise<string> {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  const projectPath = await fs.mkdtemp(
    path.join(os.tmpdir(), 'jc-permissions-'),
  );
  tempDirs.push(projectPath);
  return projectPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('addWorktreePermission', () => {
  it('reports rejection for bare Bash without writing settings', async () => {
    await expect(addWorktreePermission('/repo', 'Bash', {})).resolves.toBe(false);
  });

  it.each(['***', '?*', '*?', ' * ? '])(
    'rejects wildcard-only Bash pattern %j at worktree boundary',
    async (command) => {
      await expect(
        addWorktreePermission('/repo', 'Bash', { command }),
      ).resolves.toBe(false);
    },
  );

  it('serializes concurrent grants without losing either rule', async () => {
    const projectPath = await createTempProject();

    await Promise.all([
      addWorktreePermission(projectPath, 'Bash', { command: 'pnpm test' }),
      addWorktreePermission(projectPath, 'Bash', { command: 'pnpm lint' }),
    ]);

    const settings = await readSettings(projectPath);
    expect(settings.permissions.worktrees?.bash).toEqual({
      'pnpm test': 'allow',
      'pnpm lint': 'allow',
    });
  });

  it('rolls back targeted worktree rule when step persistence fails', async () => {
    const projectPath = await createTempProject();

    await expect(
      addWorktreePermission(
        projectPath,
        'Read',
        {},
        async () => {
          throw new Error('step write failed');
        },
      ),
    ).rejects.toThrow('step write failed');

    expect((await readSettings(projectPath)).permissions.worktrees).toBeUndefined();
  });
});

describe('addProjectPermissionRule', () => {
  it.each(['***', '?*', '*?', ' * ? '])(
    'rejects wildcard-only Bash pattern %j at project boundary',
    async (command) => {
      await expect(
        addProjectPermissionRule({
          projectPath: '/repo',
          toolName: 'Bash',
          input: { command },
        }),
      ).resolves.toBe(false);
    },
  );

  it('rolls back targeted project rule when step persistence fails', async () => {
    const projectPath = await createTempProject();

    await expect(
      addProjectPermissionRule({
        projectPath,
        toolName: 'Read',
        input: {},
        afterPersisted: async () => {
          throw new Error('step write failed');
        },
      }),
    ).rejects.toThrow('step write failed');

    expect(await readProjectPermissions(projectPath)).toEqual({});
  });
});

describe('isUnrestrictedBashPattern', () => {
  it('allows Bash patterns containing literal command content', () => {
    expect(isUnrestrictedBashPattern('bash', 'git *')).toBe(false);
  });
});

describe('compileForOpenCode', () => {
  it('adds an ask baseline before explicit rules', () => {
    expect(
      compileForOpenCode([
        { tool: 'bash', pattern: 'git status*', action: 'allow' },
      ]),
    ).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'git status*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'ask' },
    ]);
  });

  it('uses ask baseline when no rules are configured', () => {
    expect(compileForOpenCode([])).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'external_directory', pattern: '*', action: 'ask' },
    ]);
  });

  it('preserves bash wildcard patterns for OpenCode interpretation', () => {
    expect(
      compileForOpenCode([
        { tool: 'bash', pattern: 'echo *', action: 'allow' },
      ]),
    ).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'bash', pattern: 'echo *', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'ask' },
    ]);
  });

  it('keeps external-directory rules in the canonicalizing adapter', () => {
    expect(
      compileForOpenCode([
        {
          tool: 'external_directory',
          pattern: '/safe/**',
          action: 'allow',
        },
      ]),
    ).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'external_directory', pattern: '*', action: 'ask' },
    ]);
  });

  it('overrides wildcard allows for external directories', () => {
    expect(
      compileForOpenCode([{ tool: '*', pattern: '*', action: 'allow' }]),
    ).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'external_directory', pattern: '*', action: 'ask' },
    ]);
  });
});

describe('evaluatePermission', () => {
  it('matches bash wildcard patterns across multiple trailing arguments', () => {
    expect(
      evaluatePermission(
        [{ tool: 'bash', pattern: 'echo *', action: 'allow' }],
        'bash',
        'echo arg1 arg2 arg3',
      ),
    ).toBe('allow');
  });

  it('does not match bash wildcard patterns without required literal spacing', () => {
    expect(
      evaluatePermission(
        [{ tool: 'bash', pattern: 'echo *', action: 'allow' }],
        'bash',
        'echofoo arg1 arg2 arg3',
      ),
    ).toBe('ask');
  });
});

describe('normalizeToolRequest', () => {
  it('escapes wildcard characters for exact Bash grants', () => {
    const { matchValue } = normalizeToolRequest('Bash', {
      command: 'echo * ? [x]',
      __permissionExact: true,
    });

    expect(matchValue).toBe('echo \\* \\? [x]');
    expect(
      evaluatePermission(
        [{ tool: 'bash', pattern: matchValue, action: 'allow' }],
        'bash',
        'echo * ? [x]',
      ),
    ).toBe('allow');
    expect(
      evaluatePermission(
        [{ tool: 'bash', pattern: matchValue, action: 'allow' }],
        'bash',
        'echo anything ? [x]',
      ),
    ).toBe('ask');
  });

  it('uses OpenCode external-directory permission pattern for matching', () => {
    expect(
      normalizeToolRequest('external_directory', {
        filepath: '/safe/shared/repo/file.ts',
        parentDir: '/safe/shared/repo',
        permissionPatterns: ['/safe/shared/repo/*'],
      }),
    ).toEqual({
      tool: 'external_directory',
      matchValue: '/safe/shared/repo/*',
    });
  });
});
