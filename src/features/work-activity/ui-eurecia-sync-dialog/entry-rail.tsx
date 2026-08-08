import { AlertTriangle, Check, Pencil, Trash2, X } from 'lucide-react';
import clsx from 'clsx';

import type {
  TimesheetAxisIndex,
  TimesheetAxisLabels,
  TimesheetAxisOption,
  TimesheetDayFraction,
  TimesheetEntryInput,
  TimesheetRemoteRow,
} from '@shared/timesheet-types';

import { Combobox, type ComboboxOption } from '@/common/ui/combobox';

import {
  cleanEureciaAxisLabel,
  formatDayCount,
  formatFractionPercent,
  getAssignmentColor,
  getAssignmentKey,
  type InitializedTimesheetEntry,
  type TimesheetAssignment,
} from './utils';

const FRACTION_OPTIONS: TimesheetDayFraction[] = [0.25, 0.5, 0.75, 1];

export const COMMENT_MAX_LENGTH = 2000;

function axisKey(axis: TimesheetAxisIndex) {
  return `axis${axis}Id` as const;
}

function axisLabelOf(axisLabels: TimesheetAxisLabels, axis: TimesheetAxisIndex) {
  return axisLabels[`axis${axis}`] || `Axis ${axis}`;
}

function optionsWithCurrent(
  options: TimesheetAxisOption[],
  currentId: string,
  currentLabel: string,
) {
  if (!currentId || options.some(({ id }) => id === currentId)) return options;
  return [{ id: currentId, label: currentLabel || currentId }, ...options];
}

function mergeAxisOptions(
  primary: TimesheetAxisOption[],
  fallback: TimesheetAxisOption[],
) {
  const merged = new Map<string, TimesheetAxisOption>();
  for (const option of [...primary, ...fallback]) {
    if (option.id && !merged.has(option.id)) merged.set(option.id, option);
  }
  return [...merged.values()].sort((left, right) =>
    cleanEureciaAxisLabel(left.label).localeCompare(
      cleanEureciaAxisLabel(right.label),
    ),
  );
}

export function axisComboboxOptions(
  options: TimesheetAxisOption[],
): ComboboxOption[] {
  return options.map((option) => {
    const label = cleanEureciaAxisLabel(option.label);
    const raw = option.label.replace(/\s+/g, ' ').trim();
    return {
      value: option.id,
      label,
      ...(raw && raw !== label ? { description: raw } : {}),
    };
  });
}

