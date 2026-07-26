import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
  logIpc: vi.fn(),
  logPermission: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
}));

vi.mock('../lib/debug', () => ({
  dbg: { ipc: mocks.logIpc, agentPermission: mocks.logPermission },
}));

import {
  clearPermissionsChangedListeners,
  emitPermissionsChanged,
  onPermissionsChanged,
  PERMISSIONS_CHANGED_CHANNEL,
} from './permission-event-service';

function makeWindow(id: number, send = vi.fn()) {
  return {
    isDestroyed: () => false,
    webContents: { id, send, isDestroyed: () => false },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionsChangedListeners();
  mocks.getAllWindows.mockReturnValue([]);
});

it('notifies in-process listeners and every window', () => {
  const listener = vi.fn();
  onPermissionsChanged(listener);
  const send = vi.fn();
  mocks.getAllWindows.mockReturnValue([makeWindow(1, send)]);

  emitPermissionsChanged({ scope: 'project', projectPath: '/repo' });

  expect(listener).toHaveBeenCalledWith({
    scope: 'project',
    projectPath: '/repo',
  });
  expect(send).toHaveBeenCalledWith(PERMISSIONS_CHANGED_CHANNEL, {
    scope: 'project',
    projectPath: '/repo',
  });
});

it('is a no-op when no windows exist', () => {
  expect(() => emitPermissionsChanged({ scope: 'global' })).not.toThrow();
});

it('isolates listener and window failures', () => {
  onPermissionsChanged(() => {
    throw new Error('listener boom');
  });
  const laterListener = vi.fn();
  onPermissionsChanged(laterListener);
  const failingSend = vi.fn(() => {
    throw new Error('send boom');
  });
  const okSend = vi.fn();
  mocks.getAllWindows.mockReturnValue([
    makeWindow(1, failingSend),
    makeWindow(2, okSend),
  ]);

  expect(() => emitPermissionsChanged({ scope: 'global' })).not.toThrow();
  expect(laterListener).toHaveBeenCalledTimes(1);
  expect(okSend).toHaveBeenCalledTimes(1);
});

it('stops notifying after unsubscribe', () => {
  const listener = vi.fn();
  const unsubscribe = onPermissionsChanged(listener);
  unsubscribe();

  emitPermissionsChanged({ scope: 'global' });

  expect(listener).not.toHaveBeenCalled();
});
