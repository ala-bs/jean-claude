// Permission change broadcasting.
//
// Persisted permission rules can be mutated from many places (permission bar,
// settings views, agent-driven "allow for project" flows). Every write path
// funnels through `emitPermissionsChanged` so that:
//
// - the main process can refresh the rule snapshot of every live agent session
//   (see agent-service), and
// - every renderer window can invalidate its permission queries.
//
// Renderer delivery mirrors `cache-event-service`: a direct `webContents.send`
// on the `permissions:changed` channel, and a no-op when no window exists
// (unit tests, headless main process boot).

import { BrowserWindow } from 'electron';

import type { PermissionsChangedEvent } from '@shared/permission-types';

import { dbg } from '../lib/debug';

export const PERMISSIONS_CHANGED_CHANNEL = 'permissions:changed';

type PermissionsChangedListener = (event: PermissionsChangedEvent) => void;

const listeners = new Set<PermissionsChangedListener>();

/**
 * Subscribe to permission changes inside the main process.
 * Returns an unsubscribe function.
 */
export function onPermissionsChanged(
  listener: PermissionsChangedListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper — drops every in-process listener. */
export function clearPermissionsChangedListeners(): void {
  listeners.clear();
}

function broadcastToWindows(event: PermissionsChangedEvent) {
  const windows = BrowserWindow?.getAllWindows?.() ?? [];
  for (const win of windows) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(PERMISSIONS_CHANGED_CHANNEL, event);
    } catch (error) {
      dbg.ipc(
        'Failed sending permissions:changed to web contents %s: %O',
        win.webContents.id,
        error,
      );
    }
  }
}

/**
 * Notify main-process listeners and every renderer window that persisted
 * permission rules changed.
 */
export function emitPermissionsChanged(
  event: PermissionsChangedEvent,
): PermissionsChangedEvent {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      dbg.agentPermission('permissions:changed listener failed: %O', error);
    }
  }

  broadcastToWindows(event);

  return event;
}
