import type {
  TimesheetAxisIndex,
  TimesheetAxisSelection,
  TimesheetDayFraction,
  TimesheetDraftItem,
  TimesheetEntryDraft,
  TimesheetEntryInput,
  TimesheetRemoteRow,
  TimesheetRowDeletion,
  TimesheetRowUpdate,
  TimesheetSheetSummary,
} from '@shared/timesheet-types';
import { isTimesheetRemoteRowOccupied } from '@shared/timesheet-utils';

export type InitializedTimesheetEntry = TimesheetEntryInput & {
  sourceDescription: string;
  items: TimesheetDraftItem[];
  /**
   * The saved row this entry rewrites, when it was derived from one. Such a
   * pair is sent as an in-place row update instead of a delete + re-add.
   */
  replaces?: TimesheetRowDeletion;
};

/**
 * Splits the staged ledger into what the write API takes. A staged deletion
 * whose row is rewritten by exactly one entry becomes an in-place update, which
 * keeps the row (and its Eurecia identity) instead of dropping and recreating it.
 */
export function splitStagedWrites({
  entries,
  deletions,
}: {
  entries: InitializedTimesheetEntry[];
  deletions: TimesheetRowDeletion[];
}) {
  const pending = [...deletions];
  const updates: TimesheetRowUpdate[] = [];
  const remaining: InitializedTimesheetEntry[] = [];
  for (const entry of entries) {
    const replaces = entry.replaces;
    const index = replaces
      ? pending.findIndex(
          (deletion) =>
            deletion.date === replaces.date &&
            deletion.rowIndex === replaces.rowIndex,
        )
      : -1;
    if (!replaces || index === -1) {
      remaining.push(entry);
      continue;
    }
    pending.splice(index, 1);
    updates.push({
      target: replaces,
      values: {
        fraction: entry.fraction,
        axis1Id: entry.axis1Id,
        axis2Id: entry.axis2Id,
        axis3Id: entry.axis3Id,
        comment: entry.comment,
      },
    });
  }
  return { entries: remaining, deletions: pending, updates };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CAPACITY_BREAKDOWN_DAYS = 366;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function getDefaultTimesheetFraction(
  entryCount: number,
): TimesheetDayFraction {
  return entryCount === 1 ? 1 : entryCount === 2 ? 0.5 : 0.25;
}

export function initializeTimesheetEntries(
  drafts: TimesheetEntryDraft[],
  remoteRows: TimesheetRemoteRow[],
): {
  entries: InitializedTimesheetEntry[];
  blockedDates: string[];
  fullyDeclaredDates: string[];
} {
  // Days Eurecia already declares in full leave nothing to paint: seeding them
  // would add unassignable rows and push the week over its capacity.
  const declaredCapacity = getOccupiedDailyCapacity(remoteRows);
  const isFullyDeclared = (date: string) =>
    (declaredCapacity.get(date)?.fraction ?? 0) >= 1;
  const fullyDeclaredDates = [
    ...new Set(drafts.filter(({ date }) => isFullyDeclared(date)).map(({ date }) => date)),
  ].sort();
  const indexedDrafts = drafts
    .filter(({ date }) => !isFullyDeclared(date))
    .map((draft, index) => ({ draft, index }))
    .sort(
      (left, right) =>
        left.draft.date.localeCompare(right.draft.date) ||
        left.index - right.index,
    );
  const counts = new Map<string, number>();
  for (const { draft } of indexedDrafts) {
    counts.set(draft.date, (counts.get(draft.date) ?? 0) + 1);
  }

  const blockedDates = [...counts]
    .filter(
      ([date, count]) =>
        count +
          remoteRows.filter(
            (row) =>
              row.date === date &&
              (row.occupied || isTimesheetRemoteRowOccupied(row)),
          ).length >
        4,
    )
    .map(([date]) => date);
  if (blockedDates.length > 0) {
    return { entries: [], blockedDates, fullyDeclaredDates };
  }

  const rowsByDate = new Map<string, TimesheetRemoteRow[]>();
  for (const row of remoteRows) {
    if (row.occupied || isTimesheetRemoteRowOccupied(row)) continue;
    const rows = rowsByDate.get(row.date) ?? [];
    rows.push(row);
    rowsByDate.set(row.date, rows);
  }
  for (const rows of rowsByDate.values()) {
    rows.sort((left, right) => left.rowIndex - right.rowIndex);
  }

  const nextRowByDate = new Map<string, number>();
  return {
    blockedDates,
    fullyDeclaredDates,
    entries: indexedDrafts.map(({ draft }) => {
      const count = counts.get(draft.date) ?? 1;
      const fraction = getDefaultTimesheetFraction(count);
      const rowOffset = nextRowByDate.get(draft.date) ?? 0;
      nextRowByDate.set(draft.date, rowOffset + 1);
      const row = rowsByDate.get(draft.date)?.[rowOffset];

      return {
        date: draft.date,
        ...(row ? { rowIndex: row.rowIndex } : {}),
        sourceDraftIds: [draft.id],
        sourceDescription: draft.description,
        items: draft.items,
        fraction,
        comment: '',
        axis1Id: row?.axis1Id ?? '',
        axis2Id: row?.axis2Id ?? '',
        axis3Id: row?.axis3Id ?? '',
      };
    }),
  };
}

export function getDailyFractionTotals(
  entries: Pick<TimesheetEntryInput, 'date' | 'fraction'>[],
  occupiedCapacity: Map<string, { count: number; fraction: number }> = new Map(),
) {
  const totals = new Map(
    [...occupiedCapacity].map(([date, capacity]) => [date, capacity.fraction]),
  );
  for (const entry of entries) {
    totals.set(entry.date, (totals.get(entry.date) ?? 0) + entry.fraction);
  }
  return totals;
}

export function getOccupiedDailyCapacity(remoteRows: TimesheetRemoteRow[]) {
  const capacity = new Map<string, { count: number; fraction: number }>();
  for (const row of remoteRows) {
    if (!row.occupied && !isTimesheetRemoteRowOccupied(row)) continue;
    const current = capacity.get(row.date) ?? { count: 0, fraction: 0 };
    capacity.set(row.date, {
      count: current.count + 1,
      fraction: current.fraction + row.fraction,
    });
  }
  return capacity;
}

export function getTimesheetCapacityBreakdown({
  start,
  end,
  remoteRows,
  entries,
  draftEntries,
  useDraftFallback,
}: {
  start: string;
  end: string;
  remoteRows: TimesheetRemoteRow[];
  entries: Pick<TimesheetEntryInput, 'date' | 'fraction'>[];
  draftEntries: Pick<TimesheetEntryDraft, 'date'>[];
  useDraftFallback: boolean;
}) {
  function parseIsoDate(value: string) {
    if (!ISO_DATE_PATTERN.test(value)) return undefined;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(timestamp)) return undefined;
    return new Date(timestamp).toISOString().slice(0, 10) === value
      ? timestamp
      : undefined;
  }

  const startTimestamp = parseIsoDate(start);
  const endTimestamp = parseIsoDate(end);
  if (
    startTimestamp === undefined ||
    endTimestamp === undefined ||
    endTimestamp < startTimestamp ||
    (endTimestamp - startTimestamp) / DAY_MS + 1 >
      MAX_CAPACITY_BREAKDOWN_DAYS
  ) {
    return [];
  }

  const existingCapacity = getOccupiedDailyCapacity(remoteRows);
  const draftCounts = new Map<string, number>();
  if (useDraftFallback) {
    for (const draft of draftEntries) {
      draftCounts.set(draft.date, (draftCounts.get(draft.date) ?? 0) + 1);
    }
  }
  const proposedCapacity = new Map<
    string,
    { count: number; fraction: number }
  >();
  const proposedEntries = useDraftFallback
    ? draftEntries.map(({ date }) => ({
        date,
        fraction: getDefaultTimesheetFraction(draftCounts.get(date) ?? 1),
      }))
    : entries;
  for (const entry of proposedEntries) {
    const current = proposedCapacity.get(entry.date) ?? {
      count: 0,
      fraction: 0,
    };
    proposedCapacity.set(entry.date, {
      count: current.count + 1,
      fraction: current.fraction + entry.fraction,
    });
  }

  const breakdown = [];
  for (
    let timestamp = startTimestamp;
    timestamp <= endTimestamp;
    timestamp += DAY_MS
  ) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    const existing = existingCapacity.get(date) ?? { count: 0, fraction: 0 };
    const proposed = proposedCapacity.get(date) ?? { count: 0, fraction: 0 };
    const totalRowCount = existing.count + proposed.count;
    const totalFraction = existing.fraction + proposed.fraction;
    breakdown.push({
      date,
      existingRowCount: existing.count,
      existingFraction: existing.fraction,
      proposedRowCount: proposed.count,
      proposedFraction: proposed.fraction,
      totalRowCount,
      totalFraction,
      rowOverflow: totalRowCount > 4,
      dayOverflow: totalFraction > 1,
    });
  }
  return breakdown;
}

