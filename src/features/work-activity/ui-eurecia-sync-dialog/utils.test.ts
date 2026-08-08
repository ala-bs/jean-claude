import { describe, expect, it } from 'vitest';

import type {
  TimesheetEntryDraft,
  TimesheetRemoteRow,
} from '@shared/timesheet-types';

import {
  cleanEureciaAxisLabel,
  createConcurrencyLimiter,
  deriveAssignments,
  fractionToSlots,
  getAxisLookupCacheKey,
  getDailyFractionTotals,
  getDaySlotOccupants,
  getOccupiedDailyCapacity,
  getSheetIdentity,
  getTimesheetCapacityBreakdown,
  getWeekChunks,
  hasSheetIdentityChanged,
  initializeTimesheetEntries,
  isAxisLookupRequestCurrent,
  planSlotPaint,
  resolveSelectedSheet,
  slotsToFraction,
} from './utils';

function draft(id: string, date = '2026-07-13'): TimesheetEntryDraft {
  return {
    id,
    provider: 'eurecia',
    date,
    project: { id: null, name: null },
    role: null,
    workItem: null,
    durationMinutes: null,
    description: `Context ${id}`,
    sourceEventIds: [],
    metadata: {},
    items: [],
  };
}

function row(rowIndex: number, date = '2026-07-13'): TimesheetRemoteRow {
  return {
    rowIndex,
    date,
    fraction: 0,
    comment: '',
    axis1Id: '',
    axis2Id: '',
    axis3Id: '',
    occupied: false,
  };
}

describe('initializeTimesheetEntries', () => {
  it.each([
    [1, [1]],
    [2, [0.5, 0.5]],
    [3, [0.25, 0.25, 0.25]],
    [4, [0.25, 0.25, 0.25, 0.25]],
  ] as const)('uses fraction defaults for %i drafts', (count, expected) => {
    const result = initializeTimesheetEntries(
      Array.from({ length: count }, (_, index) => draft(String(index))),
      [],
    );

    expect(result.entries.map(({ fraction }) => fraction)).toEqual(expected);
  });

  it('blocks a date with more than four drafts', () => {
    const result = initializeTimesheetEntries(
      Array.from({ length: 5 }, (_, index) => draft(String(index))),
      [],
    );

    expect(result).toEqual({ entries: [], blockedDates: ['2026-07-13'] });
  });

  it('sorts dates stably', () => {
    const result = initializeTimesheetEntries(
      [draft('second', '2026-07-14'), draft('first-a'), draft('first-b')],
      [],
    );

    expect(result.entries.map(({ sourceDraftIds }) => sourceDraftIds[0])).toEqual([
      'first-a',
      'first-b',
      'second',
    ]);
  });

  it('matches ascending remote rows then leaves extra entries inferred', () => {
    const result = initializeTimesheetEntries(
      [draft('one'), draft('two'), draft('three')],
      [row(8), row(2)],
    );

    expect(result.entries.map(({ rowIndex }) => rowIndex)).toEqual([2, 8, undefined]);
    expect(result.entries[0]).toMatchObject({
      axis1Id: '',
      axis2Id: '',
      axis3Id: '',
      sourceDraftIds: ['one'],
      comment: '',
    });
    expect(result.entries[2]).toMatchObject({
      axis1Id: '',
      axis2Id: '',
      axis3Id: '',
      sourceDraftIds: ['three'],
      comment: '',
    });
  });

  it('skips occupied rows and infers new rows for matching dates', () => {
    const occupiedRows: TimesheetRemoteRow[] = [
      { ...row(1), axis1Id: 'assigned', occupied: true },
      { ...row(2), comment: 'existing', occupied: true },
      row(4),
    ];

    const result = initializeTimesheetEntries(
      [draft('one'), draft('two')],
      occupiedRows,
    );

    expect(result.entries.map(({ rowIndex }) => rowIndex)).toEqual([4, undefined]);
    expect(JSON.stringify(result)).not.toMatch(/assigned|existing/);
  });

  it('counts occupied rows toward four-entry date capacity', () => {
    const occupiedRows = [1, 2, 3].map((rowIndex) => ({
      ...row(rowIndex),
      occupied: true,
    }));

    expect(
      initializeTimesheetEntries(
        [draft('one'), draft('two')],
        occupiedRows,
      ).blockedDates,
    ).toEqual(['2026-07-13']);
  });
});

