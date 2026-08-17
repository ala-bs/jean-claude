import type { IpcMain } from 'electron';
import type { PrWorkspaceResolutionResult } from '@shared/types';

import {
  validateNonEmptyId,
  validatePrWorkspacePairParams,
  validateRecord,
} from './pr-input-validation';
import { dbg } from '../lib/debug';

type PullRequestParams = {
  providerId: string;
  projectId: string;
  repoId: string;
  pullRequestId: number;
};

export function registerPrWorkspaceIpcHandlers(deps: {
  ipcMain: Pick<IpcMain, 'handle'>;
  getPullRequest: (params: PullRequestParams) => Promise<unknown>;
  findProjects: () => Promise<
    Array<{
      id: string;
      repoProviderId: string | null;
      repoProjectId: string | null;
      repoId: string | null;
    }>
  >;
  reconcilePrWorkspaceState: (params: {
    projectId: string;
    pullRequestId: number;
  }) => Promise<unknown>;
  listPendingPrWorkspaceDecisions: () => Promise<
    Array<{ projectId: string; pullRequestId: number; taskIds: string[] }>
  >;
  createPrReviewTask: (params: {
    projectId: string;
    pullRequestId: number;
  }) => Promise<unknown>;
  deletePrWorkspaceTask: (params: {
    taskId: string;
  }) => Promise<PrWorkspaceResolutionResult>;
  deleteAllPrWorkspaces: (params: {
    projectId: string;
    pullRequestId: number;
  }) => Promise<PrWorkspaceResolutionResult>;
  resolveClosedPrWorkspace: (params: {
    projectId: string;
    pullRequestId: number;
    action: 'keep' | 'delete';
  }) => Promise<PrWorkspaceResolutionResult>;
}) {
  deps.ipcMain.handle('tasks:listPendingPrWorkspaceDecisions', () =>
    deps.listPendingPrWorkspaceDecisions(),
  );
  deps.ipcMain.handle('tasks:createPrReviewTask', async (_, params: unknown) =>
    deps.createPrReviewTask(validatePrWorkspacePairParams(params)),
  );
  deps.ipcMain.handle('tasks:deletePrWorkspaceTask', async (_, params: unknown) => {
    const value = validateRecord(params, 'PR workspace deletion');
    return deps.deletePrWorkspaceTask({
      taskId: validateNonEmptyId(value.taskId, 'taskId'),
    });
  });
  deps.ipcMain.handle('tasks:deleteAllPrWorkspaces', async (_, params: unknown) =>
    deps.deleteAllPrWorkspaces(validatePrWorkspacePairParams(params)),
  );
  deps.ipcMain.handle(
    'tasks:resolveClosedPrWorkspace',
    async (_, params: unknown) => {
      const pair = validatePrWorkspacePairParams(params);
      const { action } = params as Record<string, unknown>;
      if (action !== 'keep' && action !== 'delete') {
        throw new Error('Invalid PR workspace resolution action');
      }
      return deps.resolveClosedPrWorkspace({ ...pair, action });
    },
  );
  deps.ipcMain.handle(
    'azureDevOps:getPullRequest',
    async (_, params: unknown) => {
      const value = validateRecord(params, 'pull request');
      const pair = validatePrWorkspacePairParams({
        projectId: value.projectId,
        pullRequestId: value.pullRequestId,
      });
      const validatedParams: PullRequestParams = {
        providerId: validateNonEmptyId(value.providerId, 'providerId'),
        projectId: pair.projectId,
        repoId: validateNonEmptyId(value.repoId, 'repoId'),
        pullRequestId: pair.pullRequestId,
      };
      const pullRequest = await deps.getPullRequest(validatedParams);
      try {
        const projects = await deps.findProjects();
        await Promise.all(
          projects
            .filter(
              (project) =>
                project.repoProviderId === validatedParams.providerId &&
                project.repoProjectId === validatedParams.projectId &&
                project.repoId === validatedParams.repoId,
            )
            .map(async (project) => {
              try {
                await deps.reconcilePrWorkspaceState({
                  projectId: project.id,
                  pullRequestId: validatedParams.pullRequestId,
                });
              } catch (error) {
                dbg.ipc(
                  'Failed reconciling PR workspace state for project %s PR %s: %O',
                  project.id,
                  validatedParams.pullRequestId,
                  error,
                );
              }
            }),
        );
      } catch (error) {
        dbg.ipc(
          'Failed finding projects to reconcile for PR %s: %O',
          validatedParams.pullRequestId,
          error,
        );
      }
      return pullRequest;
    },
  );
}
