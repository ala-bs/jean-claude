// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  bgJobLabel,
  useBackgroundJobsStore,
} from './background-jobs';

describe('work item summary background jobs', () => {
  beforeEach(() => {
    useBackgroundJobsStore.setState({ jobs: [] });
  });

  it('stores identity details and exposes a generation label', () => {
    const id = useBackgroundJobsStore.getState().addRunningJob({
      type: 'work-item-summary-generation',
      title: 'Summarize #42',
      projectId: 'project-1',
      details: {
        providerId: 'provider-1',
        workItemId: 42,
        workItemTitle: 'Checkout fails',
        projectName: 'Azure Project',
      },
    });

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      id,
      type: 'work-item-summary-generation',
      status: 'running',
      details: { providerId: 'provider-1', workItemId: 42 },
    });
    expect(bgJobLabel('work-item-summary-generation')).toBe(
      'Generating work item summary…',
    );
  });
});