describe('getDailyFractionTotals', () => {
  it('sums entries by date', () => {
    expect(
      [...getDailyFractionTotals([
        { date: '2026-07-13', fraction: 0.25 },
        { date: '2026-07-13', fraction: 0.5 },
        { date: '2026-07-14', fraction: 1 },
      ])],
    ).toEqual([
      ['2026-07-13', 0.75],
      ['2026-07-14', 1],
    ]);
  });

  it('combines occupied fractions with proposed entry totals', () => {
    const occupiedCapacity = getOccupiedDailyCapacity([
      { ...row(1), fraction: 0.5, occupied: true },
      { ...row(2), comment: 'redacted remotely', occupied: true },
    ]);

    expect(occupiedCapacity.get('2026-07-13')).toEqual({
      count: 2,
      fraction: 0.5,
    });
    expect(
      getDailyFractionTotals(
        [{ date: '2026-07-13', fraction: 0.5 }],
        occupiedCapacity,
      ).get('2026-07-13'),
    ).toBe(1);
  });
});

describe('getTimesheetCapacityBreakdown', () => {
  it('uses edited entry allocations in normal state', () => {
    expect(
      getTimesheetCapacityBreakdown({
        start: '2026-07-13',
        end: '2026-07-13',
        remoteRows: [],
        entries: [
          { date: '2026-07-13', fraction: 0.75 },
          { date: '2026-07-13', fraction: 0.25 },
        ],
        draftEntries: [draft('ignored')],
        useDraftFallback: false,
      }),
    ).toEqual([
      {
        date: '2026-07-13',
        existingRowCount: 0,
        existingFraction: 0,
        proposedRowCount: 2,
        proposedFraction: 1,
        totalRowCount: 2,
        totalFraction: 1,
        rowOverflow: false,
        dayOverflow: false,
      },
    ]);
  });

  it('uses default allocations from drafts when blocked initialization has no entries', () => {
    const remoteRows = [1, 2].map((rowIndex) => ({
      ...row(rowIndex),
      fraction: 0.25 as const,
      occupied: true,
    }));

    expect(
      getTimesheetCapacityBreakdown({
        start: '2026-07-13',
        end: '2026-07-13',
        remoteRows,
        entries: [],
        draftEntries: [draft('one'), draft('two'), draft('three')],
        useDraftFallback: true,
      }),
    ).toEqual([
      {
        date: '2026-07-13',
        existingRowCount: 2,
        existingFraction: 0.5,
        proposedRowCount: 3,
        proposedFraction: 0.75,
        totalRowCount: 5,
        totalFraction: 1.25,
        rowOverflow: true,
        dayOverflow: true,
      },
    ]);
  });

  it('counts only occupied remote rows and includes zero dates across range', () => {
    const remoteRows = [
      row(1),
      { ...row(2), axis1Id: 'occupied without flag' },
      { ...row(3, '2026-07-15'), fraction: 0.5 as const, occupied: true },
    ];

    expect(
      getTimesheetCapacityBreakdown({
        start: '2026-07-13',
        end: '2026-07-15',
        remoteRows,
        entries: [],
        draftEntries: [],
        useDraftFallback: false,
      }),
    ).toEqual([
      expect.objectContaining({
        date: '2026-07-13',
        existingRowCount: 1,
        existingFraction: 0,
        totalRowCount: 1,
      }),
      expect.objectContaining({
        date: '2026-07-14',
        existingRowCount: 0,
        existingFraction: 0,
        proposedRowCount: 0,
        proposedFraction: 0,
        totalRowCount: 0,
        totalFraction: 0,
      }),
      expect.objectContaining({
        date: '2026-07-15',
        existingRowCount: 1,
        existingFraction: 0.5,
        totalRowCount: 1,
      }),
    ]);
  });

  it('flags row and day overflow independently', () => {
    const fiveQuarterRows = Array.from({ length: 5 }, (_, index) => ({
      ...row(index + 1),
      date: '2026-07-13',
      fraction: 0.25 as const,
      occupied: true,
    }));

    const result = getTimesheetCapacityBreakdown({
      start: '2026-07-13',
      end: '2026-07-14',
      remoteRows: fiveQuarterRows,
      entries: [
        { date: '2026-07-14', fraction: 1 },
        { date: '2026-07-14', fraction: 0.25 },
      ],
      draftEntries: [],
      useDraftFallback: false,
    });

    expect(result[0]).toMatchObject({ rowOverflow: true, dayOverflow: true });
    expect(result[1]).toMatchObject({ rowOverflow: false, dayOverflow: true });

    const rowOnly = getTimesheetCapacityBreakdown({
      start: '2026-07-13',
      end: '2026-07-13',
      remoteRows: fiveQuarterRows.map((remoteRow) => ({
        ...remoteRow,
        fraction: 0,
      })),
      entries: [],
      draftEntries: [],
      useDraftFallback: false,
    });
    expect(rowOnly[0]).toMatchObject({ rowOverflow: true, dayOverflow: false });
  });

  it('rejects invalid, reversed, and unreasonably large date bounds', () => {
    const params = {
      remoteRows: [],
      entries: [],
      draftEntries: [],
      useDraftFallback: false,
    };

    expect(
      getTimesheetCapacityBreakdown({
        ...params,
        start: '2026-02-30',
        end: '2026-03-01',
      }),
    ).toEqual([]);
    expect(
      getTimesheetCapacityBreakdown({
        ...params,
        start: '2026-07-14',
        end: '2026-07-13',
      }),
    ).toEqual([]);
    expect(
      getTimesheetCapacityBreakdown({
        ...params,
        start: '2025-01-01',
        end: '2026-01-02',
      }),
    ).toEqual([]);
  });
});