export function resolveSelectedSheet(
  sheets: TimesheetSheetSummary[] | undefined,
  selectedSheetId: string | null,
) {
  if (!selectedSheetId) return undefined;
  return sheets?.find(({ id }) => id === selectedSheetId);
}

export function getSheetIdentity(
  sheet: Pick<TimesheetSheetSummary, 'id' | 'navigationUrl'> | undefined,
) {
  return sheet ? `${sheet.id}\u0000${sheet.navigationUrl}` : null;
}

export function isAxisLookupRequestCurrent({
  requestGeneration,
  currentGeneration,
  requestSheetIdentity,
  currentSheetIdentity,
  requestSequence,
  currentSequence,
}: {
  requestGeneration: number;
  currentGeneration: number;
  requestSheetIdentity: string;
  currentSheetIdentity: string | null;
  requestSequence: number;
  currentSequence: number | undefined;
}) {
  return (
    requestGeneration === currentGeneration &&
    requestSheetIdentity === currentSheetIdentity &&
    requestSequence === currentSequence
  );
}

export function getAxisLookupCacheKey({
  generation,
  rowIndex,
  axis,
  selectedAxisIds,
}: {
  generation: number;
  rowIndex: number;
  axis: TimesheetAxisIndex;
  selectedAxisIds: TimesheetAxisSelection;
}) {
  const parentIds =
    axis === 1
      ? []
      : axis === 2
        ? [selectedAxisIds.axis1Id]
        : [selectedAxisIds.axis1Id, selectedAxisIds.axis2Id];
  return JSON.stringify([generation, rowIndex, axis, ...parentIds]);
}

