import clsx from 'clsx';

import type { MobilePreviewDevice } from '@shared/mobile-simulator-types';

import { PlatformLogo } from '../ui-common';
import type { MobilePreviewDeviceTaskInfo } from '../utils-device-assignments';
import { formatDeviceState } from '../utils-device-setup';

/**
 * One row of the device rail.
 *
 * The row carries the task the device belongs to — either the task currently
 * streaming on it, or the last task that used it. That association is the whole
 * point of the row: a device is never shown as an anonymous slot.
 */
export function DeviceRailRow({
  device,
  selected,
  taskInfo,
  onSelect,
  className,
}: {
  device: MobilePreviewDevice;
  selected: boolean;
  taskInfo: MobilePreviewDeviceTaskInfo | undefined;
  onSelect: () => void;
  className?: string;
}) {
  const isBooted = device.state === 'booted';
  const isLive = taskInfo?.isActive === true;

  return (
    <button
      type="button"
      onClick={onSelect}
      title={
        taskInfo
          ? `${device.name} — ${taskInfo.taskName} (${taskInfo.statusLabel})`
          : `${device.name} — no task`
      }
      className={clsx(
        'flex w-full items-start gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors',
        className,
        selected
          ? 'bg-acc-soft shadow-[inset_2px_0_0_var(--color-acc)]'
          : 'hover:bg-bg-2',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'mt-[5px] size-[7px] shrink-0 rounded-full',
          isLive
            ? 'bg-status-done animate-pulse shadow-[0_0_7px_var(--color-status-done)]'
            : isBooted
              ? 'bg-emerald-300 shadow-[0_0_7px_var(--color-status-done)]'
              : 'bg-ink-4',
        )}
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="text-ink-1 min-w-0 truncate text-[12px] font-medium">
            {device.name}
          </span>
          <span className="text-ink-4 shrink-0 font-mono text-[10px]">
            {device.osVersion ?? formatDeviceState(device.state)}
          </span>
        </span>

        {taskInfo ? (
          <>
            <span className="mt-1 flex items-center gap-1.5">
              <span
                aria-hidden
                style={{ backgroundColor: taskInfo.tint }}
                className="h-3 w-[2px] shrink-0 rounded-full"
              />
              <span
                className={clsx(
                  'min-w-0 truncate text-[11.5px]',
                  taskInfo.isActive ? 'text-ink-1' : 'text-ink-3',
                )}
              >
                {taskInfo.taskName}
              </span>
            </span>
            <span
              className={clsx(
                'mt-0.5 block font-mono text-[10px]',
                taskInfo.isActive ? 'text-status-run' : 'text-ink-4',
              )}
            >
              {taskInfo.statusLabel}
              {taskInfo.isCurrentTask ? ' · this task' : ''}
            </span>
          </>
        ) : (
          <span className="text-ink-4 mt-1 block text-[11px]">
            No task running
          </span>
        )}
      </span>

      <PlatformLogo platform={device.platform} />
    </button>
  );
}