describe('sheet and lookup guards', () => {
  const sheet = {
    id: 'sheet-1',
    navigationUrl: 'https://tenant.example/sheet-1',
    description: 'Week 29',
    start: '2026-07-13',
    end: '2026-07-19',
    status: 'OPEN',
  };

  it('resolves selection only from current sheet data', () => {
    expect(resolveSelectedSheet([sheet], sheet.id)).toBe(sheet);
    expect(resolveSelectedSheet([], sheet.id)).toBeUndefined();
    expect(resolveSelectedSheet([sheet], null)).toBeUndefined();
  });

  it('rejects lookup responses from old generations and navigation identities', () => {
    const identity = getSheetIdentity(sheet)!;
    const current = {
      requestGeneration: 4,
      currentGeneration: 4,
      requestSheetIdentity: identity,
      currentSheetIdentity: identity,
      requestSequence: 2,
      currentSequence: 2,
    };

    expect(isAxisLookupRequestCurrent(current)).toBe(true);
    expect(
      isAxisLookupRequestCurrent({ ...current, currentGeneration: 5 }),
    ).toBe(false);
    expect(
      isAxisLookupRequestCurrent({
        ...current,
        currentSheetIdentity: `${sheet.id}\u0000https://tenant.example/new`,
      }),
    ).toBe(false);
    expect(
      isAxisLookupRequestCurrent({ ...current, currentSequence: undefined }),
    ).toBe(false);
  });

  it('keys axis lookups by generation, row, axis, and required parents', () => {
    const selection = { axis1Id: 'client', axis2Id: 'project', axis3Id: 'task' };
    const key = (axis: 1 | 2 | 3, selectedAxisIds = selection) =>
      getAxisLookupCacheKey({
        generation: 3,
        rowIndex: 8,
        axis,
        selectedAxisIds,
      });

    expect(key(1, { ...selection, axis1Id: 'other' })).toBe(key(1));
    expect(key(2, { ...selection, axis2Id: 'other' })).toBe(key(2));
    expect(key(2, { ...selection, axis1Id: 'other' })).not.toBe(key(2));
    expect(key(3, { ...selection, axis2Id: 'other' })).not.toBe(key(3));
  });

  it('detects removed and changed sheet identities', () => {
    const identity = getSheetIdentity(sheet);
    expect(hasSheetIdentityChanged(identity, identity)).toBe(false);
    expect(hasSheetIdentityChanged(identity, null)).toBe(true);
    expect(
      hasSheetIdentityChanged(
        identity,
        getSheetIdentity({ ...sheet, navigationUrl: `${sheet.navigationUrl}/new` }),
      ),
    ).toBe(true);
  });
});

