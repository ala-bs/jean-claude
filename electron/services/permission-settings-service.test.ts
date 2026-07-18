import { describe, expect, it } from 'vitest';

import {
  compileForOpenCode,
  evaluatePermission,
  normalizeToolRequest,
} from './permission-settings-service';

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
