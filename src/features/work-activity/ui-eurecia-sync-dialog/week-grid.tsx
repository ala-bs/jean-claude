import { Copy, Lock, Plus, Trash2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

import type { TimesheetRemoteRow } from '@shared/timesheet-types';

import {
  formatDayCount,
  formatFractionPercent,
  fractionToSlots,
  getAssignmentColor,
  type InitializedTimesheetEntry,
  TIMESHEET_SLOT_FRACTION,
  TIMESHEET_SLOTS_PER_DAY,
} from './utils';

export type WeekGridEntry = { entry: InitializedTimesheetEntry; index: number };

// Shared empties keep day rows referentially stable when a day has no rows.
const EMPTY_REMOTE_ROWS: TimesheetRemoteRow[] = [];
const EMPTY_ENTRIES: WeekGridEntry[] = [];

type DragState = {
  fromDay: number;
  toDay: number;
  fromSlot: number;
  toSlot: number;
};

// Intl formatters are expensive to build; the grid re-renders on every drag
// move, so they are created once and the results memoized per date.
const DOW_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  timeZone: 'UTC',
});
const DOM_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  timeZone: 'UTC',
});
const MAX_CACHED_DAY_HEADERS = 400;
const dayHeaderCache = new Map<string, { dow: string; dom: string }>();

function formatDayHeader(date: string) {
  const cached = dayHeaderCache.get(date);
  if (cached) return cached;
  if (dayHeaderCache.size >= MAX_CACHED_DAY_HEADERS) dayHeaderCache.clear();
  const value = new Date(`${date}T00:00:00Z`);
  const header = {
    dow: DOW_FORMAT.format(value),
    dom: DOM_FORMAT.format(value),
  };
  dayHeaderCache.set(date, header);
  return header;
}

