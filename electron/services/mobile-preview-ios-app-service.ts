import type {
  MobilePreviewIosAppRequestParams,
  MobilePreviewIosAppRestartResult,
  MobilePreviewIosAppStatus,
  MobilePreviewIosAppStatusCancelParams,
  MobilePreviewIosAppStatusRequestParams,
} from '../../shared/mobile-simulator-types';
import type { MobilePreviewProjectConfig } from '../../shared/types';

import { ProjectRepository, TaskRepository } from '../database/repositories';
import {
  resolvePathInsideRoot,
  resolveTrustedTaskRoot,
} from './mobile-preview-path-resolver';
import { iosIdbAdapter } from './mobile-preview-ios-idb-adapter';

type ProjectScope = {
  id: string;
  path: string;
  mobilePreviewConfig?: Pick<
    MobilePreviewProjectConfig,
    'iosBundleId' | 'packageManager'
  > | null;
};
type TaskScope = {
  projectId: string;
  worktreePath: string | null;
};

function assertRequestParams(
  params: MobilePreviewIosAppRequestParams,
): asserts params is MobilePreviewIosAppRequestParams {
  if (
    !params ||
    typeof params !== 'object' ||
    !['projectId', 'taskId', 'appPath', 'deviceId'].every(
      (key) =>
        typeof (params as unknown as Record<string, unknown>)[key] === 'string' &&
        Boolean((params as unknown as Record<string, string>)[key].trim()),
    )
  ) {
    throw new Error('Invalid iOS app request');
  }
}

export function createMobilePreviewIosAppService(deps: {
  findProjectById: (id: string) => Promise<ProjectScope | undefined>;
  findTaskById: (id: string) => Promise<TaskScope | undefined>;
  resolveTaskRoot: typeof resolveTrustedTaskRoot;
  resolveAppPath: typeof resolvePathInsideRoot;
  getIosAppStatus: (params: {
    trustedRoot: string;
    appPath: string;
    deviceId: string;
    iosBundleId?: string | null;
    packageManager?: MobilePreviewProjectConfig['packageManager'];
    signal: AbortSignal;
  }) => Promise<MobilePreviewIosAppStatus>;
  restartIosApp: (params: {
    trustedRoot: string;
    appPath: string;
    deviceId: string;
    iosBundleId?: string | null;
    packageManager?: MobilePreviewProjectConfig['packageManager'];
  }) => Promise<MobilePreviewIosAppRestartResult>;
}) {
  const activeStatusRequests = new Map<
    string,
    {
      projectId: string;
      taskId: string;
      abortController: AbortController;
    }
  >();

  async function resolveRequest(params: MobilePreviewIosAppRequestParams) {
    assertRequestParams(params);
    const [project, task] = await Promise.all([
      deps.findProjectById(params.projectId),
      deps.findTaskById(params.taskId),
    ]);
    if (!project) throw new Error('Project not found');
    if (!task || task.projectId !== project.id) {
      throw new Error('Task not found for project');
    }
    const rootPath = await deps.resolveTaskRoot({
      projectPath: project.path,
      worktreePath: task.worktreePath,
    });
    const appPath = await deps.resolveAppPath({
      rootPath,
      relativePath: params.appPath,
    });
    return {
      trustedRoot: rootPath,
      appPath,
      deviceId: params.deviceId,
      iosBundleId: project.mobilePreviewConfig?.iosBundleId,
      packageManager: project.mobilePreviewConfig?.packageManager,
    };
  }

  return {
    async getIosAppStatus(params: MobilePreviewIosAppStatusRequestParams) {
      assertRequestParams(params);
      if (!params.requestId?.trim()) throw new Error('Invalid iOS app request');
      if (activeStatusRequests.has(params.requestId)) {
        throw new Error('Duplicate iOS app status request');
      }
      const entry = {
        projectId: params.projectId,
        taskId: params.taskId,
        abortController: new AbortController(),
      };
      activeStatusRequests.set(params.requestId, entry);
      try {
        const resolved = await resolveRequest(params);
        entry.abortController.signal.throwIfAborted();
        return await deps.getIosAppStatus({
          ...resolved,
          signal: entry.abortController.signal,
        });
      } finally {
        if (activeStatusRequests.get(params.requestId) === entry) {
          activeStatusRequests.delete(params.requestId);
        }
      }
    },
    cancelIosAppStatus(params: MobilePreviewIosAppStatusCancelParams) {
      if (
        !params ||
        typeof params !== 'object' ||
        ![params.projectId, params.taskId, params.requestId].every(
          (value) => typeof value === 'string' && Boolean(value.trim()),
        )
      ) {
        throw new Error('Invalid iOS app status cancellation');
      }
      const entry = activeStatusRequests.get(params.requestId);
      if (
        !entry ||
        entry.projectId !== params.projectId ||
        entry.taskId !== params.taskId
      ) {
        return false;
      }
      entry.abortController.abort(
        new DOMException('iOS app status request cancelled', 'AbortError'),
      );
      return true;
    },
    async restartIosApp(params: MobilePreviewIosAppRequestParams) {
      return deps.restartIosApp(await resolveRequest(params));
    },
  };
}

export const mobilePreviewIosAppService = createMobilePreviewIosAppService({
  findProjectById: ProjectRepository.findById,
  findTaskById: TaskRepository.findById,
  resolveTaskRoot: resolveTrustedTaskRoot,
  resolveAppPath: resolvePathInsideRoot,
  getIosAppStatus: iosIdbAdapter.getIosAppStatus,
  restartIosApp: iosIdbAdapter.restartIosApp,
});
