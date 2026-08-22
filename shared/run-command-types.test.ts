import { describe, expect, it } from 'vitest';

import {
  getProjectRootRunId,
  parseProjectRootRunId,
} from './run-command-types';

describe('project root run ids', () => {
  it('round-trips a project id', () => {
    const runId = getProjectRootRunId('project-1');
    expect(runId).not.toBe('project-1');
    expect(parseProjectRootRunId(runId)).toBe('project-1');
  });

  it('returns null for a regular task id', () => {
    expect(parseProjectRootRunId('task-1')).toBeNull();
  });
});