export function WeekGrid({
  dates,
  entriesByDate,
  remoteByDate,
  selectedIndex,
  selectedRemoteRowIndex,
  armedColor,
  editable,
  today,
  labelFor,
  onPaint,
  onSelect,
  onSelectRemote,
  onRemove,
  onFillDay,
  onClearDay,
  onSpreadDay,
}: {
  dates: string[];
  entriesByDate: Map<string, WeekGridEntry[]>;
  remoteByDate: Map<string, TimesheetRemoteRow[]>;
  selectedIndex: number | null;
  selectedRemoteRowIndex: number | null;
  armedColor: string | null;
  editable: boolean;
  today: string;
  labelFor: (axis: 1 | 2 | 3, id: string) => string;
  onPaint: (
    paints: Array<{ date: string; startSlot: number; slots: number }>,
  ) => void;
  onSelect: (index: number | null) => void;
  onSelectRemote: (row: TimesheetRemoteRow) => void;
  onRemove: (index: number) => void;
  onFillDay: (date: string) => void;
  onClearDay: (date: string) => void;
  onSpreadDay: (date: string) => void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const latest = useRef<{
    onPaint: typeof onPaint;
    dates: string[];
    editable: boolean;
    armedColor: string | null;
  }>({ onPaint, dates, editable, armedColor });

  useEffect(() => {
    latest.current = { onPaint, dates, editable, armedColor };
  });

  // Stable across renders so memoized day rows survive a drag move.
  const handleDragStart = useCallback((dayIndex: number, slot: number) => {
    if (!latest.current.editable || !latest.current.armedColor) return;
    const next = {
      fromDay: dayIndex,
      toDay: dayIndex,
      fromSlot: slot,
      toSlot: slot,
    };
    dragRef.current = next;
    setDrag(next);
  }, []);

  const handleDragOver = useCallback((dayIndex: number, slot: number) => {
    const active = dragRef.current;
    if (!active) return;
    if (active.toDay === dayIndex && active.toSlot === slot) return;
    const next = { ...active, toDay: dayIndex, toSlot: slot };
    dragRef.current = next;
    setDrag(next);
  }, []);

  useEffect(() => {
    const stop = () => {
      const active = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!active) return;
      const dayLo = Math.min(active.fromDay, active.toDay);
      const dayHi = Math.max(active.fromDay, active.toDay);
      const slotLo = Math.min(active.fromSlot, active.toSlot);
      const slotHi = Math.max(active.fromSlot, active.toSlot);
      // Painted range is absolute: it overwrites whatever already sits there.
      const paints: Array<{ date: string; startSlot: number; slots: number }> =
        [];
      for (let day = dayLo; day <= dayHi; day += 1) {
        const date = latest.current?.dates[day];
        if (!date) continue;
        paints.push({ date, startSlot: slotLo, slots: slotHi - slotLo + 1 });
      }
      if (paints.length > 0) latest.current?.onPaint(paints);
    };
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, []);

  return (
    <div
      className={clsx(
        'flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 py-3',
        drag && 'select-none',
      )}
    >
      {dates.map((date, dayIndex) => {
        // Only the days covered by the drag get new props, so untouched rows
        // stay memoized while the pointer moves.
        const inDrag =
          drag !== null &&
          dayIndex >= Math.min(drag.fromDay, drag.toDay) &&
          dayIndex <= Math.max(drag.fromDay, drag.toDay);
        return (
          <DayRow
            key={date}
            date={date}
            dayIndex={dayIndex}
            isToday={date === today}
            remoteRows={remoteByDate.get(date) ?? EMPTY_REMOTE_ROWS}
            entries={entriesByDate.get(date) ?? EMPTY_ENTRIES}
            selectedIndex={selectedIndex}
            selectedRemoteRowIndex={selectedRemoteRowIndex}
            armedColor={armedColor}
            editable={editable}
            dragging={drag !== null}
            dragSlotLo={inDrag ? Math.min(drag.fromSlot, drag.toSlot) : -1}
            dragSlotHi={inDrag ? Math.max(drag.fromSlot, drag.toSlot) : -1}
            labelFor={labelFor}
            onSelect={onSelect}
            onSelectRemote={onSelectRemote}
            onRemove={onRemove}
            onFillDay={onFillDay}
            onClearDay={onClearDay}
            onSpreadDay={onSpreadDay}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
          />
        );
      })}
    </div>
  );
}

const DayRow = memo(function DayRow({
  date,
  dayIndex,
  isToday,
  remoteRows,
  entries,
  selectedIndex,
  selectedRemoteRowIndex,
  armedColor,
  editable,
  dragging,
  dragSlotLo,
  dragSlotHi,
  labelFor,
  onSelect,
  onSelectRemote,
  onRemove,
  onFillDay,
  onClearDay,
  onSpreadDay,
  onDragStart,
  onDragOver,
}: {
  date: string;
  dayIndex: number;
  isToday: boolean;
  remoteRows: TimesheetRemoteRow[];
  entries: WeekGridEntry[];
  selectedIndex: number | null;
  selectedRemoteRowIndex: number | null;
  armedColor: string | null;
  editable: boolean;
  dragging: boolean;
  /** Painted slot range for this day, or -1/-1 when the drag misses it. */
  dragSlotLo: number;
  dragSlotHi: number;
  labelFor: (axis: 1 | 2 | 3, id: string) => string;
  onSelect: (index: number | null) => void;
  onSelectRemote: (row: TimesheetRemoteRow) => void;
  onRemove: (index: number) => void;
  onFillDay: (date: string) => void;
  onClearDay: (date: string) => void;
  onSpreadDay: (date: string) => void;
  onDragStart: (dayIndex: number, slot: number) => void;
  onDragOver: (dayIndex: number, slot: number) => void;
}) {
  const { dow, dom } = formatDayHeader(date);
  const remoteFraction = remoteRows.reduce(
    (total, row) => total + row.fraction,
    0,
  );
  const draftFraction = entries.reduce(
    (total, { entry }) => total + entry.fraction,
    0,
  );
  const total = remoteFraction + draftFraction;
  const used = fractionToSlots(total);
  const free = Math.max(0, TIMESHEET_SLOTS_PER_DAY - used);
  const complete = total >= 1;

  const inDrag = dragSlotLo >= 0;
  const dragSlots = inDrag ? dragSlotHi - dragSlotLo + 1 : 0;
  const painting = editable && Boolean(armedColor);

  return (
    <div
      className={clsx(
        'group/day flex min-w-0 items-stretch gap-2 rounded-lg border px-2 py-1.5',
        isToday ? 'border-status-azure/40 bg-status-azure/[0.04]' : 'border-line-soft',
      )}
    >
      {/* day label */}
      <div className="flex w-[92px] shrink-0 flex-col justify-center">
        <div className="flex items-baseline gap-1.5">
          <span
            className={clsx(
              'text-[13px] font-semibold',
              isToday ? 'text-status-azure' : 'text-ink-1',
            )}
          >
            {dow}
          </span>
          <span className="text-ink-3 font-mono text-[11px]">{dom}</span>
        </div>
        <span
          className={clsx(
            'font-mono text-[10px] font-semibold',
            complete
              ? 'text-status-done'
              : total > 0
                ? 'text-status-run'
                : 'text-ink-4',
          )}
        >
          {total > 0 ? formatDayCount(total) : 'empty'}
        </span>
      </div>

      {/* slots */}
      <div
        className="relative grid min-w-0 flex-1 gap-1"
        style={{
          gridTemplateColumns: `repeat(${TIMESHEET_SLOTS_PER_DAY}, minmax(0, 1fr))`,
        }}
        onClick={() => onSelect(null)}
      >
        {remoteRows.map((row) => (
          <RemoteBlock
            key={row.rowIndex}
            row={row}
            labelFor={labelFor}
            selected={selectedRemoteRowIndex === row.rowIndex}
            onSelect={() => onSelectRemote(row)}
          />
        ))}
        {entries.map(({ entry, index }) => (
          <EntryBlock
            key={`${entry.date}:${entry.rowIndex ?? index}:${index}`}
            entry={entry}
            selected={index === selectedIndex}
            // While painting, the capture layer covers the block, so the remove
            // button would render on hover and never receive the click.
            editable={editable && !painting}
            labelFor={labelFor}
            onSelect={() => onSelect(index)}
            onRemove={() => onRemove(index)}
          />
        ))}
        {Array.from({ length: free }).map((_, offset) => (
          <div
            key={used + offset}
            role="presentation"
            className="border-line grid min-h-[44px] place-items-center rounded-md border border-dashed bg-white/[0.02]"
          >
            <span className="text-ink-4 font-mono text-[10px] opacity-50">·</span>
          </div>
        ))}
        {/* Capture layer: painting overrides saved rows and drafts alike, so the
            whole day accepts a drag once an assignment is armed. */}
        {painting ? (
          <div
            className="absolute inset-0 grid gap-1"
            style={{
              gridTemplateColumns: `repeat(${TIMESHEET_SLOTS_PER_DAY}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: TIMESHEET_SLOTS_PER_DAY }).map((_, slot) => {
              const inRange = inDrag && slot >= dragSlotLo && slot <= dragSlotHi;
              const isFirstInRange = inRange && slot === dragSlotLo;
              return (
                <div
                  key={slot}
                  role="presentation"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onDragStart(dayIndex, slot);
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onMouseEnter={() => onDragOver(dayIndex, slot)}
                  className={clsx(
                    'group/slot grid cursor-copy place-items-center rounded-md transition-colors',
                    inRange
                      ? 'border border-solid'
                      : 'border border-transparent hover:bg-white/[0.06]',
                  )}
                  style={
                    inRange && armedColor
                      ? {
                          borderColor: armedColor,
                          background: `color-mix(in oklch, ${armedColor} 30%, transparent)`,
                        }
                      : undefined
                  }
                >
                  {isFirstInRange && armedColor ? (
                    <span
                      className="rounded bg-black/60 px-1 font-mono text-[11px] font-semibold"
                      style={{ color: armedColor }}
                    >
                      {formatFractionPercent(
                        dragSlots * TIMESHEET_SLOT_FRACTION,
                      )}
                    </span>
                  ) : !dragging ? (
                    <span
                      className="rounded bg-black/60 px-1 font-mono text-[10px] opacity-0 transition-opacity group-hover/slot:opacity-90"
                      style={{ color: armedColor ?? undefined }}
                    >
                      {formatFractionPercent(TIMESHEET_SLOT_FRACTION)}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* row actions */}
      {editable ? (
        <div className="flex w-14 shrink-0 items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/day:opacity-100">
          {free > 0 && armedColor ? (
            <IconAction
              label={`Fill ${date}`}
              onClick={() => onFillDay(date)}
              icon={<Plus className="h-3.5 w-3.5" />}
            />
          ) : null}
          {entries.length > 0 ? (
            <IconAction
              label={`Copy ${date} across the week`}
              onClick={() => onSpreadDay(date)}
              icon={<Copy className="h-3.5 w-3.5" />}
            />
          ) : null}
          {entries.length > 0 ? (
            <IconAction
              label={`Clear ${date}`}
              danger
              onClick={() => onClearDay(date)}
              icon={<Trash2 className="h-3.5 w-3.5" />}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

function IconAction({
  label,
  icon,
  onClick,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={clsx(
        'text-ink-3 cursor-pointer rounded p-1 hover:bg-white/[0.06]',
        danger ? 'hover:text-status-fail' : 'hover:text-ink-0',
      )}
    >
      {icon}
    </button>
  );
}

function RemoteBlock({
  row,
  labelFor,
  selected,
  onSelect,
}: {
  row: TimesheetRemoteRow;
  labelFor: (axis: 1 | 2 | 3, id: string) => string;
  selected: boolean;
  onSelect: () => void;
}) {
  const slots = Math.max(1, fractionToSlots(row.fraction));
  return (
    <button
      type="button"
      // The day row clears the selection on click, so this must not bubble.
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      aria-pressed={selected}
      className={clsx(
        'flex min-h-[44px] min-w-0 cursor-pointer flex-col justify-center overflow-hidden rounded-md border bg-black/30 px-2 py-1 text-left hover:bg-black/50',
        selected ? 'border-status-azure/70' : 'border-line',
      )}
      style={{ gridColumn: `span ${slots}` }}
      aria-label={`Saved Eurecia row, ${labelFor(1, row.axis1Id)}`}
    >
      <div className="flex items-center gap-1.5">
        <Lock className="text-ink-4 h-2.5 w-2.5 shrink-0" />
        <span className="text-ink-3 font-mono text-[11px] font-semibold">
          {formatFractionPercent(row.fraction)}
        </span>
        <span className="text-ink-2 truncate text-[11px]">
          {labelFor(1, row.axis1Id)}
        </span>
      </div>
      {row.comment ? (
        <p className="text-ink-4 truncate text-[10px]">{row.comment}</p>
      ) : null}
    </button>
  );
}

function EntryBlock({
  entry,
  selected,
  editable,
  labelFor,
  onSelect,
  onRemove,
}: {
  entry: InitializedTimesheetEntry;
  selected: boolean;
  editable: boolean;
  labelFor: (axis: 1 | 2 | 3, id: string) => string;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const slots = Math.max(1, fractionToSlots(entry.fraction));
  const color = getAssignmentColor(entry.axis1Id || 'unassigned');
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className="group/entry relative flex min-h-[44px] min-w-0 cursor-pointer flex-col justify-center overflow-hidden rounded-md py-1 pr-6 pl-2.5"
      style={{
        gridColumn: `span ${slots}`,
        background: `linear-gradient(90deg, color-mix(in oklch, ${color} 22%, var(--color-bg-1)), color-mix(in oklch, ${color} 13%, var(--color-bg-1)))`,
        boxShadow: selected
          ? `inset 0 0 0 1.5px ${color}, 0 4px 14px var(--color-scrim)`
          : `inset 0 0 0 1px color-mix(in oklch, ${color} 32%, transparent)`,
      }}
    >
      <span
        className="absolute inset-y-0 left-0 w-[2.5px]"
        style={{ background: color }}
      />
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="font-mono text-[11px] font-semibold" style={{ color }}>
          {formatFractionPercent(entry.fraction)}
        </span>
        <span className="text-ink-0 truncate text-[11px] font-medium">
          {entry.axis1Id ? labelFor(1, entry.axis1Id) : 'Unassigned'}
        </span>
        {entry.axis2Id ? (
          <span className="text-ink-3 truncate font-mono text-[10px]">
            {labelFor(2, entry.axis2Id)}
          </span>
        ) : null}
      </div>
      <p
        className={clsx(
          'truncate text-[10px]',
          entry.comment ? 'text-ink-2' : 'text-ink-4 italic',
        )}
      >
        {entry.comment || 'No comment'}
      </p>
      {editable ? (
        <button
          type="button"
          aria-label="Remove entry"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="border-line text-ink-2 hover:text-status-fail absolute top-1/2 right-1 z-10 hidden h-5 w-5 -translate-y-1/2 cursor-pointer place-items-center rounded border bg-black/60 group-hover/entry:grid"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      ) : null}
    </div>
  );
}
