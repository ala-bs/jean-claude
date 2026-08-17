import { describe, expect, it } from 'vitest';

import {
  validateAxisLookupRequest,
  validateDraftParams,
  validateDryRunRequest,
  validateSaveRequest,
  validateTimesheetProvider,
} from './timesheet-validation';

describe('timesheet IPC validation', () => {
  it('rejects unknown providers and non-object input', () => {
    expect(() => validateTimesheetProvider('other')).toThrow('provider');
    expect(() => validateDryRunRequest([])).toThrow('plain object');
  });

  it('validates dry-run dates, actions, fractions, and string bounds', () => {
    const base = {
      provider: 'eurecia',
      sheetId: 'sheet',
      action: 'save',
      entries: [
        {
          date: '2026-07-14',
          fraction: 0.25,
          axis1Id: 'one',
          axis2Id: 'two',
          axis3Id: 'three',
          comment: '',
          sourceDraftIds: [],
        },
      ],
    };
    expect(validateDryRunRequest(base)).toMatchObject(base);
    expect(() =>
      validateDryRunRequest({ ...base, entries: [] }),
    ).toThrow('entries');
    expect(() =>
      validateDryRunRequest({
        ...base,
        entries: [{ ...base.entries[0], date: '2026-02-31' }],
      }),
    ).toThrow('date');
    expect(() =>
      validateDryRunRequest({
        ...base,
        entries: [{ ...base.entries[0], fraction: 0.3 }],
      }),
    ).toThrow('fraction');
    expect(() => validateDryRunRequest({ ...base, action: 'post' })).toThrow(
      'action',
    );
  });

  it('validates axis, row, and selection strings', () => {
    expect(() =>
      validateAxisLookupRequest({
        provider: 'eurecia',
        sheetId: 'sheet',
        navigationUrl: 'https://tenant.example/eurecia/timesheet/Browse.do',
        rowIndex: 0,
        axis: 4,
        selectedAxisIds: { axis1Id: '', axis2Id: '', axis3Id: '' },
      }),
    ).toThrow('axis');
  });

  it('accepts canonical draft timestamps and rejects malformed ranges', () => {
    const request = {
      provider: 'eurecia',
      start: '2026-07-13T00:00:00.000Z',
      end: '2026-07-20T00:00:00.000Z',
    };

    expect(validateDraftParams(request)).toEqual(request);
    expect(
      validateDraftParams({
        ...request,
        start: '2026-07-13T02:00:00+02:00',
      }).start,
    ).toBe('2026-07-13T02:00:00+02:00');
    expect(() =>
      validateDraftParams({ ...request, start: '2026-07-13' }),
    ).toThrow('start date');
    expect(() =>
      validateDraftParams({ ...request, end: '2026-02-30T00:00:00.000Z' }),
    ).toThrow('end date');
  });

  it('validates save requests like dry runs', () => {
    const base = {
      provider: 'eurecia',
      sheetId: 'sheet',
      action: 'save',
      entries: [
        {
          date: '2026-07-14',
          fraction: 0.5,
          axis1Id: 'one',
          axis2Id: 'two',
          axis3Id: 'three',
          comment: '',
          sourceDraftIds: [],
        },
      ],
    };

    expect(validateSaveRequest(base)).toMatchObject(base);
    expect(() => validateSaveRequest({ ...base, entries: [] })).toThrow(
      'entries',
    );
    expect(() => validateSaveRequest({ ...base, action: 'delete' })).toThrow(
      'action',
    );
    // A submit needs no entries: the sheet may already be fully saved.
    expect(
      validateSaveRequest({
        ...base,
        entries: [],
        action: 'submit-for-approval',
      }),
    ).toMatchObject({ entries: [], action: 'submit-for-approval' });
    expect(() =>
      validateSaveRequest({
        ...base,
        entries: [{ ...base.entries[0], fraction: 0.3 }],
      }),
    ).toThrow('fraction');
  });

  it('validates staged row deletions', () => {
    const base = {
      provider: 'eurecia',
      sheetId: 'sheet',
      action: 'save',
      entries: [],
      deletions: [
        {
          date: '2026-08-04',
          rowIndex: 2,
          fraction: 0.25,
          axis1Id: 'one',
          axis2Id: 'two',
          axis3Id: 'three',
          comment: '',
        },
      ],
    };

    // Removing rows is a change on its own, so entries may be empty.
    expect(validateSaveRequest(base)).toMatchObject(base);
    expect(() =>
      validateSaveRequest({ ...base, entries: [], deletions: [] }),
    ).toThrow('entries');
    expect(() =>
      validateSaveRequest({
        ...base,
        deletions: [{ ...base.deletions[0], rowIndex: -1 }],
      }),
    ).toThrow('row index');
    expect(() =>
      validateSaveRequest({
        ...base,
        deletions: [{ ...base.deletions[0], fraction: 0.3 }],
      }),
    ).toThrow('fraction');
  });
});
