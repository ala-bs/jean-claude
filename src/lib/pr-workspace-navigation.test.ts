import { describe, expect, it } from 'vitest';

import { getPrWorkspaceDeletionDestination } from './pr-workspace-navigation';

const params = {
  deletedTaskIds: ['task/encoded'],
  projectId: 'project/encoded',
  pullRequestId: 42,
};

describe('getPrWorkspaceDeletionDestination', () => {
  it('matches encoded all-task routes and returns all PR details', () => {
    expect(
      getPrWorkspaceDeletionDestination({
        ...params,
        pathname: '/all/task%2Fencoded',
      }),
    ).toEqual({
      to: '/all/prs/$projectId/$prId',
      params: { projectId: 'project/encoded', prId: '42' },
    });
  });

  it('matches encoded project task routes and returns project PR details', () => {
    expect(
      getPrWorkspaceDeletionDestination({
        ...params,
        pathname: '/projects/project%2Fencoded/tasks/task%2Fencoded',
      }),
    ).toEqual({
      to: '/projects/$projectId/prs/$prId',
      params: { projectId: 'project/encoded', prId: '42' },
    });
  });

  it('does not navigate when displayed task is not deleted', () => {
    expect(
      getPrWorkspaceDeletionDestination({
        ...params,
        pathname: '/all/other-task',
      }),
    ).toBeNull();
  });

  it('uses route-family fallbacks for a known current deleted task', () => {
    expect(
      getPrWorkspaceDeletionDestination({
        ...params,
        currentTaskId: 'task/encoded',
        pathname: '/all/unknown/task%2Fencoded',
      }),
    ).toEqual({ to: '/all' });
    expect(
      getPrWorkspaceDeletionDestination({
        ...params,
        currentTaskId: 'task/encoded',
        pathname: '/projects/project%2Fencoded/unknown/task%2Fencoded',
      }),
    ).toEqual({
      to: '/projects/$projectId',
      params: { projectId: 'project/encoded' },
    });
  });
});
