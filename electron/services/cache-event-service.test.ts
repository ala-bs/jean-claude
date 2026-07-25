import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  log: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
}));

vi.mock('../lib/debug', () => ({
  dbg: { ipc: mocks.log },
}));

import { emitTaskDelete, setCacheSubscriptions } from './cache-event-service';

beforeEach(() => {
  vi.clearAllMocks();
});

it('isolates failed window sends and continues later windows and events', () => {
  const failedSend = vi.fn(() => {
    throw new Error('destroyed during send');
  });
  const successfulSend = vi.fn();
  const windows = [
    makeWindow(1, failedSend),
    makeWindow(2, successfulSend),
  ];
  windows.forEach((window) =>
    setCacheSubscriptions(window.webContents as never, {
      revision: 1,
      subscriptions: [{ resourceKey: 'tasks' }],
    }),
  );
  mocks.getAllWindows.mockReturnValue(windows);

  expect(() =>
    emitTaskDelete({ taskId: 'task-1', projectId: 'project-1' }),
  ).not.toThrow();
  expect(() =>
    emitTaskDelete({ taskId: 'task-2', projectId: 'project-1' }),
  ).not.toThrow();

  expect(failedSend).toHaveBeenCalledTimes(2);
  expect(successfulSend).toHaveBeenCalledTimes(2);
  expect(mocks.log).toHaveBeenCalledTimes(2);
});

function makeWindow(id: number, send: ReturnType<typeof vi.fn>) {
  return {
    isDestroyed: () => false,
    webContents: {
      id,
      isDestroyed: () => false,
      once: vi.fn(),
      send,
    },
  };
}
