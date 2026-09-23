import { describe, expect, it } from 'vitest';

import { getRunCommandGroupAbortMessage } from './run-command-types';

describe('getRunCommandGroupAbortMessage', () => {
  it('names the failing command, its exit code, and what was skipped', () => {
    expect(
      getRunCommandGroupAbortMessage({
        taskId: 'task-1',
        skippedStageCount: 2,
        reason: { type: 'commandFailed', commandName: 'lint', exitCode: 1 },
      }),
    ).toBe('Run group stopped: lint exited with code 1. 2 later stages skipped.');
  });

  it('uses the singular form for a single skipped stage', () => {
    expect(
      getRunCommandGroupAbortMessage({
        taskId: 'task-1',
        skippedStageCount: 1,
        reason: { type: 'commandFailed', commandName: 'test', exitCode: 3 },
      }),
    ).toBe('Run group stopped: test exited with code 3. 1 later stage skipped.');
  });

  it('omits the skipped clause when the last stage failed', () => {
    expect(
      getRunCommandGroupAbortMessage({
        taskId: 'task-1',
        skippedStageCount: 0,
        reason: { type: 'commandFailed', commandName: 'deploy', exitCode: 2 },
      }),
    ).toBe('Run group stopped: deploy exited with code 2.');
  });

  it('explains a command that could not be restarted', () => {
    expect(
      getRunCommandGroupAbortMessage({
        taskId: 'task-1',
        skippedStageCount: 1,
        reason: { type: 'restartFailed', commandName: 'pnpm dev' },
      }),
    ).toBe(
      'Run group stopped: could not restart pnpm dev. 1 later stage skipped.',
    );
  });
});
