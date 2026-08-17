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

describe('agent memory extraction background jobs', () => {
  beforeEach(() => {
    useBackgroundJobsStore.setState({ jobs: [] });
  });

  it('tracks a running extraction job and can settle it with a warning', () => {
    const id = useBackgroundJobsStore.getState().addRunningJob({
      type: 'agent-memory-extraction',
      title: 'Extract agent memory',
      projectId: 'project-1',
      details: { projectName: 'Jean-Claude' },
    });

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      id,
      type: 'agent-memory-extraction',
      status: 'running',
      projectId: 'project-1',
      details: { projectName: 'Jean-Claude' },
    });
    expect(bgJobLabel('agent-memory-extraction')).toBe('Extracting agent memory…');

    useBackgroundJobsStore
      .getState()
      .markJobSucceeded(id, { warningMessage: 'Nothing to extract' });

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'succeeded',
      warningMessage: 'Nothing to extract',
    });
  });

  it('marks a failed extraction with the error message', () => {
    const id = useBackgroundJobsStore.getState().addRunningJob({
      type: 'agent-memory-extraction',
      title: 'Retry agent memory extraction',
      projectId: 'project-1',
      details: { projectName: null },
    });

    useBackgroundJobsStore.getState().markJobFailed(id, 'boom');

    expect(useBackgroundJobsStore.getState().jobs[0]).toMatchObject({
      status: 'failed',
      errorMessage: 'boom',
    });
  });
});