function RailShell({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width,
}: {
  title: string;
  subtitle: string;
  onClose?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width: number;
}) {
  return (
    <aside
      className="border-line-soft bg-bg-1 flex shrink-0 flex-col border-l"
      style={{ width }}
    >
      <div className="border-line-soft flex items-center gap-2 border-b px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-ink-0 text-xs font-semibold">{title}</div>
          <div className="text-ink-3 truncate font-mono text-[10px]">
            {subtitle}
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            aria-label="Close entry details"
            onClick={onClose}
            className="text-ink-3 hover:text-ink-0 cursor-pointer rounded p-1 hover:bg-white/[0.06]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
        {children}
      </div>
      {footer}
    </aside>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-ink-3 font-mono text-[10px] tracking-[0.08em] uppercase">
          {label}
        </span>
        {hint ? <span className="text-ink-4 text-[10px]">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function EntryDetailRail({
  width,
  entry,
  index,
  dateLabel,
  maxFraction,
  axisLabels,
  axisOptions,
  fallbackAxisOptions,
  axisErrors,
  axisPending,
  labelFor,
  onChange,
  onRemove,
  onClose,
}: {
  width: number;
  entry: InitializedTimesheetEntry;
  index: number;
  dateLabel: string;
  maxFraction: number;
  axisLabels: TimesheetAxisLabels;
  axisOptions: Record<TimesheetAxisIndex, TimesheetAxisOption[]>;
  fallbackAxisOptions: Record<TimesheetAxisIndex, TimesheetAxisOption[]>;
  axisErrors: Record<string, string>;
  axisPending: boolean;
  labelFor: (axis: TimesheetAxisIndex, id: string) => string;
  onChange: (
    index: number,
    values: Partial<
      Pick<
        TimesheetEntryInput,
        'fraction' | 'comment' | 'axis1Id' | 'axis2Id' | 'axis3Id'
      >
    >,
  ) => void;
  onRemove: (index: number) => void;
  onClose: () => void;
}) {
  return (
    <RailShell
      width={width}
      title="Entry"
      subtitle={dateLabel}
      onClose={onClose}
    >
      <Field label="Duration">
        <div className="flex gap-1">
          {FRACTION_OPTIONS.map((fraction) => {
            const disabled = fraction > maxFraction;
            const active = fraction === entry.fraction;
            return (
              <button
                key={fraction}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                title={`${fraction} day`}
                onClick={() => onChange(index, { fraction })}
                className={clsx(
                  'flex-1 cursor-pointer rounded border py-1 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-35',
                  active
                    ? 'border-status-azure/60 bg-status-azure/15 text-status-azure'
                    : 'border-line-soft bg-bg-2 text-ink-2',
                )}
              >
                {formatFractionPercent(fraction)}
              </button>
            );
          })}
        </div>
      </Field>

      {([1, 2, 3] as const).map((axis) => {
        const key = axisKey(axis);
        const label = axisLabelOf(axisLabels, axis);
        const rowOptions = axisOptions[axis] ?? [];
        // Fall back to everything Eurecia returned elsewhere so the field is
        // never a dead end while this row's own lookup is missing.
        const merged = mergeAxisOptions(rowOptions, fallbackAxisOptions[axis] ?? []);
        const options = [
          { value: '', label: 'Unassigned' },
          ...axisComboboxOptions(
            optionsWithCurrent(merged, entry[key], labelFor(axis, entry[key])),
          ),
        ];
        const error = axisErrors[`${index}:${axis}`];
        const empty = options.length <= 1 && !entry[key];
        return (
          <Field
            key={axis}
            label={label}
            hint={empty && axisPending ? 'loading...' : undefined}
          >
            <Combobox
              value={entry[key]}
              options={options}
              onChange={(value) => onChange(index, { [key]: value })}
              disabled={empty && axisPending}
              label={label}
              placeholder={
                empty
                  ? axisPending
                    ? 'Loading from Eurecia...'
                    : 'No options returned'
                  : 'Unassigned'
              }
              searchPlaceholder={`Search ${label.toLowerCase()}...`}
              emptyLabel={`No ${label.toLowerCase()} options found`}
              size="xs"
              className="border-line bg-bg-2 text-ink-1 h-8 w-full justify-between rounded border px-2 text-[11px]"
              contentClassName="z-[10002]"
            />
            {error ? (
              <p className="text-status-fail text-[10px] leading-snug">{error}</p>
            ) : null}
          </Field>
        );
      })}

      <Field
        label="Comment"
        hint={`${entry.comment.length}/${COMMENT_MAX_LENGTH}`}
      >
        <textarea
          value={entry.comment}
          rows={5}
          placeholder="What you worked on..."
          onChange={(event) =>
            onChange(index, {
              comment: event.target.value.slice(0, COMMENT_MAX_LENGTH),
            })
          }
          className="border-line bg-bg-2 text-ink-1 w-full resize-none rounded border px-2 py-1.5 text-xs leading-relaxed"
        />
      </Field>

      <button
        type="button"
        onClick={() => onRemove(index)}
        className="text-status-fail hover:bg-status-fail/10 mt-auto inline-flex cursor-pointer items-center gap-2 self-start rounded px-2 py-1.5 text-xs"
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete entry
      </button>
    </RailShell>
  );
}

/** Read-only view of a row already saved in Eurecia. */
export function RemoteRowDetailRail({
  width,
  row,
  dateLabel,
  axisLabels,
  labelFor,
  markedForDeletion,
  canDelete,
  onEdit,
  onToggleDeletion,
  onClose,
}: {
  width: number;
  row: TimesheetRemoteRow;
  dateLabel: string;
  axisLabels: TimesheetAxisLabels;
  labelFor: (axis: TimesheetAxisIndex, id: string) => string;
  markedForDeletion: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onToggleDeletion: () => void;
  onClose: () => void;
}) {
  return (
    <RailShell
      width={width}
      title="Saved in Eurecia"
      subtitle={dateLabel}
      onClose={onClose}
    >
      <Field label="Duration">
        <div className="text-ink-0 font-mono text-sm">
          {formatFractionPercent(row.fraction)} · {formatDayCount(row.fraction)}
        </div>
      </Field>
      {([1, 2, 3] as const).map((axis) => {
        const id = row[axisKey(axis)];
        return (
          <Field key={axis} label={axisLabelOf(axisLabels, axis)}>
            <div
              className={clsx(
                'text-sm break-words',
                id ? 'text-ink-1' : 'text-ink-4',
              )}
            >
              {id ? labelFor(axis, id) : 'Unassigned'}
            </div>
          </Field>
        );
      })}
      <Field label="Comment">
        <div
          className={clsx(
            'text-sm break-words',
            row.comment ? 'text-ink-1' : 'text-ink-4',
          )}
        >
          {row.comment || 'No comment'}
        </div>
      </Field>
      <p className="text-ink-4 text-[11px] leading-snug">
        {markedForDeletion
          ? 'This row will be removed from Eurecia when you save.'
          : 'This row is already declared in Eurecia. Edit it in Eurecia itself.'}
      </p>
      {canDelete && !markedForDeletion ? (
        <button
          type="button"
          onClick={onEdit}
          className="border-line text-ink-1 hover:bg-white/[0.06] mt-auto inline-flex cursor-pointer items-center gap-2 self-start rounded border px-2 py-1.5 text-xs"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit as draft
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          onClick={onToggleDeletion}
          className={clsx(
            'inline-flex cursor-pointer items-center gap-2 self-start rounded px-2 py-1.5 text-xs',
            markedForDeletion
              ? 'text-ink-2 hover:bg-white/[0.06]'
              : 'text-status-fail hover:bg-status-fail/10',
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {markedForDeletion ? 'Keep this row' : 'Remove from Eurecia'}
        </button>
      ) : null}
    </RailShell>
  );
}

export function WeekSummaryRail({
  width,
  assignments,
  usage,
  issues,
  labelFor,
  totalFraction,
  targetFraction,
}: {
  width: number;
  assignments: TimesheetAssignment[];
  usage: Map<string, number>;
  issues: Array<{ date: string; label: string; detail: string }>;
  labelFor: (axis: 1 | 2 | 3, id: string) => string;
  totalFraction: number;
  targetFraction: number;
}) {
  const rows = assignments
    .map((assignment) => ({
      assignment,
      used: usage.get(getAssignmentKey(assignment)) ?? 0,
    }))
    .filter(({ used }) => used > 0)
    .sort((left, right) => right.used - left.used);

  return (
    <RailShell
      width={width}
      title="Week breakdown"
      subtitle={`${formatDayCount(totalFraction)} of ${formatDayCount(targetFraction)}`}
      footer={
        <div className="border-line-soft flex flex-col gap-1.5 border-t p-3">
          {issues.length === 0 ? (
            <div className="text-status-done flex items-center gap-2 text-xs">
              <Check className="h-3.5 w-3.5" /> Week complete
            </div>
          ) : (
            issues.map((issue) => (
              <div key={issue.date} className="flex items-center gap-2 text-xs">
                <AlertTriangle className="text-status-run h-3.5 w-3.5 shrink-0" />
                <span className="text-ink-2 flex-1 truncate">{issue.label}</span>
                <span className="text-status-run font-mono text-[10px]">
                  {issue.detail}
                </span>
              </div>
            ))
          )}
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="text-ink-4 text-[11px] leading-snug">
          Nothing declared for this week yet.
        </p>
      ) : null}
      {rows.map(({ assignment, used }) => {
        const color = getAssignmentColor(assignment.axis1Id);
        const percent = targetFraction > 0 ? Math.min(1, used / targetFraction) : 0;
        return (
          <div key={assignment.key}>
            <div className="mb-1 flex items-baseline gap-1.5">
              <span className="text-ink-1 flex-1 truncate text-xs">
                {labelFor(1, assignment.axis1Id)}
              </span>
              <span className="font-mono text-[11px]" style={{ color }}>
                {formatDayCount(used)}
              </span>
            </div>
            <div className="bg-bg-3 h-1.5 overflow-hidden rounded-full">
              <div
                className="h-full rounded-full"
                style={{ width: `${percent * 100}%`, background: color }}
              />
            </div>
          </div>
        );
      })}
    </RailShell>
  );
}