export function hasSheetIdentityChanged(
  previous: string | null,
  current: string | null,
) {
  return previous !== current;
}

/* ── week grid helpers ─────────────────────────────────────────────────── */

export const TIMESHEET_SLOT_FRACTION = 0.25;
export const TIMESHEET_SLOTS_PER_DAY = 4;

export function fractionToSlots(fraction: number) {
  return Math.round(fraction / TIMESHEET_SLOT_FRACTION);
}

export function slotsToFraction(slots: number): TimesheetDayFraction | undefined {
  const clamped = Math.min(TIMESHEET_SLOTS_PER_DAY, Math.round(slots));
  return ([0.25, 0.5, 0.75, 1] as const)[clamped - 1];
}

export function formatFractionPercent(fraction: number) {
  return `${Math.round(fraction * 100)}%`;
}

export type TimesheetSlotOccupant =
  | { kind: 'remote'; row: TimesheetRemoteRow; start: number; span: number }
  | { kind: 'entry'; index: number; start: number; span: number };

/**
 * Slot layout of one day, in the order the week grid packs its blocks: saved
 * rows first (by row index), then draft entries in array order. The renderer
 * and the paint logic must agree on this, so both read it from here.
 */
export function getDaySlotOccupants({
  remoteRows,
  entries,
}: {
  remoteRows: TimesheetRemoteRow[];
  entries: Array<{ index: number; fraction: number }>;
}): TimesheetSlotOccupant[] {
  const occupants: TimesheetSlotOccupant[] = [];
  let cursor = 0;
  for (const row of [...remoteRows].sort(
    (left, right) => left.rowIndex - right.rowIndex,
  )) {
    const span = Math.max(1, fractionToSlots(row.fraction));
    occupants.push({ kind: 'remote', row, start: cursor, span });
    cursor += span;
  }
  for (const { index, fraction } of entries) {
    const span = Math.max(1, fractionToSlots(fraction));
    occupants.push({ kind: 'entry', index, start: cursor, span });
    cursor += span;
  }
  return occupants;
}

export type TimesheetSlotPaintSource =
  | { kind: 'new' }
  | { kind: 'entry'; index: number }
  | { kind: 'remote'; row: TimesheetRemoteRow };

export type TimesheetSlotPaintPiece = {
  start: number;
  slots: number;
  source: TimesheetSlotPaintSource;
};

/**
 * Resolves what a day looks like after painting `slots` cells from `startSlot`,
 * overriding whatever sits there. An occupant that is only partly covered is
 * split into the part before and the part after the painted range, so a 0.5 row
 * can be overridden one cell at a time. Pieces come back ordered by slot, which
 * is the order the grid must render them in for the paint to land where the
 * user dropped it.
 */
