import { BrowserWindow, type WebContents } from 'electron';

import {
  type CacheEvent,
  type CacheSubscription,
  type CacheSubscriptionUpdate,
  getCacheEventResourceKeys,
  matchesCacheSubscription,
} from '@shared/cache-events';
import type { Task, TaskStep } from '@shared/types';

import { dbg } from '../lib/debug';

const subscriptionsByWebContentsId = new Map<number, CacheSubscription[]>();
const subscriptionRevisionByWebContentsId = new Map<number, number>();
const trackedWebContentsIds = new Set<number>();

// Each renderer window declares which cache resources it currently observes.
// Main uses this registry to avoid broadcasting every cache event to every window.
export function setCacheSubscriptions(
  webContents: WebContents,
  update: CacheSubscriptionUpdate,
) {
  const currentRevision = subscriptionRevisionByWebContentsId.get(
    webContents.id,
  );

  if (currentRevision !== undefined && update.revision < currentRevision) {
    return;
  }

  subscriptionRevisionByWebContentsId.set(webContents.id, update.revision);
  subscriptionsByWebContentsId.set(webContents.id, update.subscriptions);

  if (!trackedWebContentsIds.has(webContents.id)) {
    trackedWebContentsIds.add(webContents.id);
    webContents.once('destroyed', () => {
      trackedWebContentsIds.delete(webContents.id);
      subscriptionsByWebContentsId.delete(webContents.id);
      subscriptionRevisionByWebContentsId.delete(webContents.id);
    });
  }
}

export function clearCacheSubscriptions(webContents: WebContents) {
  subscriptionsByWebContentsId.delete(webContents.id);
  subscriptionRevisionByWebContentsId.delete(webContents.id);
}

export function shouldSendCacheEvent(
  subscriptions: CacheSubscription[],
  event: CacheEvent,
) {
  const resourceKeys = getCacheEventResourceKeys(event);
  return subscriptions.some((subscription) =>
    resourceKeys.some((resourceKey) =>
      matchesCacheSubscription(subscription, resourceKey),
    ),
  );
}

export function emitCacheEvent(event: CacheEvent): CacheEvent {
  const windows = BrowserWindow?.getAllWindows?.() ?? [];
  for (const win of windows) {
    const subscriptions = subscriptionsByWebContentsId.get(win.webContents.id);

    // [qac-debug] temporary instrumentation for the queue-auto-complete toggle.
    if (event.type === 'project.upsert' || event.type === 'project.patch') {
      // `willSend` must account for the liveness guard below, not just the
      // subscription match — otherwise a closing window logs `willSend=true`
      // while nothing is sent, which is the exact false lead this hunts.
      const isAlive = !win.isDestroyed() && !win.webContents.isDestroyed();
      console.warn(
        '[qac] emit %s wc=%d alive=%s subs=%d willSend=%s payload=%o',
        event.type,
        win.webContents.id,
        isAlive,
        subscriptions?.length ?? -1,
        subscriptions
          ? isAlive && shouldSendCacheEvent(subscriptions, event)
          : 'no-subs',
        event.type === 'project.upsert'
          ? {
              id: event.project.id,
              queuePrAutoComplete: event.project.queuePrAutoComplete,
            }
          : { id: event.projectId, patch: Object.keys(event.patch) },
      );
    }

    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      if (subscriptions && shouldSendCacheEvent(subscriptions, event)) {
        try {
          win.webContents.send('cache:event', event);
        } catch (error) {
          dbg.ipc(
            'Failed sending cache event %s to web contents %s: %O',
            event.type,
            win.webContents.id,
            error,
          );
        }
      }
    }
  }

  return event;
}

export function emitTaskUpsert(task: Task, previousProjectId?: string) {
  return emitCacheEvent({ type: 'task.upsert', task, previousProjectId });
}

export function emitTaskPatch({
  taskId,
  projectId,
  patch,
  invalidateFeed,
}: {
  taskId: string;
  projectId: string;
  patch: Partial<Task>;
  invalidateFeed?: boolean;
}) {
  return emitCacheEvent({
    type: 'task.patch',
    taskId,
    projectId,
    patch,
    invalidateFeed,
  });
}

export function emitTaskDelete({
  taskId,
  projectId,
  stepIds,
}: {
  taskId: string;
  projectId: string;
  stepIds?: string[];
}) {
  return emitCacheEvent({ type: 'task.delete', taskId, projectId, stepIds });
}

export function emitStepUpsert(step: TaskStep, previousTaskId?: string) {
  return emitCacheEvent({ type: 'step.upsert', step, previousTaskId });
}

export function emitStepPatch({
  stepId,
  taskId,
  patch,
}: {
  stepId: string;
  taskId: string;
  patch: Partial<TaskStep>;
}) {
  return emitCacheEvent({ type: 'step.patch', stepId, taskId, patch });
}

export function emitStepDelete({
  stepId,
  taskId,
}: {
  stepId: string;
  taskId: string;
}) {
  return emitCacheEvent({ type: 'step.delete', stepId, taskId });
}
