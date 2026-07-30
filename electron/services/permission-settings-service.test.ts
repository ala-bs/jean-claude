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

import { buildBashSuggestions } from '@shared/permission-suggestions';

import {
  addWorktreePermission,
  addProjectPermissionRule,
  compileForOpenCode,
  evaluatePermission,
  evaluatePermissionWithMatch,
  evaluateToolPermission,
  normalizeToolRequest,
  isUnrestrictedBashPattern,
  readProjectPermissions,
  readSettings,
  seedDefaultProjectPermissions,
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

describe('seedDefaultProjectPermissions', () => {
  it('seeds default allow rules on a fresh project', async () => {
    const projectPath = await createTempProject();
    await seedDefaultProjectPermissions(projectPath);

    const settings = await readSettings(projectPath);
    expect(settings.permissions.project).toEqual({
      edit: {
        '*': 'allow',
        '**/.jean-claude/**': 'ask',
        '**/.claude/**': 'ask',
      },
      write: {
        '*': 'allow',
        '**/.jean-claude/**': 'ask',
        '**/.claude/**': 'ask',
      },
      grep: 'allow',
      glob: 'allow',
      read: 'allow',
    });
  });

  it('still asks before editing its own permission config', async () => {
    const projectPath = await createTempProject();
    await seedDefaultProjectPermissions(projectPath);

    const evaluate = (toolName: string, filePath: string) =>
      evaluateToolPermission({
        projectPath,
        isWorktree: false,
        toolName,
        input: { filePath: path.join(projectPath, filePath) },
      });

    await expect(evaluate('Edit', 'src/index.ts')).resolves.toBe('allow');
    await expect(
      evaluate('Edit', '.jean-claude/settings.local.json'),
    ).resolves.toBe('ask');
    await expect(evaluate('Write', '.claude/settings.json')).resolves.toBe(
      'ask',
    );
  });

  it('does not overwrite existing settings', async () => {
    const projectPath = await createTempProject();
    await addProjectPermissionRule({
      projectPath,
      toolName: 'Bash',
      input: { command: 'git status' },
      action: 'allow',
    });
    const before = await readSettings(projectPath);

    await seedDefaultProjectPermissions(projectPath);

    expect(await readSettings(projectPath)).toEqual(before);
  });

  it('does not seed when legacy .claude settings exist', async () => {
    const projectPath = await createTempProject();
    await fs.mkdir(path.join(projectPath, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(projectPath, '.claude/settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }),
      'utf-8',
    );

    await seedDefaultProjectPermissions(projectPath);

    await expect(
      fs.access(path.join(projectPath, '.jean-claude/settings.local.json')),
    ).rejects.toThrow();
  });

  it('ignores an empty root dir', async () => {
    await expect(seedDefaultProjectPermissions('')).resolves.toBeUndefined();
  });
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

  it('keeps commands hidden in heredocs and redirect targets visible', () => {
    const allowCat = [
      { tool: 'bash', pattern: 'cat*', action: 'allow' as const },
      { tool: 'bash', pattern: 'echo*', action: 'allow' as const },
    ];

    const heredoc = normalizeToolRequest('Bash', {
      command: 'cat <<EOF\n$(rm -rf /)\nEOF',
    });
    expect(
      evaluatePermission(allowCat, heredoc.tool, heredoc.matchValue),
    ).toBe('ask');

    const target = normalizeToolRequest('Bash', {
      command: 'echo hi >$(rm -rf /)',
    });
    expect(evaluatePermission(allowCat, target.tool, target.matchValue)).toBe(
      'ask',
    );

    // An unbalanced quote in a nested command must not merge the next one
    // into it and let it ride along on the `echo*` rule.
    const merged = normalizeToolRequest('Bash', {
      command: "cat <<EOF\n$(echo 'x)\n$(rm -rf /)\nEOF",
    });
    expect(evaluatePermission(allowCat, merged.tool, merged.matchValue)).toBe(
      'ask',
    );

    // A quoted delimiter keeps the body inert, so the command stays allowed.
    const inert = normalizeToolRequest('Bash', {
      command: "cat <<'EOF'\n$(rm -rf /)\nEOF",
    });
    expect(evaluatePermission(allowCat, inert.tool, inert.matchValue)).toBe(
      'allow',
    );
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

describe('compound command breakdown', () => {
  const rules = [
    { tool: 'bash', pattern: 'cd *', action: 'allow' as const },
    { tool: 'bash', pattern: 'git status *', action: 'allow' as const },
  ];

  it('reports every subcommand with the rule that matched it', () => {
    const result = evaluatePermissionWithMatch(
      rules,
      'bash',
      'cd /repo && git status --short | sed -n 1p',
    );

    expect(result.action).toBe('ask');
    expect(result.subCommands).toEqual([
      {
        command: 'cd /repo',
        action: 'allow',
        matchedRule: rules[0],
      },
      {
        command: 'git status --short',
        action: 'allow',
        matchedRule: rules[1],
      },
      { command: 'sed -n 1p', action: 'ask', matchedRule: undefined },
    ]);
  });

  it('keeps the breakdown complete when a subcommand is denied', () => {
    const result = evaluatePermissionWithMatch(
      [{ tool: 'bash', pattern: 'rm *', action: 'deny' }],
      'bash',
      'rm -rf build && ls',
    );

    expect(result.action).toBe('deny');
    expect(result.subCommands?.map((sub) => sub.command)).toEqual([
      'rm -rf build',
      'ls',
    ]);
  });

  it('evaluates commands hidden inside assignments and loops', () => {
    const result = evaluatePermissionWithMatch(
      [
        { tool: 'bash', pattern: 'echo *', action: 'allow' },
        { tool: 'bash', pattern: 'pnpm test', action: 'allow' },
      ],
      'bash',
      'echo hi && NODE_ENV=$(rm -rf /) pnpm test',
    );

    expect(result.subCommands?.map((sub) => sub.command)).toEqual([
      'echo hi',
      'rm -rf /',
      'pnpm test',
    ]);
    expect(result.action).toBe('ask');
  });

  it('omits the breakdown for a simple command', () => {
    expect(
      evaluatePermissionWithMatch(rules, 'bash', 'cd /repo').subCommands,
    ).toBeUndefined();
  });
});

describe('suggested rules round-trip', () => {
  /**
   * The chips in the permission bar pass their pattern back through
   * `onAllowForProject('Bash', { command: pattern })`, which runs
   * `normalizeToolRequest`. A suggestion is only useful if the stored rule
   * then actually matches the original command.
   */
  const grant = (pattern: string) => ({
    tool: normalizeToolRequest('Bash', { command: pattern }).tool,
    pattern: normalizeToolRequest('Bash', { command: pattern }).matchValue,
    action: 'allow' as const,
  });

  it.each([
    ['sed -n 1,5p file.ts', 'sed -n 1,5p file.ts'],
    ['grep -rn foo src', 'grep *'],
    ['git show HEAD:a.ts', 'git show *'],
    ['ls *.ts', 'ls \\*.ts'],
    // Redirections survive into the suggestion but normalizeToolRequest
    // strips them before storing, so the rule still matches.
    ['pnpm lint --fix 2>&1', 'pnpm lint --fix 2>&1'],
  ])('granting a suggestion for %s stops the prompt', (command, pattern) => {
    expect(buildBashSuggestions(command).map((s) => s.pattern)).toContain(
      pattern,
    );
    expect(evaluatePermission([grant(pattern)], 'bash', command)).toBe('allow');
  });

  it('grants every blocking part of a compound command', () => {
    const command = 'grep foo src | sed -n 1p';
    const parts = ['grep foo src', 'sed -n 1p'];
    const granted = parts.map(
      (part) => grant(buildBashSuggestions(part)[0].pattern),
    );

    expect(evaluatePermission(granted, 'bash', command)).toBe('allow');
  });

  it('an exact pattern never widens to a different command', () => {
    const granted = grant(buildBashSuggestions('ls *.ts')[0].pattern);

    expect(evaluatePermission([granted], 'bash', 'ls secrets.env')).toBe('ask');
  });
});
