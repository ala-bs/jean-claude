import { describe, expect, it } from 'vitest';

import { getChildProcessEnv } from './child-process-env';

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
});
