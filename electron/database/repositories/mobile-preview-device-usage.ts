import type { MobilePlatform } from '@shared/mobile-simulator-types';

import { db } from '../index';
import type { MobilePreviewDeviceUsageRow } from '../schema';

export type PersistedMobilePreviewDeviceUsage = MobilePreviewDeviceUsageRow;

function getDeviceKey({
  platform,
  deviceId,
}: {
  platform: MobilePlatform;
  deviceId: string;
}): string {
  return `${platform}:${deviceId}`;
}

export const MobilePreviewDeviceUsageRepository = {
  /**
   * Only rows whose task still exists.
   *
   * The table declares `taskId` as a cascading foreign key, but the app
   * connection never enables `PRAGMA foreign_keys` (electron/database/index.ts
   * sets only `journal_mode`), so the cascade never fires and deleting a task
   * leaves its row behind. Filtering on read keeps a deleted task from being
   * attributed to a device. Rows are capped at one per device by the primary
   * key, so orphans are overwritten the next time that device is used.
   */
  listAll: async (): Promise<PersistedMobilePreviewDeviceUsage[]> => {
    return db
      .selectFrom('mobile_preview_device_usage')
      .selectAll('mobile_preview_device_usage')
      .innerJoin('tasks', 'tasks.id', 'mobile_preview_device_usage.taskId')
      .execute();
  },

  /**
   * Records the task that most recently ran a preview on a device. One row per
   * device — a newer task simply replaces the previous association, since
   * devices are attributed rather than owned.
   */
  recordUsage: async ({
    platform,
    deviceId,
    taskId,
    lastUsedAt = new Date().toISOString(),
  }: {
    platform: MobilePlatform;
    deviceId: string;
    taskId: string;
    lastUsedAt?: string;
  }): Promise<PersistedMobilePreviewDeviceUsage> => {
    return db
      .insertInto('mobile_preview_device_usage')
      .values({
        deviceKey: getDeviceKey({ platform, deviceId }),
        platform,
        deviceId,
        taskId,
        lastUsedAt,
      })
      .onConflict((oc) =>
        oc.column('deviceKey').doUpdateSet({ taskId, lastUsedAt }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  },
};
