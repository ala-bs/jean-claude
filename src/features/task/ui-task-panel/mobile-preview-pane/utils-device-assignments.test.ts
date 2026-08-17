import { describe, expect, it } from 'vitest';

import type { MobilePreviewDeviceAssignment } from '@shared/mobile-simulator-types';
import type { Task } from '@shared/types';

import { PROJECT_COLORS } from '@/lib/colors';

import {
  buildMobilePreviewDeviceTaskMap,
  getMobilePreviewAssignmentStatusLabel,
  getMobilePreviewTaskName,
  getMobilePreviewTaskTint,
  type MobilePreviewDeviceTaskInfo,
  resolveDeviceRowTaskInfo,
} from './utils-device-assignments';

function createTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    projectId: 'project-1',
    type: 'task',
    name: null,
    prompt: '',
    status: 'idle',
    worktreePath: null,
    startCommitHash: null,
    sourceBranch: null,
    branchName: null,
    prWorkspaceState: null,
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: null,
    pullRequestUrl: null,
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    ...overrides,
  } as Task;
}

function createAssignment(
  overrides: Partial<MobilePreviewDeviceAssignment> = {},
): MobilePreviewDeviceAssignment {
  return {
    platform: 'ios',
    deviceId: 'device-1',
    taskId: 'task-1',
    isActive: false,
    status: null,
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('getMobilePreviewTaskName', () => {
  it('falls back to a placeholder for blank names', () => {
    expect(getMobilePreviewTaskName(createTask({ id: 'a', name: '   ' }))).toBe(
      'Untitled task',
    );
    expect(getMobilePreviewTaskName(undefined)).toBe('Untitled task');
  });

  it('uses the task name when present', () => {
    expect(
      getMobilePreviewTaskName(createTask({ id: 'a', name: 'add extras' })),
    ).toBe('add extras');
  });
});

describe('getMobilePreviewAssignmentStatusLabel', () => {
  it('reports remembered associations as history', () => {
    expect(
      getMobilePreviewAssignmentStatusLabel({ isActive: false, status: null }),
    ).toBe('Last used');
  });

  it('maps live session statuses', () => {
    expect(
      getMobilePreviewAssignmentStatusLabel({
        isActive: true,
        status: 'streaming',
      }),
    ).toBe('Live');
    expect(
      getMobilePreviewAssignmentStatusLabel({
        isActive: true,
        status: 'starting',
      }),
    ).toBe('Starting…');
    expect(
      getMobilePreviewAssignmentStatusLabel({ isActive: true, status: 'error' }),
    ).toBe('Error');
  });
});

describe('buildMobilePreviewDeviceTaskMap', () => {
  const tasks = [
    createTask({ id: 'task-1', name: 'add extras' }),
    createTask({ id: 'task-2', name: 'persist devices' }),
  ];

  it('keys assignments by platform and device id', () => {
    const map = buildMobilePreviewDeviceTaskMap({
      assignments: [createAssignment({ platform: 'android', deviceId: 'p30' })],
      tasks,
      currentTaskId: 'task-1',
    });

    expect(map.get('android:p30')).toMatchObject({
      taskId: 'task-1',
      taskName: 'add extras',
      isCurrentTask: true,
      isActive: false,
      statusLabel: 'Last used',
    });
  });

  it('marks assignments belonging to another task', () => {
    const map = buildMobilePreviewDeviceTaskMap({
      assignments: [
        createAssignment({
          taskId: 'task-2',
          isActive: true,
          status: 'streaming',
        }),
      ],
      tasks,
      currentTaskId: 'task-1',
    });

    expect(map.get('ios:device-1')).toMatchObject({
      taskId: 'task-2',
      taskName: 'persist devices',
      isCurrentTask: false,
      isActive: true,
      statusLabel: 'Live',
    });
  });

  it('drops assignments whose task no longer exists', () => {
    const map = buildMobilePreviewDeviceTaskMap({
      assignments: [createAssignment({ taskId: 'deleted-task' })],
      tasks,
      currentTaskId: 'task-1',
    });

    expect(map.size).toBe(0);
  });

  it('prefers a live assignment over a remembered one for the same device', () => {
    const map = buildMobilePreviewDeviceTaskMap({
      assignments: [
        createAssignment({ taskId: 'task-2', isActive: true, status: 'streaming' }),
        createAssignment({ taskId: 'task-1', isActive: false }),
      ],
      tasks,
      currentTaskId: 'task-1',
    });

    expect(map.get('ios:device-1')).toMatchObject({
      taskId: 'task-2',
      isActive: true,
    });
  });
});

describe('resolveDeviceRowTaskInfo', () => {
  const currentTask = createTask({ id: 'task-1', name: 'add extras' });
  const otherTaskLive: MobilePreviewDeviceTaskInfo = {
    taskId: 'task-2',
    taskName: 'persist devices',
    isCurrentTask: false,
    isActive: true,
    status: 'streaming',
    statusLabel: 'Live',
    tint: '#000000',
  };

  it('passes the assignment through when nothing is locally active', () => {
    expect(
      resolveDeviceRowTaskInfo({
        assignedTask: otherTaskLive,
        isLocallyActive: false,
        isStarting: false,
        currentTaskId: 'task-1',
        currentTask,
      }),
    ).toBe(otherTaskLive);
  });

  it('returns undefined for a free device with no local session', () => {
    expect(
      resolveDeviceRowTaskInfo({
        assignedTask: undefined,
        isLocallyActive: false,
        isStarting: false,
        currentTaskId: 'task-1',
        currentTask,
      }),
    ).toBeUndefined();
  });

  it('never relabels a device another task is genuinely streaming on', () => {
    expect(
      resolveDeviceRowTaskInfo({
        assignedTask: otherTaskLive,
        isLocallyActive: true,
        isStarting: true,
        currentTaskId: 'task-1',
        currentTask,
      }),
    ).toBe(otherTaskLive);
  });

  it('overrides a stale "last used" label with the local session', () => {
    expect(
      resolveDeviceRowTaskInfo({
        assignedTask: { ...otherTaskLive, isActive: false, statusLabel: 'Last used' },
        isLocallyActive: true,
        isStarting: false,
        currentTaskId: 'task-1',
        currentTask,
      }),
    ).toMatchObject({
      taskId: 'task-1',
      taskName: 'add extras',
      isCurrentTask: true,
      isActive: true,
      status: 'streaming',
      statusLabel: 'Live',
    });
  });

  it('reports a starting local session as Starting', () => {
    expect(
      resolveDeviceRowTaskInfo({
        assignedTask: undefined,
        isLocallyActive: true,
        isStarting: true,
        currentTaskId: 'task-1',
        currentTask,
      }),
    ).toMatchObject({ status: 'starting', statusLabel: 'Starting…' });
  });
});

describe('getMobilePreviewTaskTint', () => {
  it('is stable for the same task id', () => {
    expect(getMobilePreviewTaskTint('task-1')).toBe(
      getMobilePreviewTaskTint('task-1'),
    );
  });

  it('returns a colour from the shared palette', () => {
    expect(PROJECT_COLORS).toContain(getMobilePreviewTaskTint('task-1'));
  });
});
