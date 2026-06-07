import { describe, expect, it } from 'vitest';

import {
  compileForOpenCode,
  evaluatePermission,
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
    ]);
  });

  it('uses ask baseline when no rules are configured', () => {
    expect(compileForOpenCode([])).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
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