describe('createConcurrencyLimiter', () => {
  it('runs no more than four tasks concurrently', async () => {
    const limiter = createConcurrencyLimiter(4);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 12 }, (_, index) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            releases.push(() => {
              active -= 1;
              resolve(index);
            });
          }),
      ),
    );

    await Promise.resolve();
    expect(active).toBe(4);
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await expect(Promise.all(tasks)).resolves.toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
    expect(peak).toBe(4);
  });

  it('releases its slot after a synchronous throw and continues the queue', async () => {
    const limiter = createConcurrencyLimiter(1);
    const failed = limiter.run(() => {
      throw new Error('sync failure');
    });
    const continued = limiter.run(async () => 'continued');

    await expect(failed).rejects.toThrow('sync failure');
    await expect(continued).resolves.toBe('continued');
  });

  it('rejects queued tasks on clear without starting them and remains reusable', async () => {
    const limiter = createConcurrencyLimiter(1);
    let releaseActive!: () => void;
    let queuedStarted = false;
    const active = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          releaseActive = resolve;
        }),
    );
    const queued = limiter.run(async () => {
      queuedStarted = true;
    });
    const queuedResult = expect(queued).rejects.toThrow('sheet changed');

    limiter.clear(new Error('sheet changed'));
    await queuedResult;
    expect(queuedStarted).toBe(false);
    releaseActive();
    await active;
    await expect(limiter.run(async () => 'next sheet')).resolves.toBe('next sheet');
  });

  it('keeps new tasks behind active slots after queued work is cleared', async () => {
    const limiter = createConcurrencyLimiter(4);
    let active = 0;
    let peak = 0;
    const oldReleases: Array<() => void> = [];
    const oldTasks = Array.from({ length: 4 }, () =>
      limiter.run(
        () =>
          new Promise<void>((resolve) => {
            active += 1;
            peak = Math.max(peak, active);
            oldReleases.push(() => {
              active -= 1;
              resolve();
            });
          }),
      ),
    );
    await Promise.resolve();

    const cancelled = limiter.run(async () => 'cancelled');
    const cancelledResult = expect(cancelled).rejects.toThrow('sheet reset');
    limiter.clear(new Error('sheet reset'));
    await cancelledResult;

    const nextTasks = Array.from({ length: 4 }, () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        active -= 1;
      }),
    );
    await Promise.resolve();
    expect(active).toBe(4);

    for (const release of oldReleases) release();
    await Promise.all([...oldTasks, ...nextTasks]);
    expect(peak).toBe(4);
  });
});

describe('week grid helpers', () => {
  it('splits a sheet range into Monday-anchored weeks without weekends', () => {
    expect(
      getWeekChunks({ start: '2026-07-27', end: '2026-08-04' }),
    ).toEqual([
      {
        weekStart: '2026-07-27',
        dates: [
          '2026-07-27',
          '2026-07-28',
          '2026-07-29',
          '2026-07-30',
          '2026-07-31',
        ],
      },
      { weekStart: '2026-08-03', dates: ['2026-08-03', '2026-08-04'] },
    ]);
  });

  it('keeps weekend days that already carry data', () => {
    const [week] = getWeekChunks({
      start: '2026-07-27',
      end: '2026-08-02',
      activeDates: ['2026-08-01'],
    });
    expect(week.dates).toContain('2026-08-01');
    expect(week.dates).not.toContain('2026-08-02');
  });

  it('converts slot counts into day fractions', () => {
    expect(slotsToFraction(0)).toBeUndefined();
    expect(slotsToFraction(2)).toBe(0.5);
    expect(slotsToFraction(9)).toBe(1);
    expect(fractionToSlots(0.75)).toBe(3);
  });

  it('derives one assignment per distinct axis combination', () => {
    const assignments = deriveAssignments([
      { axis1Id: 'p1', axis2Id: 'a1', axis3Id: '' },
      { axis1Id: 'p1', axis2Id: 'a1', axis3Id: '' },
      { axis1Id: 'p1', axis2Id: 'a2', axis3Id: '' },
      { axis1Id: '', axis2Id: '', axis3Id: '' },
    ]);
    expect(assignments.map(({ key }) => key)).toEqual([
      'p1::a1::',
      'p1::a2::',
    ]);
  });

  it('strips Eurecia tree decoration from axis labels', () => {
    expect(cleanEureciaAxisLabel('|---- Atlas Migration ###')).toBe(
      'Atlas Migration',
    );
    expect(cleanEureciaAxisLabel('   ')).toBe('Unassigned');
  });
});

