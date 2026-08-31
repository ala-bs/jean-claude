import clsx from 'clsx';
import { Smartphone } from 'lucide-react';

import {
  isPhysicalMobilePreviewDevice,
  type MobilePreviewDevice,
} from '@shared/mobile-simulator-types';

import {
  formatDeviceConnectionState,
  formatDeviceState,
} from '../utils-device-setup';
import type { MobilePreviewDeviceTaskInfo } from '../utils-device-assignments';
import { PlatformLogo } from '../ui-common';

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
  const isPhysical = isPhysicalMobilePreviewDevice(device);
  const isUnusable = !!device.unavailableReason;

  // Physical devices report reachability instead of a boot state, so the dot
  // must track the connection rather than `state`.
  const dotClassName = isLive
    ? 'bg-status-done animate-pulse shadow-[0_0_7px_var(--color-status-done)]'
    : isPhysical
      ? device.connection === 'connected'
        ? 'bg-status-done shadow-[0_0_7px_var(--color-status-done)]'
        : device.connection === 'unauthorized' || device.connection === 'untrusted'
          ? 'bg-status-run'
          : 'bg-ink-4'
      : isBooted
        ? 'bg-status-done shadow-[0_0_7px_var(--color-status-done)]'
        : 'bg-ink-4';

  const meta = getDeviceMetaLabel(device, isPhysical);

  return (
    <button
      type="button"
      onClick={onSelect}
      title={
        device.unavailableReason
          ? `${device.name} — ${device.unavailableReason}`
          : taskInfo
            ? `${device.name} — ${taskInfo.taskName} (${taskInfo.statusLabel})`
            : `${device.name} — no task`
      }
      className={clsx(
        'flex w-full items-start gap-2 rounded-[5px] px-2 py-1.5 text-left transition-colors',
        className,
        selected
          ? 'bg-acc-soft shadow-[inset_2px_0_0_var(--color-acc)]'
          : 'hover:bg-bg-2',
        isUnusable && 'opacity-60',
      )}
    >
      <span
        aria-hidden
        className={clsx('mt-[5px] size-[7px] shrink-0 rounded-full', dotClassName)}
      />

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          {isPhysical ? (
            <span title="Real device" className="flex shrink-0 items-center">
              <Smartphone aria-label="Real device" className="text-ink-3 size-3" />
            </span>
          ) : null}
          <span
            className={clsx(
              'min-w-0 truncate text-[12px] font-medium',
              isUnusable ? 'text-ink-3' : 'text-ink-1',
            )}
          >
            {device.name}
          </span>
          <span className="text-ink-4 min-w-0 truncate font-mono text-[10px]">
            {meta}
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

function normalizeForCompare(value: string) {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

/**
 * Physical devices carry a marketing model name that is usually more useful
 * than the raw host name ("Patrick's iPhone"), so it is preferred whenever it
 * adds information the name does not already carry.
 *
 * A non-connected physical device also states its connection in words: the dot
 * colour alone is invisible to screen readers and to anyone who does not hover.
 */
export function getDeviceMetaLabel(
  device: MobilePreviewDevice,
  isPhysical: boolean,
) {
  const connectionState = isPhysical
    ? formatDeviceConnectionState(device)
    : null;
  const base = getDeviceDescriptorLabel(device, isPhysical);
  if (!connectionState) return base;
  // Rail width is tight: the connection state matters more than the OS build,
  // so it replaces the fallback rather than stacking onto it.
  const model = isPhysical ? device.model?.trim() : undefined;
  const showModel =
    !!model &&
    !normalizeForCompare(device.name).includes(normalizeForCompare(model));
  return showModel ? `${model} · ${connectionState}` : connectionState;
}

function getDeviceDescriptorLabel(
  device: MobilePreviewDevice,
  isPhysical: boolean,
) {
  const fallback = device.osVersion ?? formatDeviceState(device.state);
  if (!isPhysical || !device.model) return fallback;
  const model = device.model.trim();
  if (!model) return fallback;
  if (normalizeForCompare(device.name).includes(normalizeForCompare(model))) {
    return fallback;
  }
  return device.osVersion ? `${model} · ${device.osVersion}` : model;
}
