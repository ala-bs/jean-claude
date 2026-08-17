import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../database/repositories', () => ({
  ProjectRepository: { findById: vi.fn() },
  TaskRepository: { findById: vi.fn() },
}));
vi.mock('./mobile-preview-ios-idb-adapter', () => ({
  iosIdbAdapter: {
    getIosAppStatus: vi.fn(),
    restartIosApp: vi.fn(),
  },
}));

import { createMobilePreviewIosAppService } from './mobile-preview-ios-app-service';

describe('mobilePreviewIosAppService', () => {
  const deps = {
    findProjectById: vi.fn(),
    findTaskById: vi.fn(),
    resolveTaskRoot: vi.fn(),
    resolveAppPath: vi.fn(),
    getIosAppStatus: vi.fn(),
    restartIosApp: vi.fn(),
  };
  const params = {
    projectId: 'project-1',
    taskId: 'task-1',
    appPath: 'apps/mobile',
    deviceId: 'device-1',
    requestId: 'request-1',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    deps.findProjectById.mockResolvedValue({
      id: 'project-1',
      path: '/project',
      mobilePreviewConfig: {
        iosBundleId: ' com.example.configured ',
        packageManager: 'pnpm',
      },
    });
    deps.findTaskById.mockResolvedValue({
      projectId: 'project-1',
      worktreePath: null,
    });
    deps.resolveTaskRoot.mockResolvedValue('/canonical/project');
    deps.resolveAppPath.mockResolvedValue('/canonical/project/apps/mobile');
    deps.getIosAppStatus.mockResolvedValue({
      appInstalled: true,
      bundleId: 'com.example.app',
      nativeProjectExists: true,
    });
  });

  it('rejects project/task mismatch', async () => {
    deps.findTaskById.mockResolvedValue({
      projectId: 'other-project',
      worktreePath: null,
    });
    const service = createMobilePreviewIosAppService(deps);

    await expect(service.getIosAppStatus(params)).rejects.toThrow(
      'Task not found for project',
    );
    expect(deps.resolveTaskRoot).not.toHaveBeenCalled();
  });

  it('uses canonical project fallback and delegates canonical app path', async () => {
    const service = createMobilePreviewIosAppService(deps);

    await service.getIosAppStatus(params);

    expect(deps.resolveTaskRoot).toHaveBeenCalledWith({
      projectPath: '/project',
      worktreePath: null,
    });
    expect(deps.resolveAppPath).toHaveBeenCalledWith({
      rootPath: '/canonical/project',
      relativePath: 'apps/mobile',
    });
    expect(deps.getIosAppStatus).toHaveBeenCalledWith({
      trustedRoot: '/canonical/project',
      appPath: '/canonical/project/apps/mobile',
      deviceId: 'device-1',
      iosBundleId: ' com.example.configured ',
      packageManager: 'pnpm',
      signal: expect.any(AbortSignal),
    });
  });

  it('passes trusted project config to restart and ignores renderer overrides', async () => {
    const service = createMobilePreviewIosAppService(deps);

    await service.restartIosApp({
      ...params,
      iosBundleId: 'com.renderer.override',
      packageManager: 'yarn',
    } as typeof params);

    expect(deps.restartIosApp).toHaveBeenCalledWith({
      trustedRoot: '/canonical/project',
      appPath: '/canonical/project/apps/mobile',
      deviceId: 'device-1',
      iosBundleId: ' com.example.configured ',
      packageManager: 'pnpm',
    });
  });

  it('validates and uses task worktree path', async () => {
    deps.findTaskById.mockResolvedValue({
      projectId: 'project-1',
      worktreePath: '/project-worktree',
    });
    deps.resolveTaskRoot.mockResolvedValue('/canonical/project-worktree');
    const service = createMobilePreviewIosAppService(deps);

    await service.getIosAppStatus(params);

    expect(deps.resolveTaskRoot).toHaveBeenCalledWith({
      projectPath: '/project',
      worktreePath: '/project-worktree',
    });
    expect(deps.resolveAppPath).toHaveBeenCalledWith({
      rootPath: '/canonical/project-worktree',
      relativePath: 'apps/mobile',
    });
  });

  it('rejects malformed renderer payloads', async () => {
    const service = createMobilePreviewIosAppService(deps);

    await expect(
      service.getIosAppStatus({ ...params, appPath: '' }),
    ).rejects.toThrow('Invalid iOS app request');
    expect(deps.findProjectById).not.toHaveBeenCalled();
  });

  it('cancels only a matching project/task status request', async () => {
    let statusSignal: AbortSignal | undefined;
    deps.getIosAppStatus.mockImplementation(
      ({ signal }: { signal: AbortSignal }) => {
        statusSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const service = createMobilePreviewIosAppService(deps);
    const pending = service.getIosAppStatus(params);
    await vi.waitFor(() => expect(statusSignal).toBeDefined());

    expect(
      service.cancelIosAppStatus({
        projectId: 'other-project',
        taskId: 'task-1',
        requestId: 'request-1',
      }),
    ).toBe(false);
    expect(statusSignal?.aborted).toBe(false);

    expect(
      service.cancelIosAppStatus({
        projectId: 'project-1',
        taskId: 'task-1',
        requestId: 'request-1',
      }),
    ).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
