import type {
  MobilePreviewDeviceAssignment,
  MobilePreviewStatus,
} from '@shared/mobile-simulator-types';
import type { Task } from '@shared/types';

import { PROJECT_COLORS } from '@/lib/colors';

import { getPreviewDeviceKey } from './utils-device-setup';

/**
 * Stable per-task tint for the accent bar on a device row, so the same task
 * always reads as the same colour across devices and across app restarts.
 */
export function getMobilePreviewTaskTint(taskId: string): string {
  let hash = 0;
  for (let index = 0; index < taskId.length; index += 1) {
    hash = (hash * 31 + taskId.charCodeAt(index)) | 0;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

/**
 * What the device rail needs to render the task that owns a device.
 *
 * `isActive` distinguishes "a preview is streaming here right now" from "this
 * is simply the last task that used this device" — both are shown, but the
 * latter is presented as history rather than as a live session.
 */
export type MobilePreviewDeviceTaskInfo = {
  taskId: string;
  taskName: string;
  isCurrentTask: boolean;
  isActive: boolean;
  status: MobilePreviewStatus | null;
  statusLabel: string;
  tint: string;
};

const UNTITLED_TASK_NAME = 'Untitled task';

export function getMobilePreviewTaskName(task: Task | undefined): string {
  const name = task?.name?.trim();
  return name && name.length > 0 ? name : UNTITLED_TASK_NAME;
}

/**
 * Short status text shown under the task name on a device row. `null` status
 * means the association came from persisted usage, not a live session.
 */
export function getMobilePreviewAssignmentStatusLabel({
  isActive,
  status,
}: {
  isActive: boolean;
  status: MobilePreviewStatus | null;
}): string {
  if (!isActive) return 'Last used';
  switch (status) {
    case 'streaming':
      return 'Live';
    case 'starting':
      return 'Starting…';
    case 'checking-tools':
      return 'Checking tools…';
    case 'error':
      return 'Error';
    case 'stopped':
    case 'idle':
    case null:
    default:
      return 'Idle';
  }
}

/**
 * Builds `deviceKey -> owning task` for the device rail.
 *
 * Assignments whose task no longer exists are dropped: a deleted task must not
 * leave a phantom label on a device. Live assignments win over remembered ones
 * for the same device, mirroring the main process's own precedence.
 */
export function buildMobilePreviewDeviceTaskMap({
  assignments,
  tasks,
  currentTaskId,
}: {
  assignments: readonly MobilePreviewDeviceAssignment[];
  tasks: readonly Task[];
  currentTaskId: string | null;
}): Map<string, MobilePreviewDeviceTaskInfo> {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const deviceTaskMap = new Map<string, MobilePreviewDeviceTaskInfo>();

  assignments.forEach((assignment) => {
    const task = tasksById.get(assignment.taskId);
    if (!task) return;

    const deviceKey = getPreviewDeviceKey(
      assignment.platform,
      assignment.deviceId,
    );
    const existing = deviceTaskMap.get(deviceKey);
    if (existing?.isActive && !assignment.isActive) return;

    deviceTaskMap.set(deviceKey, {
      taskId: assignment.taskId,
      taskName: getMobilePreviewTaskName(task),
      isCurrentTask: assignment.taskId === currentTaskId,
      isActive: assignment.isActive,
      status: assignment.status,
      statusLabel: getMobilePreviewAssignmentStatusLabel({
        isActive: assignment.isActive,
        status: assignment.status,
      }),
      tint: getMobilePreviewTaskTint(assignment.taskId),
    });
  });

  return deviceTaskMap;
}

/**
 * The task label for one device row.
 *
 * The cross-task assignments query only polls, so a preview this pane just
 * started is not in it yet. When that happens we substitute an optimistic entry
 * for the current task — but never over a device another task is genuinely
 * streaming on, so a local start can't relabel someone else's live session.
 */
export function resolveDeviceRowTaskInfo({
  assignedTask,
  isLocallyActive,
  isStarting,
  currentTaskId,
  currentTask,
}: {
  assignedTask: MobilePreviewDeviceTaskInfo | undefined;
  isLocallyActive: boolean;
  isStarting: boolean;
  currentTaskId: string;
  currentTask: Task | undefined;
}): MobilePreviewDeviceTaskInfo | undefined {
  if (!isLocallyActive || assignedTask?.isActive) return assignedTask;

  const status: MobilePreviewStatus = isStarting ? 'starting' : 'streaming';
  return {
    taskId: currentTaskId,
    taskName: getMobilePreviewTaskName(currentTask),
    isCurrentTask: true,
    isActive: true,
    status,
    statusLabel: getMobilePreviewAssignmentStatusLabel({
      isActive: true,
      status,
    }),
    tint: getMobilePreviewTaskTint(currentTaskId),
  };
}