describe('slot painting', () => {
  function saved(rowIndex: number, fraction: number) {
    return { ...row(rowIndex), fraction, occupied: true } as TimesheetRemoteRow;
  }

  it('packs saved rows before drafts, in slot order', () => {
    const occupants = getDaySlotOccupants({
      remoteRows: [saved(4, 0.25), saved(2, 0.5)],
      entries: [{ index: 7, fraction: 0.25 }],
    });

    expect(occupants).toEqual([
      { kind: 'remote', row: saved(2, 0.5), start: 0, span: 2 },
      { kind: 'remote', row: saved(4, 0.25), start: 2, span: 1 },
      { kind: 'entry', index: 7, start: 3, span: 1 },
    ]);
  });

  it('overrides the right cell of a saved half day and keeps the left one', () => {
    const savedRow = saved(2, 0.5);
    const plan = planSlotPaint({
      occupants: getDaySlotOccupants({ remoteRows: [savedRow], entries: [] }),
      startSlot: 1,
      slots: 1,
    });

    expect(plan.deletedRows).toEqual([savedRow]);
    expect(plan.removedEntryIndices).toEqual([]);
    // Kept part stays left of the paint, exactly where it was.
    expect(plan.pieces).toEqual([
      { start: 0, slots: 1, source: { kind: 'remote', row: savedRow } },
      { start: 1, slots: 1, source: { kind: 'new' } },
    ]);
  });

  it('overrides the left cell of a saved half day and pushes the kept part right', () => {
    const savedRow = saved(2, 0.5);
    const plan = planSlotPaint({
      occupants: getDaySlotOccupants({ remoteRows: [savedRow], entries: [] }),
      startSlot: 0,
      slots: 1,
    });

    // The new entry must come first, or the paint renders in the wrong cell.
    expect(plan.pieces).toEqual([
      { start: 0, slots: 1, source: { kind: 'new' } },
      { start: 1, slots: 1, source: { kind: 'remote', row: savedRow } },
    ]);
  });

  it('splits an occupant painted through its middle into both remainders', () => {
    const savedRow = saved(2, 0.75);
    const plan = planSlotPaint({
      occupants: getDaySlotOccupants({ remoteRows: [savedRow], entries: [] }),
      startSlot: 1,
      slots: 1,
    });

    expect(plan.pieces).toEqual([
      { start: 0, slots: 1, source: { kind: 'remote', row: savedRow } },
      { start: 1, slots: 1, source: { kind: 'new' } },
      { start: 2, slots: 1, source: { kind: 'remote', row: savedRow } },
    ]);
  });

  it('removes a draft that the paint fully covers and keeps untouched ones', () => {
    const plan = planSlotPaint({
      occupants: getDaySlotOccupants({
        remoteRows: [],
        entries: [
          { index: 0, fraction: 0.25 },
          { index: 1, fraction: 0.5 },
        ],
      }),
      startSlot: 1,
      slots: 2,
    });

    expect(plan.removedEntryIndices).toEqual([1]);
    expect(plan.deletedRows).toEqual([]);
    expect(plan.pieces).toEqual([
      { start: 0, slots: 1, source: { kind: 'entry', index: 0 } },
      { start: 1, slots: 2, source: { kind: 'new' } },
    ]);
  });

  it('shrinks a partly covered draft instead of removing it', () => {
    const plan = planSlotPaint({
      occupants: getDaySlotOccupants({
        remoteRows: [],
        entries: [{ index: 3, fraction: 1 }],
      }),
      startSlot: 2,
      slots: 2,
    });

    expect(plan.removedEntryIndices).toEqual([]);
    expect(plan.pieces).toEqual([
      { start: 0, slots: 2, source: { kind: 'entry', index: 3 } },
      { start: 2, slots: 2, source: { kind: 'new' } },
    ]);
  });
});
