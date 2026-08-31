import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

it('exposes object-param PR workspace deletion channels', async () => {
  await import('./preload');
  const exposed = mocks.exposeInMainWorld.mock.calls.find(
    ([name]) => name === 'api',
  )?.[1] as {
    tasks: {
      deletePrWorkspaceTask: (params: { taskId: string }) => Promise<void>;
      deleteAllPrWorkspaces: (params: {
        projectId: string;
        pullRequestId: number;
      }) => Promise<void>;
    };
  };

  await exposed.tasks.deletePrWorkspaceTask({ taskId: 'task-1' });
  await exposed.tasks.deleteAllPrWorkspaces({
    projectId: 'project-1',
    pullRequestId: 12,
  });

  expect(mocks.invoke).toHaveBeenNthCalledWith(
    1,
    'tasks:deletePrWorkspaceTask',
    { taskId: 'task-1' },
  );
  expect(mocks.invoke).toHaveBeenNthCalledWith(
    2,
    'tasks:deleteAllPrWorkspaces',
    { projectId: 'project-1', pullRequestId: 12 },
  );
});
