import { describe, expect, it } from 'vitest';

import type { WorkActivityEvent } from '@shared/work-activity-types';

import { eureciaTimesheetAdapter } from './eurecia-timesheet-adapter';

const baseEvent: WorkActivityEvent = {
  id: 'event-1',
  occurredAt: '2026-06-19T09:00:00.000Z',
  type: 'task_prompted',
  projectId: 'project-1',
  projectName: 'Jean-Claude',
  providerId: 'provider-1',
  azureOrgId: 'org-1',
  azureProjectId: 'azure-project-1',
  repoId: 'repo-1',
  taskId: 'task-1',
  taskTitle: 'Build adapter',
  stepId: 'step-1',
  promptSnippet: 'Build adapter',
  promptLength: 13,
  workItemIds: ['123'],
  workItems: [
    {
      id: '123',
      providerId: 'provider-1',
      azureOrgId: 'org-1',
      azureProjectId: 'azure-project-1',
      title: 'Timesheet integration',
      workItemType: 'User Story',
    },
  ],
  pullRequest: null,
  metadata: {},
};

describe('eureciaTimesheetAdapter', () => {
  it('keeps remote sync disabled', () => {
    expect(eureciaTimesheetAdapter.getCapabilities().supportsSync).toBe(false);
  });

  it('groups draft entries by day, project, and work item', () => {
    const result = eureciaTimesheetAdapter.buildDraft({
      params: {
        provider: 'eurecia',
        start: '2026-06-19T00:00:00.000Z',
        end: '2026-06-20T00:00:00.000Z',
      },
      events: [
        baseEvent,
        {
          ...baseEvent,
          id: 'event-2',
          occurredAt: '2026-06-19T10:00:00.000Z',
          type: 'pr_comment_added',
        },
        {
          ...baseEvent,
          id: 'event-3',
          occurredAt: '2026-06-19T11:00:00.000Z',
          workItemIds: ['456'],
          workItems: [],
        },
      ],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      provider: 'eurecia',
      date: '2026-06-19',
      project: { id: 'project-1', name: 'Jean-Claude' },
      role: null,
      durationMinutes: null,
      workItem: {
        id: '123',
        title: 'Timesheet integration',
        type: 'User Story',
      },
       sourceEventIds: ['event-1', 'event-2', 'event-3'],
     });
    expect(result.entries[0].description).toContain('1 task prompt');
    expect(result.entries[0].description).toContain('1 PR comment');
    expect(result.entries[0].items).toHaveLength(2);
    expect(result.entries[0].items[1].workItem?.id).toBe('456');
    expect(result.warnings).toHaveLength(1);
  });

  it('keeps one parent row per date while preserving child groups', () => {
    const result = eureciaTimesheetAdapter.buildDraft({
      params: {
        provider: 'eurecia',
        start: '2026-06-19T00:00:00.000Z',
        end: '2026-06-20T00:00:00.000Z',
      },
      events: [
        baseEvent,
        { ...baseEvent, id: 'event-2', occurredAt: '2026-06-20T09:00:00.000Z' },
      ],
    });

    expect(result.entries.map(({ date, items }) => [date, items.length])).toEqual([
      ['2026-06-19', 1],
      ['2026-06-20', 1],
    ]);
    expect(result.entries.flatMap(({ sourceEventIds }) => sourceEventIds)).toEqual([
      'event-1',
      'event-2',
    ]);
  });

  it('reports Eurecia sync as not configured until API details exist', async () => {
    await expect(
      eureciaTimesheetAdapter.sync({
        provider: 'eurecia',
        start: '2026-06-19T00:00:00.000Z',
        end: '2026-06-20T00:00:00.000Z',
        entries: [],
      }),
    ).resolves.toMatchObject({
      provider: 'eurecia',
      status: 'not_configured',
    });
  });
});
