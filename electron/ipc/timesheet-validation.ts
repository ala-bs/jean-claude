import type {
  TimesheetAction,
  TimesheetAxisLookupRequest,
  TimesheetDraftParams,
  TimesheetEntryInput,
  TimesheetProviderType,
  TimesheetRowDeletion,
  TimesheetSyncParams,
} from '@shared/timesheet-types';

const MAX_STRING_LENGTH = 2_048;
const MAX_COMMENT_LENGTH = 2_000;
const MAX_ENTRIES = 124;
const ALLOWED_FRACTIONS = new Set([0.25, 0.5, 0.75, 1]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function string(
  value: unknown,
  label: string,
  { allowEmpty = false, max = MAX_STRING_LENGTH } = {},
) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > max
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function isoDate(value: unknown, label: string) {
  const result = string(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
  const date = new Date(`${result}T00:00:00Z`);
  if (
    !match ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

function isoDateTime(value: unknown, label: string) {
  const result = string(value, label);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      result,
    );
  if (!match || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${label} is invalid.`);
  }
  const [, year, month, day, hour, minute, second, timezone] = match;
  const local = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  const offset = timezone === 'Z' ? null : timezone.slice(1).split(':').map(Number);
  if (
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() + 1 !== Number(month) ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute) ||
    local.getUTCSeconds() !== Number(second) ||
    (offset && (offset[0] > 23 || offset[1] > 59))
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return result;
}

export function validateTimesheetProvider(value: unknown): TimesheetProviderType {
  if (value !== 'eurecia') throw new Error('Timesheet provider is invalid.');
  return value;
}

function validateEntry(value: unknown): TimesheetEntryInput {
  const input = record(value, 'Timesheet entry');
  const rowIndex = input.rowIndex;
  if (
    rowIndex !== undefined &&
    (!Number.isInteger(rowIndex) || (rowIndex as number) < 0)
  ) {
    throw new Error('Timesheet row index is invalid.');
  }
  if (!ALLOWED_FRACTIONS.has(input.fraction as number)) {
    throw new Error('Timesheet entry fraction is invalid.');
  }
  if (!Array.isArray(input.sourceDraftIds) || input.sourceDraftIds.length > 100) {
    throw new Error('Timesheet entry source drafts are invalid.');
  }
  return {
    date: isoDate(input.date, 'Timesheet entry date'),
    rowIndex: rowIndex as number | undefined,
    fraction: input.fraction as TimesheetEntryInput['fraction'],
    axis1Id: string(input.axis1Id, 'Timesheet axis 1 ID', { allowEmpty: true }),
    axis2Id: string(input.axis2Id, 'Timesheet axis 2 ID', { allowEmpty: true }),
    axis3Id: string(input.axis3Id, 'Timesheet axis 3 ID', { allowEmpty: true }),
    comment: string(input.comment, 'Timesheet comment', {
      allowEmpty: true,
      max: MAX_COMMENT_LENGTH,
    }),
    sourceDraftIds: input.sourceDraftIds.map((id) =>
      string(id, 'Timesheet source draft ID'),
    ),
  };
}

export function validateSheetRequest(value: unknown) {
  const input = record(value, 'Timesheet sheet request');
  return {
    provider: validateTimesheetProvider(input.provider),
    sheetId: string(input.sheetId, 'Timesheet sheet ID'),
    navigationUrl: string(input.navigationUrl, 'Timesheet navigation URL'),
  };
}

export function validateAxisLookupRequest(value: unknown): {
  provider: TimesheetProviderType;
  request: TimesheetAxisLookupRequest;
} {
  const input = record(value, 'Timesheet axis lookup');
  const selected = record(input.selectedAxisIds, 'Timesheet axis selection');
  if (![1, 2, 3].includes(input.axis as number)) {
    throw new Error('Timesheet axis is invalid.');
  }
  if (!Number.isInteger(input.rowIndex) || (input.rowIndex as number) < 0) {
    throw new Error('Timesheet row index is invalid.');
  }
  return {
    provider: validateTimesheetProvider(input.provider),
    request: {
      sheetId: string(input.sheetId, 'Timesheet sheet ID'),
      navigationUrl: string(input.navigationUrl, 'Timesheet navigation URL'),
      rowIndex: input.rowIndex as number,
      axis: input.axis as 1 | 2 | 3,
      selectedAxisIds: {
        axis1Id: string(selected.axis1Id, 'Timesheet axis 1 ID', {
          allowEmpty: true,
        }),
        axis2Id: string(selected.axis2Id, 'Timesheet axis 2 ID', {
          allowEmpty: true,
        }),
        axis3Id: string(selected.axis3Id, 'Timesheet axis 3 ID', {
          allowEmpty: true,
        }),
      },
    },
  };
}

export function validateDryRunRequest(value: unknown) {
  const input = record(value, 'Timesheet dry run');
  const deletions = input.deletions ?? [];
  if (!Array.isArray(deletions) || deletions.length > MAX_ENTRIES) {
    throw new Error('Timesheet dry-run deletions are invalid.');
  }
  if (
    !Array.isArray(input.entries) ||
    input.entries.length === 0 ||
    input.entries.length > MAX_ENTRIES
  ) {
    throw new Error('Timesheet dry-run entries are invalid.');
  }
  if (input.action !== 'save' && input.action !== 'submit-for-approval') {
    throw new Error('Timesheet dry-run action is invalid.');
  }
  return {
    provider: validateTimesheetProvider(input.provider),
    sheetId: string(input.sheetId, 'Timesheet sheet ID'),
    entries: input.entries.map(validateEntry),
    deletions: deletions.map(validateDeletion),
    action: input.action as TimesheetAction,
  };
}

function validateDeletion(value: unknown): TimesheetRowDeletion {
  const input = record(value, 'Timesheet deletion');
  if (!Number.isInteger(input.rowIndex) || (input.rowIndex as number) < 0) {
    throw new Error('Timesheet deletion row index is invalid.');
  }
  if (
    input.fraction !== 0 &&
    !ALLOWED_FRACTIONS.has(input.fraction as number)
  ) {
    throw new Error('Timesheet deletion fraction is invalid.');
  }
  return {
    date: isoDate(input.date, 'Timesheet deletion date'),
    rowIndex: input.rowIndex as number,
    fraction: input.fraction as TimesheetRowDeletion['fraction'],
    axis1Id: string(input.axis1Id, 'Timesheet axis 1 ID', { allowEmpty: true }),
    axis2Id: string(input.axis2Id, 'Timesheet axis 2 ID', { allowEmpty: true }),
    axis3Id: string(input.axis3Id, 'Timesheet axis 3 ID', { allowEmpty: true }),
    comment: string(input.comment, 'Timesheet comment', {
      allowEmpty: true,
      max: MAX_COMMENT_LENGTH,
    }),
  };
}

export function validateSaveRequest(value: unknown) {
  const input = record(value, 'Timesheet save');
  const deletions = input.deletions ?? [];
  if (!Array.isArray(deletions) || deletions.length > MAX_ENTRIES) {
    throw new Error('Timesheet save deletions are invalid.');
  }
  if (
    !Array.isArray(input.entries) ||
    (input.entries.length === 0 && deletions.length === 0) ||
    input.entries.length > MAX_ENTRIES
  ) {
    throw new Error('Timesheet save entries are invalid.');
  }
  if (input.action !== 'save' && input.action !== 'submit-for-approval') {
    throw new Error('Timesheet save action is invalid.');
  }
  return {
    provider: validateTimesheetProvider(input.provider),
    sheetId: string(input.sheetId, 'Timesheet sheet ID'),
    entries: input.entries.map(validateEntry),
    deletions: deletions.map(validateDeletion),
    action: input.action as TimesheetAction,
  };
}

export function validateDraftParams(value: unknown): TimesheetDraftParams {
  const input = record(value, 'Timesheet draft request');
  const type = input.type;
  if (
    type !== undefined &&
    !['task_prompted', 'pr_comment_added', 'pr_approved'].includes(type as string)
  ) {
    throw new Error('Timesheet activity type is invalid.');
  }
  return {
    provider: validateTimesheetProvider(input.provider),
    start: isoDateTime(input.start, 'Timesheet start date'),
    end: isoDateTime(input.end, 'Timesheet end date'),
    projectId:
      input.projectId === undefined
        ? undefined
        : string(input.projectId, 'Timesheet project ID'),
    type: type as TimesheetDraftParams['type'],
  };
}

export function validateSyncParams(value: unknown): TimesheetSyncParams {
  const input = record(value, 'Timesheet sync request');
  const draft = validateDraftParams(input);
  if (!Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES) {
    throw new Error('Timesheet sync entries are invalid.');
  }
  const entries = input.entries.map((value) => {
    const entry = record(value, 'Timesheet sync entry');
    const project = record(entry.project, 'Timesheet sync project');
    if (!Array.isArray(entry.sourceEventIds) || entry.sourceEventIds.length > 500) {
      throw new Error('Timesheet sync source events are invalid.');
    }
    if (
      entry.durationMinutes !== null &&
      (!Number.isInteger(entry.durationMinutes) ||
        (entry.durationMinutes as number) < 0 ||
        (entry.durationMinutes as number) > 1_440)
    ) {
      throw new Error('Timesheet sync duration is invalid.');
    }
    const workItem =
      entry.workItem === null
        ? null
        : (() => {
            const item = record(entry.workItem, 'Timesheet sync work item');
            return {
              id: string(item.id, 'Timesheet work item ID'),
              title:
                item.title === null
                  ? null
                  : string(item.title, 'Timesheet work item title', {
                      allowEmpty: true,
                    }),
              type:
                item.type === null
                  ? null
                  : string(item.type, 'Timesheet work item type', {
                      allowEmpty: true,
                    }),
            };
          })();
    return {
      id: string(entry.id, 'Timesheet entry ID'),
      provider: validateTimesheetProvider(entry.provider),
      date: isoDate(entry.date, 'Timesheet entry date'),
      project: {
        id:
          project.id === null
            ? null
            : string(project.id, 'Timesheet project ID'),
        name:
          project.name === null
            ? null
            : string(project.name, 'Timesheet project name', {
                allowEmpty: true,
              }),
      },
      role:
        entry.role === null
          ? null
          : string(entry.role, 'Timesheet role', { allowEmpty: true }),
      workItem,
      durationMinutes: entry.durationMinutes as number | null,
      description: string(entry.description, 'Timesheet description', {
        allowEmpty: true,
      }),
      sourceEventIds: entry.sourceEventIds.map((id) =>
        string(id, 'Timesheet source event ID'),
      ),
      metadata: record(entry.metadata, 'Timesheet metadata'),
      items: [],
    };
  });
  return { ...draft, entries };
}