export function planSlotPaint({
  occupants,
  startSlot,
  slots,
}: {
  occupants: TimesheetSlotOccupant[];
  startSlot: number;
  slots: number;
}): {
  pieces: TimesheetSlotPaintPiece[];
  deletedRows: TimesheetRemoteRow[];
  removedEntryIndices: number[];
} {
  const lo = startSlot;
  const hi = startSlot + slots - 1;
  const pieces: TimesheetSlotPaintPiece[] = [
    { start: lo, slots, source: { kind: 'new' } },
  ];
  const deletedRows: TimesheetRemoteRow[] = [];
  const removedEntryIndices: number[] = [];

  for (const occupant of occupants) {
    const occupantHi = occupant.start + occupant.span - 1;
    const source: TimesheetSlotPaintSource =
      occupant.kind === 'entry'
        ? { kind: 'entry', index: occupant.index }
        : { kind: 'remote', row: occupant.row };
    if (occupantHi < lo || occupant.start > hi) {
      // Untouched drafts still take part in the ordering; saved rows keep
      // rendering as saved rows and are not rebuilt.
      if (occupant.kind === 'entry') {
        pieces.push({
          start: occupant.start,
          slots: occupant.span,
          source,
        });
      }
      continue;
    }
    const leftSlots = Math.max(0, lo - occupant.start);
    const rightSlots = Math.max(0, occupantHi - hi);
    if (occupant.kind === 'remote') deletedRows.push(occupant.row);
    else if (leftSlots === 0 && rightSlots === 0) {
      removedEntryIndices.push(occupant.index);
    }
    if (leftSlots > 0) {
      pieces.push({ start: occupant.start, slots: leftSlots, source });
    }
    if (rightSlots > 0) {
      pieces.push({ start: hi + 1, slots: rightSlots, source });
    }
  }

  pieces.sort((left, right) => left.start - right.start);
  return { pieces, deletedRows, removedEntryIndices };
}

export function formatDayCount(fraction: number) {
  return `${String(Number(fraction.toFixed(2)))} d`;
}

export function enumerateDates(start: string, end: string) {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  if ((to - from) / DAY_MS + 1 > MAX_CAPACITY_BREAKDOWN_DAYS) return [];
  const dates: string[] = [];
  for (let time = from; time <= to; time += DAY_MS) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

function mondayOf(date: string) {
  const time = Date.parse(`${date}T00:00:00Z`);
  const weekday = (new Date(time).getUTCDay() + 6) % 7;
  return new Date(time - weekday * DAY_MS).toISOString().slice(0, 10);
}

export function isWeekend(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Splits a sheet range into Monday-anchored weeks. Weekend days are dropped
 * unless the caller flags them as carrying data.
 */
export function getWeekChunks({
  start,
  end,
  activeDates = [],
}: {
  start: string;
  end: string;
  activeDates?: string[];
}) {
  const active = new Set(activeDates);
  const weeks = new Map<string, string[]>();
  for (const date of enumerateDates(start, end)) {
    if (isWeekend(date) && !active.has(date)) continue;
    const key = mondayOf(date);
    weeks.set(key, [...(weeks.get(key) ?? []), date]);
  }
  return [...weeks]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([weekStart, dates]) => ({ weekStart, dates }));
}

/* ── assignment palette ────────────────────────────────────────────────── */

export type TimesheetAssignment = TimesheetAxisSelection & { key: string };

export function getAssignmentKey(selection: TimesheetAxisSelection) {
  return [selection.axis1Id, selection.axis2Id, selection.axis3Id].join('::');
}

export function getAssignmentHue(axis1Id: string) {
  let hash = 0;
  for (const char of axis1Id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

export function getAssignmentColor(axis1Id: string, alpha = 1) {
  return `oklch(0.78 0.16 ${getAssignmentHue(axis1Id)} / ${alpha})`;
}

export function deriveAssignments(
  sources: Array<TimesheetAxisSelection>,
): TimesheetAssignment[] {
  const assignments = new Map<string, TimesheetAssignment>();
  for (const source of sources) {
    if (!source.axis1Id) continue;
    const key = getAssignmentKey(source);
    if (assignments.has(key)) continue;
    assignments.set(key, {
      key,
      axis1Id: source.axis1Id,
      axis2Id: source.axis2Id,
      axis3Id: source.axis3Id,
    });
  }
  return [...assignments.values()];
}

export function cleanEureciaAxisLabel(value: string) {
  const compact = value.replaceAll("\u00a0", " ").replace(/\s+/g, ' ').trim();
  const withoutTree = compact
    .replace(/^[\s|-]+/, '')
    .replace(/^#+\s*/, '')
    .replace(/\s*#+$/, '')
    .replace(/^\*+\s*/, '')
    .replace(/\s*\*+$/, '')
    .replace(/^[\s|-]+/, '')
    .trim();
  return withoutTree || compact || 'Unassigned';
}

export function createConcurrencyLimiter(limit: number) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Concurrency limit must be a positive integer.');
  }
  let active = 0;
  const queue: Array<{
    start: () => void;
    reject: (reason: Error) => void;
  }> = [];

  const drain = () => {
    while (active < limit) {
      const queued = queue.shift();
      if (!queued) return;
      active += 1;
      queued.start();
    }
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          reject,
          start: () => {
            void Promise.resolve()
              .then(task)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              drain();
            });
          },
        });
        drain();
      });
    },
    clear(reason = new Error('Queued operation was cancelled.')) {
      for (const queued of queue.splice(0)) queued.reject(reason);
    },
  };
}
