import { expect, it } from 'vitest';

import { api, type Api } from './api';

it('provides pending PR workspace decision API in non-Electron fallback', async () => {
  const list: Api['tasks']['listPendingPrWorkspaceDecisions'] =
    api.tasks.listPendingPrWorkspaceDecisions;

  await expect(list()).resolves.toEqual([]);
});

it('provides PR workspace deletion APIs in non-Electron fallback', async () => {
  await expect(
    api.tasks.deletePrWorkspaceTask({ taskId: 'task-1' }),
  ).resolves.toEqual({ action: 'deleted', taskIds: ['task-1'] });
  await expect(
    api.tasks.deleteAllPrWorkspaces({
      projectId: 'project-1',
      pullRequestId: 12,
    }),
  ).resolves.toEqual({ action: 'deleted', taskIds: [] });
  await expect(
    api.tasks.resolveClosedPrWorkspace({
      projectId: 'project-1',
      pullRequestId: 12,
      action: 'keep',
    }),
  ).resolves.toEqual({ action: 'kept', taskIds: [] });
});
