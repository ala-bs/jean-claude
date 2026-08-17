import { beforeEach, describe, expect, it } from 'vitest';

import { cache$, resetCache } from './cache-store';
import { stepResourceKey, taskStepsResourceKey } from './domains/steps';
import { invalidateTaskStatusResources } from './status-invalidations';
import { setResourceSuccess } from './cache-actions';
import { taskResourceKey } from './domains/tasks';

describe('invalidateTaskStatusResources', () => {
  beforeEach(() => {
    resetCache();
  });

  it('marks normalized task and step resources stale', () => {
    const resourceKeys = [
      taskResourceKey('task-1'),
      taskStepsResourceKey('task-1'),
      stepResourceKey('step-1'),
    ];
    resourceKeys.forEach(setResourceSuccess);

    invalidateTaskStatusResources('task-1', 'step-1');

    for (const resourceKey of resourceKeys) {
      expect(cache$.resources[resourceKey].get()?.stale).toBe(true);
    }
  });

  it('does not create metadata for unobserved resources', () => {
    invalidateTaskStatusResources('task-1', 'step-1');

    expect(cache$.resources.get()).toEqual({});
  });
});
