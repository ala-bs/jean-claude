import { Copy, Eraser, X } from 'lucide-react';
import clsx from 'clsx';

import type { TimesheetAxisLabels } from '@shared/timesheet-types';

import { Combobox, type ComboboxOption } from '@/common/ui/combobox';

import {
  formatDayCount,
  getAssignmentColor,
  type TimesheetAssignment,
} from './utils';

export function AssignmentPalette({
  assignments,
  armedKey,
  onArm,
  usage,
  axisLabels,
  labelFor,
  disabled = false,
  onCopyPreviousWeek,
  onClearWeek,
  canCopyPreviousWeek,
  projectOptions,
  roleOptions,
  paletteAxisError,
  defaultRoleId,
  onDefaultRoleChange,
  onAddProject,
  onRemoveProject,
  removableProjectIds,
  width,
}: {
  assignments: TimesheetAssignment[];
  armedKey: string | null;
  onArm: (key: string | null) => void;
  usage: Map<string, number>;
  axisLabels: TimesheetAxisLabels;
  labelFor: (axis: 1 | 2 | 3, id: string) => string;
  disabled?: boolean;
  onCopyPreviousWeek: () => void;
  onClearWeek: () => void;
  canCopyPreviousWeek: boolean;
  projectOptions: ComboboxOption[];
  roleOptions: ComboboxOption[];
  paletteAxisError: string;
  defaultRoleId: string;
  onDefaultRoleChange: (axis3Id: string) => void;
  onAddProject: (axis1Id: string) => void;
  onRemoveProject: (axis1Id: string) => void;
  /** Projects added by hand and not used by any row, so removing them is safe. */
  removableProjectIds: string[];
  width: number | string;
}) {
  return (
    <div
      className="border-line-soft bg-bg-1 flex shrink-0 flex-col border-r"
      style={{ width }}
    >
      <div className="px-3 pt-3.5 pb-2">
        <div className="text-ink-3 font-mono text-[10px] tracking-[0.08em] uppercase">
          My assignments
        </div>
        <p className="text-ink-4 mt-1 text-[11px] leading-snug">
          Pick one, then paint your days on the right.
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-1.5">
        {assignments.length === 0 ? (
          <p className="text-ink-4 px-2 py-3 text-[11px] leading-snug">
            Nothing declared yet. Add a{' '}
            {(axisLabels.axis1 || 'project').toLowerCase()} below to start
            painting days.
          </p>
        ) : null}
        {assignments.map((assignment, index) => {
          const armed = assignment.key === armedKey;
          const color = getAssignmentColor(assignment.axis1Id);
          const used = usage.get(assignment.key) ?? 0;
          const removable = removableProjectIds.includes(assignment.axis1Id);
          return (
            <div key={assignment.key} className="group/assignment relative">
            <button
              type="button"
              disabled={disabled}
              aria-pressed={armed}
              onClick={() => onArm(armed ? null : assignment.key)}
              onContextMenu={
                removable
                  ? (event) => {
                      event.preventDefault();
                      onRemoveProject(assignment.axis1Id);
                    }
                  : undefined
              }
              className={clsx(
                'flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 text-left disabled:cursor-not-allowed disabled:opacity-40',
                armed ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]',
                // Reserve the hover-delete gutter so it never covers the counters.
                removable ? 'pr-8' : 'pr-2',
              )}
              style={armed ? { boxShadow: `inset 0 0 0 1px ${color}` } : undefined}
            >
              <span
                className="w-[3px] self-stretch rounded-sm"
                style={{ background: color, opacity: armed ? 1 : 0.5 }}
              />
              <span className="min-w-0 flex-1">
                <span className="text-ink-1 block truncate text-xs font-medium">
                  {labelFor(1, assignment.axis1Id)}
                </span>
                <span className="text-ink-4 block truncate font-mono text-[10px]">
                  {[
                    assignment.axis2Id && labelFor(2, assignment.axis2Id),
                    assignment.axis3Id && labelFor(3, assignment.axis3Id),
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'No sub-axis'}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className="block font-mono text-[10px]"
                  style={{ color: used > 0 ? color : undefined }}
                >
                  {used > 0 ? formatDayCount(used) : '—'}
                </span>
                {index < 9 ? (
                  <kbd className="border-line text-ink-4 mt-0.5 inline-block rounded border px-1 font-mono text-[9px]">
                    {index + 1}
                  </kbd>
                ) : null}
              </span>
            </button>
            {removable ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemoveProject(assignment.axis1Id)}
                aria-label={`Remove ${labelFor(1, assignment.axis1Id)}`}
                title="Remove project (or right-click)"
                className="text-ink-4 hover:text-status-fail absolute top-1/2 right-1 hidden -translate-y-1/2 cursor-pointer rounded p-1 hover:bg-white/[0.06] group-focus-within/assignment:block group-hover/assignment:block"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
            </div>
          );
        })}
      </div>
      <div className="border-line-soft border-t px-2 py-2">
        <div className="text-ink-3 mb-1 font-mono text-[10px] tracking-[0.08em] uppercase">
          Add {axisLabels.axis1 || 'Project'}
        </div>
        <Combobox
          value=""
          options={projectOptions}
          onChange={onAddProject}
          disabled={disabled || projectOptions.length === 0}
          label={`Add ${(axisLabels.axis1 || 'project').toLowerCase()}`}
          placeholder={
            projectOptions.length === 0
              ? 'No options from Eurecia'
              : 'Pick from Eurecia...'
          }
          searchPlaceholder="Search Eurecia projects..."
          emptyLabel="No matching Eurecia project"
          size="xs"
          className="border-line bg-bg-2 text-ink-1 h-8 w-full justify-between rounded border px-2 text-[11px]"
          contentClassName="z-[10002]"
        />
      </div>
      <div className="border-line-soft border-t px-2 py-2">
        <div className="text-ink-3 mb-1 font-mono text-[10px] tracking-[0.08em] uppercase">
          Default {axisLabels.axis3 || 'Role'}
        </div>
        <Combobox
          value={defaultRoleId}
          options={[{ value: '', label: 'None' }, ...roleOptions]}
          onChange={onDefaultRoleChange}
          disabled={roleOptions.length === 0}
          label={`Default ${(axisLabels.axis3 || 'role').toLowerCase()}`}
          placeholder={
            roleOptions.length === 0 ? 'No options from Eurecia' : 'None'
          }
          searchPlaceholder="Search..."
          emptyLabel="No matching option"
          size="xs"
          className="border-line bg-bg-2 text-ink-1 h-8 w-full justify-between rounded border px-2 text-[11px]"
          contentClassName="z-[10002]"
        />
        <p className="text-ink-4 mt-1 text-[10px] leading-snug">
          Applied to every newly painted entry.
        </p>
        {paletteAxisError ? (
          <p className="text-status-fail mt-1 text-[10px] leading-snug">
            {paletteAxisError}
          </p>
        ) : null}
      </div>
      <div className="border-line-soft flex flex-col gap-1 border-t p-2">
        <div className="text-ink-3 mb-0.5 font-mono text-[10px] tracking-[0.08em] uppercase">
          Shortcuts
        </div>
        <button
          type="button"
          disabled={disabled || !canCopyPreviousWeek}
          onClick={onCopyPreviousWeek}
          className="text-ink-2 hover:text-ink-0 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Copy className="h-3.5 w-3.5" /> Copy previous week
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onClearWeek}
          className="text-ink-2 hover:text-status-fail flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-white/[0.03] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Eraser className="h-3.5 w-3.5" /> Clear week
        </button>
      </div>
    </div>
  );
}
