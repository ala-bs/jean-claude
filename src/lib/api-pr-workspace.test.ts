import { expect, it } from 'vitest';

import { api } from './api';

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
});
