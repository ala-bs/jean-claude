import { describe, expect, it, vi } from 'vitest';

import { registerPrWorkspaceIpcHandlers } from './pr-workspace-ipc';

describe('registerPrWorkspaceIpcHandlers', () => {
  function setup() {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const deps = {
      ipcMain: {
        handle: vi.fn(
          (channel: string, handler: (...args: unknown[]) => unknown) => {
            handlers.set(channel, handler);
          },
        ),
      },
      getPullRequest: vi.fn().mockResolvedValue({ id: 12, status: 'active' }),
      findProjects: vi.fn().mockResolvedValue([
        {
          id: 'project-1',
          repoProviderId: 'provider-1',
          repoProjectId: 'ado-project-1',
          repoId: 'repo-1',
        },
      ]),
      reconcilePrWorkspaceState: vi.fn(),
      listPendingPrWorkspaceDecisions: vi.fn().mockResolvedValue([
        { projectId: 'project-1', pullRequestId: 12, taskIds: ['task-1'] },
      ]),
      createPrReviewTask: vi.fn().mockResolvedValue({ id: 'task-1' }),
      deletePrWorkspaceTask: vi
        .fn()
        .mockResolvedValue({ action: 'deleted', taskIds: ['task-1'] }),
      deleteAllPrWorkspaces: vi
        .fn()
        .mockResolvedValue({ action: 'deleted', taskIds: ['task-1'] }),
      resolveClosedPrWorkspace: vi
        .fn()
        .mockResolvedValue({ action: 'kept', taskIds: ['task-1'] }),
    };
    registerPrWorkspaceIpcHandlers(deps);
    return { deps, handlers };
  }

  it.each(['active', 'completed', 'abandoned'] as const)(
    'PR detail fetch reconciles matching projects when status is %s',
    async (status) => {
      const { deps, handlers } = setup();
      deps.getPullRequest.mockResolvedValue({ id: 12, status });
      const params = {
        providerId: 'provider-1',
        projectId: 'ado-project-1',
        repoId: 'repo-1',
        pullRequestId: 12,
      };

      await expect(
        handlers.get('azureDevOps:getPullRequest')?.({}, params),
      ).resolves.toEqual({ id: 12, status });
      expect(deps.reconcilePrWorkspaceState).toHaveBeenCalledWith({
        projectId: 'project-1',
        pullRequestId: 12,
      });
    },
  );

  it('pending-decision handler returns grouped service data', async () => {
    const { deps, handlers } = setup();

    await expect(
      handlers.get('tasks:listPendingPrWorkspaceDecisions')?.({}),
    ).resolves.toEqual([
      { projectId: 'project-1', pullRequestId: 12, taskIds: ['task-1'] },
    ]);
    expect(deps.listPendingPrWorkspaceDecisions).toHaveBeenCalledOnce();
  });

  it('validates and dispatches workspace creation', async () => {
    const { deps, handlers } = setup();

    await expect(
      handlers.get('tasks:createPrReviewTask')?.({}, {
        projectId: 'project-1',
        pullRequestId: 12,
      }),
    ).resolves.toEqual({ id: 'task-1' });
    expect(deps.createPrReviewTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      pullRequestId: 12,
    });
  });

  it.each([12, Number.MAX_SAFE_INTEGER])(
    'accepts finite positive safe integer PR ID %s',
    async (pullRequestId) => {
      const { deps, handlers } = setup();
      await expect(
        handlers.get('tasks:deleteAllPrWorkspaces')?.({}, {
          projectId: 'project-1',
          pullRequestId,
        }),
      ).resolves.toEqual({ action: 'deleted', taskIds: ['task-1'] });
      expect(deps.deleteAllPrWorkspaces).toHaveBeenCalledWith({
        projectId: 'project-1',
        pullRequestId,
      });
    },
  );

  it.each(['12', NaN, Infinity, 1.5, 0, -1])(
    'rejects malformed PR ID %s before service dispatch',
    async (pullRequestId) => {
      const { deps, handlers } = setup();
      await expect(
        handlers.get('tasks:resolveClosedPrWorkspace')?.({}, {
          projectId: 'project-1',
          pullRequestId,
          action: 'keep',
        }),
      ).rejects.toThrow('pullRequestId');
      expect(deps.resolveClosedPrWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['tasks:deletePrWorkspaceTask', null],
    ['tasks:deletePrWorkspaceTask', { taskId: '' }],
    ['tasks:createPrReviewTask', { projectId: '', pullRequestId: 12 }],
    ['tasks:createPrReviewTask', { projectId: 'project-1', pullRequestId: NaN }],
    ['tasks:deleteAllPrWorkspaces', []],
    ['tasks:deleteAllPrWorkspaces', { projectId: '', pullRequestId: 12 }],
    ['tasks:deleteAllPrWorkspaces', { projectId: 'project-1', pullRequestId: Number.MAX_SAFE_INTEGER + 1 }],
    ['tasks:resolveClosedPrWorkspace', { projectId: 'project-1', pullRequestId: 12, action: 'other' }],
  ])('rejects malformed %s payload before service dispatch', async (channel, params) => {
    const { deps, handlers } = setup();

    await expect(handlers.get(channel)?.({}, params)).rejects.toThrow('Invalid');
    expect(deps.deletePrWorkspaceTask).not.toHaveBeenCalled();
    expect(deps.createPrReviewTask).not.toHaveBeenCalled();
    expect(deps.deleteAllPrWorkspaces).not.toHaveBeenCalled();
    expect(deps.resolveClosedPrWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { providerId: '', projectId: 'ado-project-1', repoId: 'repo-1', pullRequestId: 12 },
    { providerId: 'provider-1', projectId: '', repoId: 'repo-1', pullRequestId: 12 },
    { providerId: 'provider-1', projectId: 'ado-project-1', repoId: '', pullRequestId: 12 },
    { providerId: 'provider-1', projectId: 'ado-project-1', repoId: 'repo-1', pullRequestId: 1.5 },
  ])('rejects malformed PR detail payload before provider dispatch', async (params) => {
    const { deps, handlers } = setup();

    await expect(
      handlers.get('azureDevOps:getPullRequest')?.({}, params),
    ).rejects.toThrow('Invalid');
    expect(deps.getPullRequest).not.toHaveBeenCalled();
  });
});
