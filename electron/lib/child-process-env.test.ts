import { describe, expect, it } from 'vitest';

import { getChildProcessEnv, getEnvPoolKey } from './child-process-env';

describe('getChildProcessEnv', () => {
  it('removes app-owned variables and undefined values', () => {
    expect(
      getChildProcessEnv({
        inheritedEnv: {
          PATH: '/usr/bin',
          NODE_ENV: 'production',
          ELECTRON_RENDERER_URL: 'http://localhost:5173',
          electron_run_as_node: '1',
          JC_SKIP_INSTANCE_LOCK: '1',
          jc_dev_badge_label: 'test',
          UNDEFINED_VALUE: undefined,
        },
      }),
    ).toEqual({ PATH: '/usr/bin' });
  });

  it('preserves unrelated variables', () => {
    expect(
      getChildProcessEnv({
        inheritedEnv: {
          HOME: '/tmp/home',
          OPENCODE_DATA_DIR: '/tmp/opencode',
          CLAUDE_CONFIG_DIR: '/tmp/claude',
        },
      }),
    ).toEqual({
      HOME: '/tmp/home',
      OPENCODE_DATA_DIR: '/tmp/opencode',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
    });
  });

  it('allows explicit overrides for filtered names', () => {
    expect(
      getChildProcessEnv({
        inheritedEnv: {
          NODE_ENV: 'production',
          ELECTRON_RUN_AS_NODE: '1',
          JC_SKIP_INSTANCE_LOCK: '1',
        },
        overrides: {
          NODE_ENV: 'test',
          ELECTRON_RUN_AS_NODE: '0',
          JC_PROJECT_VALUE: 'configured',
        },
      }),
    ).toEqual({
      NODE_ENV: 'test',
      ELECTRON_RUN_AS_NODE: '0',
      JC_PROJECT_VALUE: 'configured',
    });
  });

  it('lets project overrides win over inherited values', () => {
    expect(
      getChildProcessEnv({
        inheritedEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'inherited' },
        overrides: { ANTHROPIC_API_KEY: 'project' },
      }),
    ).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'project' });
  });
});

describe('getEnvPoolKey', () => {
  it('treats undefined and empty overrides as the shared pool', () => {
    expect(getEnvPoolKey(undefined)).toBe('');
    expect(getEnvPoolKey({})).toBe('');
  });

  it('is order-independent so equivalent envs share a process', () => {
    expect(getEnvPoolKey({ A: '1', B: '2' })).toBe(
      getEnvPoolKey({ B: '2', A: '1' }),
    );
  });

  it('separates different values and different keys', () => {
    expect(getEnvPoolKey({ A: '1' })).not.toBe(getEnvPoolKey({ A: '2' }));
    expect(getEnvPoolKey({ A: '1' })).not.toBe(getEnvPoolKey({ B: '1' }));
  });
});
