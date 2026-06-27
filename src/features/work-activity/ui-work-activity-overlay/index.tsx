import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { createPortal } from 'react-dom';
import FocusLock from 'react-focus-lock';

import {
  getWeekRange,
  groupWorkActivityEvents,
} from '@shared/work-activity-utils';

import { IconButton } from '@/common/ui/icon-button';
import { Modal } from '@/common/ui/modal';
import { WorkItemPreview } from '@/features/work-item/ui-work-item-preview';
import { WorkItemTypeIcon } from '@/features/work-item/ui-work-item-shared';

import { useCommands } from '@/common/hooks/use-commands';
import { useKeyboardLayer } from '@/common/context/keyboard-bindings';
import { useToastStore } from '@/stores/toasts';
import { useWorkActivity } from '@/hooks/use-work-activity';
import { useWorkItemById } from '@/hooks/use-work-items';

import type { WorkActivityEvent } from '@shared/work-activity-types';

const PROJECT_COLORS = [
  'oklch(0.78 0.16 205)',
  'oklch(0.78 0.16 155)',
  'oklch(0.78 0.16 75)',
  'oklch(0.74 0.19 295)',
  'oklch(0.74 0.18 25)',
  'oklch(0.8 0.14 245)',
  'oklch(0.82 0.13 330)',
  'oklch(0.76 0.14 180)',
  'oklch(0.84 0.12 110)',
  'oklch(0.7 0.16 20)',
  'oklch(0.78 0.15 285)',
  'oklch(0.8 0.13 230)',
];

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const shortDayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  timeZone: 'UTC',
});

const dayNumberFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  timeZone: 'UTC',
});

const weekLabelFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});

function shiftWeek(date: Date, direction: -1 | 1) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + direction * 7);
  return next;
}

function formatDay(date: string) {
  return dayFormatter.format(new Date(`${date}T00:00:00.000Z`));
}

function formatShortDay(date: string) {
  return shortDayFormatter.format(new Date(`${date}T00:00:00.000Z`));
}

function formatDayNumber(date: string) {
  return dayNumberFormatter.format(new Date(`${date}T00:00:00.000Z`));
}

function formatWeekLabel(range: { start: string; end: string }) {
  const start = new Date(range.start);
  const end = new Date(range.end);
  end.setUTCDate(end.getUTCDate() - 1);
  return `${weekLabelFormatter.format(start)} - ${weekLabelFormatter.format(end)}`;
}

function getWeekDays(range: { start: string }) {
  const start = new Date(range.start);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function formatEventType(type: WorkActivityEvent['type']) {
  if (type === 'task_prompted') return 'Task prompt';
  if (type === 'pr_comment_added') return 'PR comment';
  return 'PR approved';
}

function getWorkItemLabel(workItemId: string) {
  return workItemId === 'no-work-item'
    ? 'No work item'
    : `#${workItemId}`;
}

function getEventLabel(event: WorkActivityEvent) {
  if (event.taskTitle) return event.taskTitle;
  if (event.pullRequest?.title) return event.pullRequest.title;
  if (event.promptSnippet) return event.promptSnippet;
  return formatEventType(event.type);
}

function formatCompactMarkdown(events: WorkActivityEvent[]) {
  const grouped = groupWorkActivityEvents(events);
  if (grouped.length === 0) return 'No work activity recorded.';

  return grouped
    .map((day) => {
      const lines = [`## ${formatDay(day.date)}`];
      for (const project of day.projects) {
        lines.push(`- ${project.projectName ?? 'Unknown project'}`);
        for (const workItem of project.workItems) {
          const eventSummary = workItem.events
            .map((event) => formatEventType(event.type))
            .join(', ');
          lines.push(
            `  - ${getWorkItemLabel(workItem.workItemId)}: ${eventSummary}`,
          );
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function projectColor(projectId: string) {
  return PROJECT_COLORS[hashString(projectId) % PROJECT_COLORS.length];
}

function wholePercentages(rows: { id: string; count: number }[]) {
  const active = rows.filter((row) => row.count > 0);
  const total = active.reduce((sum, row) => sum + row.count, 0);
  if (total === 0) return new Map<string, number>();

  const units = active.map((row) => {
    const raw = (row.count / total) * 100;
    return {
      id: row.id,
      value: Math.floor(raw),
      remainder: raw - Math.floor(raw),
    };
  });
  let left = 100 - units.reduce((sum, unit) => sum + unit.value, 0);
  for (const unit of [...units].sort((a, b) => b.remainder - a.remainder)) {
    if (left <= 0) break;
    unit.value += 1;
    left -= 1;
  }

  return new Map(units.map((unit) => [unit.id, unit.value]));
}

function eventProjectId(event: WorkActivityEvent) {
  return event.projectId ?? 'unknown-project';
}

function eventProjectName(event: WorkActivityEvent) {
  return event.projectName ?? 'Unknown project';
}

function getEventWorkItemEntries(event: WorkActivityEvent) {
  if (event.workItems.length > 0) {
    return event.workItems.map((workItem) => ({
      key: [
        workItem.providerId,
        workItem.azureOrgId ?? 'unknown-org',
        workItem.azureProjectId,
        workItem.id,
      ].join(':'),
      id: workItem.id,
      providerId: workItem.providerId,
      title: workItem.title ?? null,
      type: workItem.workItemType ?? null,
      projectId: eventProjectId(event),
      projectName: eventProjectName(event),
    }));
  }

  return event.workItemIds.map((id) => ({
    key: [
      event.providerId ?? eventProjectId(event),
      event.azureOrgId ?? 'unknown-org',
      event.azureProjectId ?? 'unknown-azure-project',
      id,
    ].join(':'),
    id,
    providerId: event.providerId,
    title: null,
    type: null,
    projectId: eventProjectId(event),
    projectName: eventProjectName(event),
  }));
}

function formatWorkItemEventSummary(events: WorkActivityEvent[]) {
  const counts = new Map<WorkActivityEvent['type'], number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([type, count]) => {
      const label =
        count === 1
          ? formatEventType(type).toLowerCase()
          : type === 'pr_approved'
            ? 'PR approvals'
            : `${formatEventType(type).toLowerCase()}s`;
      return `${count} ${label}`;
    })
    .join(' · ');
}

function getWorkItemRecap(events: WorkActivityEvent[]) {
  const rows = new Map<
    string,
    {
      key: string;
      id: string;
      providerId: string | null;
      title: string | null;
      type: string | null;
      projectId: string;
      projectName: string;
      events: WorkActivityEvent[];
    }
  >();

  for (const event of events) {
    for (const entry of getEventWorkItemEntries(event)) {
      if (entry.id === 'no-work-item') continue;

      const current = rows.get(entry.key) ?? {
        ...entry,
        events: [],
      };
      current.events.push(event);
      rows.set(entry.key, current);
    }
  }

  const sorted = [...rows.values()].sort((left, right) => {
    const countDelta = right.events.length - left.events.length;
    if (countDelta !== 0) return countDelta;
    return left.id.localeCompare(right.id, undefined, { numeric: true });
  });
  const percentages = wholePercentages(
    sorted.map((row) => ({ id: row.key, count: row.events.length })),
  );

  return sorted.map((row) => ({
    ...row,
    pct: percentages.get(row.key) ?? 0,
    summary: row.title ?? (row.events[0] ? getEventLabel(row.events[0]) : 'Activity'),
    eventSummary: formatWorkItemEventSummary(row.events),
  }));
}

function getTimelineWorkItemEntries(event: WorkActivityEvent) {
  const entries = getEventWorkItemEntries(event);
  if (entries.length > 0) return entries;

  const taskKey = event.taskId ? `task:${event.taskId}` : 'no-work-item';

  return [
    {
      key: `${eventProjectId(event)}:${taskKey}`,
      id: taskKey,
      providerId: event.providerId,
      title: event.taskTitle ?? event.promptSnippet ?? null,
      type: null,
      projectId: eventProjectId(event),
      projectName: eventProjectName(event),
    },
  ];
}

function getTimelineLaneLabel(lane: { id: string; title: string; projectName: string }) {
  if (lane.id === 'no-work-item') return lane.projectName;
  if (lane.id.startsWith('task:')) return lane.title;
  return getWorkItemLabel(lane.id);
}

function getTimelineLaneKind(laneId: string) {
  if (laneId.startsWith('task:')) return 'Task';
  if (laneId === 'no-work-item') return 'Project';
  return getWorkItemLabel(laneId);
}

function eventMinute(event: WorkActivityEvent) {
  const date = new Date(event.occurredAt);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function formatHour(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:00`;
}

function getEventShape(type: WorkActivityEvent['type']) {
  if (type === 'pr_approved') return 'rounded-[5px]';
  if (type === 'pr_comment_added') return 'rounded-[3px] rotate-45';
  return 'rounded-full';
}

function clampTimelinePct(value: number) {
  return Math.min(96, Math.max(2, value));
}

function nearestEvent(
  laneEvents: WorkActivityEvent[],
  targetMinute: number,
) {
  return laneEvents.reduce((nearest, event) => {
    const nearestDistance = Math.abs(eventMinute(nearest) - targetMinute);
    const eventDistance = Math.abs(eventMinute(event) - targetMinute);
    return eventDistance < nearestDistance ? event : nearest;
  });
}

function getAzureProjectNameFromWorkItemUrl(url: string | null | undefined) {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const projectSegment =
      parsed.hostname.toLowerCase() === 'dev.azure.com'
        ? segments[1]
        : segments[0];
    return projectSegment ? decodeURIComponent(projectSegment) : undefined;
  } catch {
    return undefined;
  }
}

function getDateKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

function getTodayKey() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  )
    .toISOString()
    .slice(0, 10);
}

function formatDayMarkdown(day: string, events: WorkActivityEvent[]) {
  if (events.length === 0) return `${formatDay(day)}\nNo work activity recorded.`;

  const grouped = groupWorkActivityEvents(events);
  const lines = [`${formatDay(day)} - ${events.length} events`, ''];
  for (const project of grouped.flatMap((group) => group.projects)) {
    lines.push(project.projectName ?? 'Unknown project');
    for (const workItem of project.workItems) {
      lines.push(`- ${getWorkItemLabel(workItem.workItemId)}`);
      for (const event of workItem.events) {
        lines.push(
          `  - ${timeFormatter.format(new Date(event.occurredAt))} ${formatEventType(event.type)}: ${getEventLabel(event)}`,
        );
      }
    }
  }

  const workItems = getWorkItemRecap(events);
  if (workItems.length > 0) {
    lines.push('', 'Work items:');
    for (const workItem of workItems) {
      lines.push(
        `- ${getWorkItemLabel(workItem.id)} ${workItem.pct}% · ${workItem.eventSummary}`,
      );
    }
  }

  return lines.join('\n');
}

function Dot({ color, glow = false }: { color: string; glow?: boolean }) {
  return (
    <span
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{
        background: color,
        boxShadow: glow
          ? `0 0 0 3px color-mix(in oklch, ${color} 20%, transparent)`
          : undefined,
      }}
    />
  );
}

function Percentage({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  return (
    <div className={clsx('flex shrink-0 items-baseline gap-px', className)}>
      <span className="text-ink-0 text-base leading-none font-semibold tabular-nums tracking-[-0.02em]">
        {value}
      </span>
      <span className="text-ink-3 text-[10px] font-medium">%</span>
    </div>
  );
}

function WorkItemPercentage({ value }: { value: number }) {
  return (
    <div className="flex shrink-0 items-baseline gap-px">
      <span className="text-ink-0 text-sm leading-none font-semibold tabular-nums tracking-[-0.02em]">
        {value}
      </span>
      <span className="text-ink-3 text-[9px]">%</span>
    </div>
  );
}

export function WorkActivityOverlay({ onClose }: { onClose: () => void }) {
  const layer = useKeyboardLayer('dialog', { exclusive: true });
  const addToast = useToastStore((state) => state.addToast);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dayCopied, setDayCopied] = useState(false);
  const [rawCopied, setRawCopied] = useState(false);
  const [previewWorkItem, setPreviewWorkItem] = useState<{
    id: string;
    providerId: string | null;
  } | null>(null);
  const range = useMemo(
    () => getWeekRange(selectedDate.toISOString()),
    [selectedDate],
  );
  const weekDays = useMemo(() => getWeekDays(range), [range]);
  const { data: events = [], isLoading, isError } = useWorkActivity(range);
  const previewWorkItemId = previewWorkItem
    ? Number(previewWorkItem.id)
    : null;
  const {
    data: previewWorkItemDetails = null,
    isError: isPreviewWorkItemError,
    isLoading: isPreviewWorkItemLoading,
  } = useWorkItemById({
    providerId: previewWorkItem?.providerId ?? null,
    workItemId: Number.isFinite(previewWorkItemId) ? previewWorkItemId : null,
  });
  const previewAzureProjectName = getAzureProjectNameFromWorkItemUrl(
    previewWorkItemDetails?.url,
  );

  const sortedEvents = useMemo(
    () =>
      [...events].sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt),
      ),
    [events],
  );

  const daySummaries = useMemo(() => {
    const max = Math.max(
      1,
      ...weekDays.map(
        (day) =>
          sortedEvents.filter((event) => getDateKey(event.occurredAt) === day)
            .length,
      ),
    );

    return weekDays.map((day) => {
      const dayEvents = sortedEvents.filter(
        (event) => getDateKey(event.occurredAt) === day,
      );
      const projectCounts = new Map<string, { name: string; count: number }>();
      for (const event of dayEvents) {
        const id = eventProjectId(event);
        const current = projectCounts.get(id) ?? {
          name: eventProjectName(event),
          count: 0,
        };
        projectCounts.set(id, { ...current, count: current.count + 1 });
      }
      const rows = [...projectCounts.entries()]
        .map(([id, row]) => ({ id, ...row }))
        .sort((left, right) => right.count - left.count);
      const percentages = wholePercentages(rows);
      return {
        day,
        events: dayEvents,
        rows: rows.map((row) => ({
          ...row,
          pct: percentages.get(row.id) ?? 0,
        })),
        total: dayEvents.length,
        height: dayEvents.length
          ? Math.max(12, (dayEvents.length / max) * 100)
          : 0,
      };
    });
  }, [sortedEvents, weekDays]);

  const selectedSummary = useMemo(
    () => {
      if (selectedDay) {
        return daySummaries.find((summary) => summary.day === selectedDay);
      }

      const latestWithEvents = [...daySummaries]
        .reverse()
        .find((summary) => summary.total > 0);
      if (latestWithEvents) return latestWithEvents;

      const todayKey = getTodayKey();
      return (
        daySummaries.find((summary) => summary.day === todayKey) ??
        daySummaries.at(-1)
      );
    },
    [daySummaries, selectedDay],
  );

  const weekProjects = useMemo(() => {
    const projectCounts = new Map<string, { name: string; count: number }>();
    for (const event of sortedEvents) {
      const id = eventProjectId(event);
      const current = projectCounts.get(id) ?? {
        name: eventProjectName(event),
        count: 0,
      };
      projectCounts.set(id, { ...current, count: current.count + 1 });
    }
    const rows = [...projectCounts.entries()]
      .map(([id, row]) => ({ id, ...row }))
      .sort((left, right) => right.count - left.count);
    const percentages = wholePercentages(rows);
    return rows.map((row) => ({ ...row, pct: percentages.get(row.id) ?? 0 }));
  }, [sortedEvents]);

  const projectColors = useMemo(
    () =>
      new Map(
        weekProjects.map((project, index) => [
          project.id,
          PROJECT_COLORS[index % PROJECT_COLORS.length],
        ]),
      ),
    [weekProjects],
  );

  function getProjectColor(projectId: string) {
    return projectColors.get(projectId) ?? projectColor(projectId);
  }

  const selectedWorkItemRows = useMemo(
    () => getWorkItemRecap(selectedSummary?.events ?? []),
    [selectedSummary],
  );

  useCommands(
    'work-activity-overlay',
    [
      {
        shortcut: 'escape',
        label: 'Close Work Activity Overlay',
        handler: () => {
          if (previewWorkItem) return false;
          onClose();
          return true;
        },
        hideInCommandPalette: true,
      },
    ],
    { layer },
  );

  async function copyTimesheet() {
    try {
      await navigator.clipboard.writeText(formatCompactMarkdown(events));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
      addToast({ type: 'success', message: 'Timesheet copied to clipboard' });
    } catch {
      addToast({ type: 'error', message: 'Failed to copy timesheet' });
    }
  }

  async function copyRawJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(events, null, 2));
      setRawCopied(true);
      window.setTimeout(() => setRawCopied(false), 1400);
      addToast({ type: 'success', message: 'Raw activity JSON copied' });
    } catch {
      addToast({ type: 'error', message: 'Failed to copy raw JSON' });
    }
  }

  async function copySelectedDay() {
    if (!selectedSummary) return;

    try {
      await navigator.clipboard.writeText(
        formatDayMarkdown(selectedSummary.day, selectedSummary.events),
      );
      setDayCopied(true);
      window.setTimeout(() => setDayCopied(false), 1400);
      addToast({ type: 'success', message: 'Day activity copied' });
    } catch {
      addToast({ type: 'error', message: 'Failed to copy day activity' });
    }
  }

  return createPortal(
    <FocusLock disabled={!!previewWorkItem} returnFocus>
      <div
        className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 p-4 backdrop-blur-md sm:p-6"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="work-activity-title"
          className="border-glass-border text-ink-1 relative flex h-[min(720px,calc(100vh-48px))] w-full max-w-[1350px] flex-col overflow-hidden rounded-[20px] border bg-[linear-gradient(180deg,oklch(0.175_0.014_275),oklch(0.135_0.012_275))] shadow-[0_50px_120px_-36px_oklch(0_0_0/0.85),0_0_0_1px_oklch(0_0_0/0.4)]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_80%_at_100%_0%,oklch(0.78_0.16_205/0.07),transparent_55%)]" />

          <header className="border-line-soft relative flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3 sm:flex-nowrap sm:px-6 sm:py-4">
            <div className="border-status-azure/30 bg-status-azure-soft text-status-azure flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] border">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-[180px] flex-1">
              <div
                id="work-activity-title"
                className="text-ink-0 text-lg leading-tight font-semibold tracking-[-0.02em]"
              >
                Work Activity
              </div>
              <div className="text-ink-3 text-xs">
                Whole week at a glance - taller means more activity, color is
                split.
              </div>
            </div>

            <div className="border-line-soft flex items-center gap-1 rounded-[11px] border bg-black/25 p-1">
              <IconButton
                variant="ghost"
                size="sm"
                icon={<ChevronLeft />}
                tooltip="Previous week"
                onClick={() => {
                  setSelectedDay(null);
                  setSelectedDate((date) => shiftWeek(date, -1));
                }}
              />
              <div className="text-ink-1 min-w-32 px-2 text-center text-xs font-semibold tabular-nums">
                {formatWeekLabel(range)}
              </div>
              <IconButton
                variant="ghost"
                size="sm"
                icon={<ChevronRight />}
                tooltip="Next week"
                onClick={() => {
                  setSelectedDay(null);
                  setSelectedDate((date) => shiftWeek(date, 1));
                }}
              />
            </div>

            <button
              type="button"
              onClick={copyTimesheet}
              disabled={events.length === 0}
              className="bg-status-azure text-bg-0 inline-flex h-[38px] items-center gap-2 rounded-[10px] border border-status-azure px-4 text-[13px] font-semibold shadow-[0_8px_24px_-10px_var(--color-status-azure)] transition-colors hover:bg-status-azure/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy timesheet'}
            </button>
            <button
              type="button"
              onClick={copyRawJson}
              disabled={events.length === 0}
              className="border-line bg-glass-light text-ink-1 hover:bg-glass-medium inline-flex h-[38px] items-center gap-2 rounded-[10px] border px-4 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rawCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              JSON
            </button>
            <IconButton
              variant="ghost"
              size="sm"
              onClick={onClose}
              icon={<X />}
              tooltip="Close"
              className="border-line-soft bg-glass-light h-9 w-9 rounded-[10px] border"
            />
          </header>

          <div className="relative grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[330px_360px_minmax(360px,1fr)] lg:overflow-hidden">
            {isLoading || isError || events.length === 0 ? (
              <div className="col-span-full flex min-h-0 items-center justify-center p-6">
                <StatePanel
                  label={
                    isLoading
                      ? 'Loading work activity...'
                      : isError
                        ? 'Failed to load work activity.'
                        : 'No work activity recorded this week.'
                  }
                  tone={isError ? 'error' : 'muted'}
                />
              </div>
            ) : (
              <>
                <div className="border-line-soft flex min-w-0 flex-col border-b p-4 lg:border-r lg:border-b-0">
              <div className="grid min-h-[230px] flex-1 grid-cols-7 gap-1">
                {daySummaries.map((summary) => {
                  const selected = summary.day === selectedSummary?.day;
                  return (
                    <button
                      key={summary.day}
                      type="button"
                      aria-label={`Select ${formatDay(summary.day)} (${summary.total} event${summary.total === 1 ? '' : 's'})`}
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedDay(summary.day);
                        setDayCopied(false);
                      }}
                      className={clsx(
                        'group flex min-w-0 flex-col items-center gap-1.5 rounded-[12px] border px-0.5 py-2 transition-colors',
                        selected
                          ? 'border-line bg-white/[0.055]'
                          : 'border-transparent hover:bg-white/[0.025]',
                      )}
                    >
                      <div
                        className={clsx(
                          'font-mono text-[10px]',
                          summary.total
                            ? selected
                              ? 'text-ink-0'
                              : 'text-ink-2'
                            : 'text-ink-4',
                        )}
                      >
                        {summary.total || '-'}
                      </div>
                      <div
                        className={clsx(
                          'border-line-soft flex min-h-0 w-full max-w-8 flex-1 flex-col justify-end overflow-hidden rounded-lg border bg-white/[0.035]',
                          selected &&
                            'border-status-azure/40 shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-status-azure)_22%,transparent),0_10px_30px_-12px_var(--color-status-azure)]',
                        )}
                      >
                        {summary.total ? (
                          <div
                            className="flex w-full flex-col"
                            style={{ height: `${summary.height}%` }}
                          >
                            {summary.rows.map((row, index) => (
                              <div
                                key={row.id}
                                className="flex min-h-1 items-center justify-center"
                                style={{
                                  height: `${row.pct}%`,
                                  background: getProjectColor(row.id),
                                  borderTopLeftRadius: index === 0 ? 7 : 0,
                                  borderTopRightRadius: index === 0 ? 7 : 0,
                                }}
                                title={`${row.name} ${row.pct}%`}
                              >
                                {row.pct >= 22 ? (
                                  <span className="text-bg-0 text-[9px] font-bold">
                                    {row.pct}%
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-baseline gap-1">
                        <span
                          className={clsx(
                            'text-[11px] font-semibold',
                            summary.total
                              ? selected
                                ? 'text-ink-0'
                                : 'text-ink-1'
                              : 'text-ink-4',
                          )}
                        >
                          {formatShortDay(summary.day)}
                        </span>
                        <span className="text-ink-4 text-[10px]">
                          {formatDayNumber(summary.day)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="border-line-soft mt-3 flex flex-wrap gap-x-2.5 gap-y-1 border-t pt-3">
                {weekProjects.length === 0 ? (
                  <span className="text-ink-4 text-xs">No project activity</span>
                ) : (
                  weekProjects.map((project) => (
                    <div
                      key={project.id}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      <Dot color={getProjectColor(project.id)} />
                      <span className="text-ink-2 max-w-28 truncate text-[11px]">
                        {project.name}
                      </span>
                      <span className="text-ink-4 text-[10px] tabular-nums">
                        {project.pct}%
                      </span>
                      <span className="text-ink-4 text-[10px] tabular-nums">
                        {project.count} ev
                      </span>
                    </div>
                  ))
                )}
              </div>
                </div>

                <aside className="border-line-soft min-h-0 overflow-y-auto border-b bg-black/10 p-4 lg:border-r lg:border-b-0">
              <div className="border-line-soft border-b pb-4">
                <div className="text-status-azure text-[11px] font-bold tracking-[0.11em] uppercase">
                  {selectedSummary?.day === weekDays.at(-1)
                    ? 'Latest day'
                    : 'Selected'}
                </div>
                <div className="text-ink-0 mt-1 text-lg font-semibold tracking-[-0.02em]">
                  {selectedSummary ? formatDay(selectedSummary.day) : 'No day'}
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <span className="text-ink-3 text-xs">
                    {selectedSummary?.total ?? 0} events
                    {' · '}
                    {selectedSummary?.rows.length ?? 0} projects
                  </span>
                  <div className="flex-1" />
                  {(selectedSummary?.total ?? 0) > 0 ? (
                    <button
                      type="button"
                      onClick={copySelectedDay}
                      className="border-line bg-glass-light text-ink-1 hover:bg-glass-medium inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors"
                    >
                      {dayCopied ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                      {dayCopied ? 'Copied' : 'Copy day'}
                    </button>
                  ) : null}
                </div>
              </div>

                  {selectedSummary && selectedSummary.total > 0 ? (
                <div className="pt-3">
                  <div className="space-y-0.5">
                    {selectedSummary.rows.map((row) => (
                      <div
                        key={row.id}
                            className="border-line-soft flex items-center justify-between gap-2 border-b py-2"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <Dot color={getProjectColor(row.id)} glow />
                              <div className="min-w-0">
                                <div className="text-ink-0 truncate text-[13px] leading-tight font-semibold">
                                  {row.name}
                                </div>
                                <div className="text-ink-4 text-[10px] leading-tight">
                                  {row.count} event{row.count === 1 ? '' : 's'}
                                </div>
                          </div>
                        </div>
                        <Percentage value={row.pct} />
                      </div>
                    ))}
                  </div>

                  <div className="text-ink-3 mt-4 mb-1.5 text-[10px] font-semibold tracking-[0.09em] uppercase">
                    Work items · Azure DevOps
                  </div>
                  {selectedWorkItemRows.length > 0 ? (
                    <div className="flex flex-col">
                      {selectedWorkItemRows.map((workItem) => {
                        const isPreviewed =
                          previewWorkItem?.id === workItem.id &&
                          previewWorkItem.providerId === workItem.providerId;
                        const previewedTitle = isPreviewed
                          ? previewWorkItemDetails?.fields.title
                          : undefined;
                        const previewedType = isPreviewed
                          ? previewWorkItemDetails?.fields.workItemType
                          : undefined;
                        return (
                          <button
                            type="button"
                            key={workItem.key}
                            onClick={() => {
                              setPreviewWorkItem({
                                id: workItem.id,
                                providerId: workItem.providerId,
                              });
                            }}
                            disabled={!workItem.providerId}
                            title={
                              workItem.providerId
                                ? `Open work item ${getWorkItemLabel(workItem.id)}`
                                : `Work item ${getWorkItemLabel(workItem.id)}`
                            }
                            className="border-line-soft hover:bg-white/[0.025] flex w-full items-start gap-2 border-b px-1 py-1.5 text-left transition-colors last:border-b-0 disabled:cursor-default disabled:hover:bg-transparent"
                          >
                            <span className="mt-px flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                              <WorkItemTypeIcon
                                type={previewedType ?? workItem.type ?? ''}
                                size="md"
                              />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-baseline gap-1">
                                <span className="text-ink-3 shrink-0 font-mono text-[10px] tabular-nums">
                                  {getWorkItemLabel(workItem.id)}
                                </span>
                                <span className="text-ink-0 truncate text-xs font-semibold">
                                  {previewedTitle ?? workItem.summary}
                                </span>
                              </div>
                              <div className="text-ink-4 mt-px flex min-w-0 items-center gap-1 text-[10px] whitespace-nowrap">
                                <Dot
                                  color={getProjectColor(workItem.projectId)}
                                />
                                <span className="shrink-0 truncate">
                                  {workItem.projectName}
                                </span>
                                <span>·</span>
                                <span className="min-w-0 truncate">
                                  {workItem.eventSummary}
                                </span>
                              </div>
                            </div>
                            <WorkItemPercentage value={workItem.pct} />
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="border-line-soft text-ink-4 rounded-xl border border-dashed px-3 py-4 text-center text-xs">
                      No linked work items.
                    </div>
                  )}

                </div>
              ) : (
                <StatePanel label="Nothing tracked on this day." />
              )}
                </aside>

                <section className="flex min-h-0 flex-col overflow-hidden bg-black/10 p-4">
                  <div className="text-ink-3 mb-2 text-[10px] font-semibold tracking-[0.09em] uppercase">
                    Activity timeline
                  </div>
                  {selectedSummary && selectedSummary.total > 0 ? (
                    <ActivityTimeline
                      events={selectedSummary.events}
                      getProjectColor={getProjectColor}
                    />
                  ) : (
                    <StatePanel label="Nothing tracked on this day." />
                  )}
                </section>
              </>
            )}
          </div>

          <Modal
            isOpen={!!previewWorkItem}
            onClose={() => setPreviewWorkItem(null)}
            title={
              previewWorkItem ? (
                <span className="flex min-w-0 items-center gap-2">
                  <WorkItemTypeIcon
                    type={previewWorkItemDetails?.fields.workItemType ?? ''}
                  />
                  <span className="text-ink-2 shrink-0 text-sm font-medium">
                    {getWorkItemLabel(previewWorkItem.id)}
                  </span>
                  <span className="text-ink-1 min-w-0 truncate text-sm">
                    {previewWorkItemDetails?.fields.title ?? 'Work item'}
                  </span>
                </span>
              ) : undefined
            }
            size="xl"
            overlayClassName="z-[10000]"
            panelClassName="h-[85vh]"
            contentClassName="flex min-h-0 flex-1 overflow-hidden p-4"
          >
            {isPreviewWorkItemLoading ? (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <Loader2 className="text-ink-3 h-5 w-5 animate-spin" />
              </div>
            ) : isPreviewWorkItemError ? (
              <div className="text-status-fail flex min-h-0 flex-1 items-center justify-center text-sm">
                Failed to load work item.
              </div>
            ) : (
              <WorkItemPreview
                workItem={previewWorkItemDetails}
                providerId={previewWorkItem?.providerId ?? undefined}
                projectName={previewAzureProjectName}
                showCommentsAside
              />
            )}
          </Modal>
        </div>
      </div>
    </FocusLock>,
    document.body,
  );
}

function StatePanel({
  label,
  tone = 'muted',
}: {
  label: string;
  tone?: 'muted' | 'error';
}) {
  return (
    <div
      className={clsx(
        'mt-5 flex h-44 items-center justify-center rounded-xl border border-dashed text-sm',
        tone === 'error'
          ? 'border-status-fail/25 text-status-fail'
          : 'border-line-soft text-ink-4',
      )}
    >
      {label}
    </div>
  );
}

function ActivityTimeline({
  events,
  getProjectColor,
}: {
  events: WorkActivityEvent[];
  getProjectColor: (projectId: string) => string;
}) {
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timeline = useMemo(() => {
    if (events.length === 0) {
      return { start: 0, span: 60, hours: [0], lanes: [], columns: [] };
    }

    const lanes = new Map<
      string,
      {
        key: string;
        id: string;
        title: string;
        type: string | null;
        projectId: string;
        projectName: string;
        events: WorkActivityEvent[];
      }
    >();

    for (const event of events) {
      for (const entry of getTimelineWorkItemEntries(event)) {
        const lane = lanes.get(entry.key) ?? {
          key: entry.key,
          id: entry.id,
          title: entry.title ?? getEventLabel(event),
          type: entry.type,
          projectId: entry.projectId,
          projectName: entry.projectName,
          events: [],
        };
        lane.events.push(event);
        lanes.set(entry.key, lane);
      }
    }

    const minutes = events.map(eventMinute);
    const start = Math.max(0, Math.floor((Math.min(...minutes) - 30) / 60) * 60);
    const end = Math.min(24 * 60, Math.ceil((Math.max(...minutes) + 30) / 60) * 60);
    const span = Math.max(60, end - start);
    const hours = Array.from(
      { length: Math.floor((end - start) / 60) + 1 },
      (_, index) => start + index * 60,
    ).filter((minute) => minute <= end);

    const sortedLanes = [...lanes.values()]
      .map((lane) => {
        const laneEvents = [...lane.events].sort((left, right) =>
          left.occurredAt.localeCompare(right.occurredAt),
        );
        const laneStart = Math.min(...laneEvents.map(eventMinute));
        const laneEnd = Math.max(...laneEvents.map(eventMinute));

        return {
          ...lane,
          events: laneEvents,
          start: laneStart,
          end: laneEnd,
        };
      })
      .sort(
        (left, right) =>
          left.start - right.start || left.end - right.end || right.events.length - left.events.length,
      );

    const columns: { end: number; lanes: typeof sortedLanes }[] = [];
    for (const lane of sortedLanes) {
      const column = columns.find((candidate) => candidate.end + 12 <= lane.start);
      if (column) {
        column.lanes.push(lane);
        column.end = lane.end;
      } else {
        columns.push({ end: lane.end, lanes: [lane] });
      }
    }

    return {
      start,
      span,
      hours,
      lanes: sortedLanes,
      columns,
    };
  }, [events]);

  const activeLane = timeline.lanes.find((lane) =>
    lane.events.some((event) => event.id === activeEventId),
  );
  const activeEvent = activeLane?.events.find(
    (event) => event.id === activeEventId,
  );
  const activeEventTop = activeEvent
    ? ((eventMinute(activeEvent) - timeline.start) / timeline.span) * 100
    : 0;
  const tooltipWidth = 224;

  function setTooltipForMinute(minute: number) {
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return;

    const pct = (minute - timeline.start) / timeline.span;
    const scrollTop = chartRef.current?.scrollTop ?? 0;
    const scrollHeight = chartRef.current?.scrollHeight ?? rect.height;
    setTooltipPosition({
      left: Math.min(
        window.innerWidth - tooltipWidth - 12,
        Math.max(12, rect.left - tooltipWidth - 12),
      ),
      top: Math.min(
        window.innerHeight - 96,
        Math.max(96, rect.top + 32 - scrollTop + (scrollHeight - 96) * pct),
      ),
    });
  }

  useEffect(() => {
    if (!activeEventId) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (chartRef.current?.contains(target)) return;
      if (tooltipRef.current?.contains(target)) return;

      setActiveEventId(null);
      setTooltipPosition(null);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [activeEventId]);

  function selectLaneEvent(laneEvents: WorkActivityEvent[], targetMinute: number) {
    const nearest = nearestEvent(laneEvents, targetMinute);
    setActiveEventId(nearest.id);
    setTooltipForMinute(eventMinute(nearest));
  }

  if (events.length === 0) {
    return <StatePanel label="No activity events." />;
  }

  return (
    <div className="border-line-soft flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-black/15">
      <div
        ref={chartRef}
        className="relative min-h-0 flex-1 overflow-auto"
        onScroll={() => {
          if (!activeEventId) return;
          setActiveEventId(null);
          setTooltipPosition(null);
        }}
      >
        <div
          className="relative h-full min-h-[34rem] px-3 pt-7 pb-12"
          style={{ width: `max(100%, ${timeline.columns.length * 40 + 68}px)` }}
        >
          <div className="border-line-soft pointer-events-none sticky left-0 z-40 h-full w-14 border-r bg-bg-1" />
          {timeline.hours.map((hour) => (
            <div
              key={hour}
              className="border-line-soft pointer-events-none absolute right-3 left-14 border-t"
              style={{
                top: `calc(1.75rem + (100% - 4.75rem) * ${
                  (hour - timeline.start) / timeline.span
                })`,
              }}
            >
              <span className="text-ink-4 bg-bg-1 sticky left-2 z-50 -ml-12 inline-block w-10 -translate-y-1/2 rounded pr-1 text-right font-mono text-[9px]">
                {formatHour(hour)}
              </span>
            </div>
          ))}

          <div className="absolute top-7 right-3 bottom-12 left-[4.25rem] flex gap-1">
            {timeline.columns.map((column, columnIndex) => (
              <div key={columnIndex} className="relative min-w-0 flex-1">
                {column.lanes.map((lane) => {
            const color = getProjectColor(lane.projectId);
            const laneActive = lane.key === activeLane?.key;
            const top = clampTimelinePct(
              ((lane.start - timeline.start) / timeline.span) * 100,
            );
            const bottom = clampTimelinePct(
              ((lane.end - timeline.start) / timeline.span) * 100,
            );
            const height = Math.min(Math.max(3, bottom - top), 98 - top);

            return (
              <div key={lane.key} className="group/lane absolute inset-y-0 right-0 left-0">
                <div
                  className={clsx(
                    'absolute inset-y-0 left-0 right-0 rounded-lg transition-colors group-hover/lane:bg-white/[0.035]',
                    laneActive && 'bg-white/[0.045]',
                  )}
                  style={{ top: `${top}%`, height: `${height}%` }}
                />
                <div
                  className="absolute left-1/2 w-px -translate-x-1/2 rounded-full opacity-35 transition-[opacity,width,box-shadow] group-hover/lane:w-0.5 group-hover/lane:opacity-85 group-hover/lane:shadow-[0_0_10px_var(--lane-color)]"
                  style={{
                    top: `${top}%`,
                    height: `${height}%`,
                    background: color,
                    '--lane-color': color,
                  } as CSSProperties}
                />
                <button
                  type="button"
                  className="absolute right-0 left-0 z-20 cursor-pointer rounded-lg border-0 bg-transparent p-0 text-left"
                  style={{ top: `${top}%`, height: `${height}%` }}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const pct = Math.min(
                      1,
                      Math.max(0, (event.clientY - rect.top) / rect.height),
                    );
                    const targetMinute = lane.start + pct * Math.max(1, lane.end - lane.start);
                    selectLaneEvent(lane.events, targetMinute);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    const firstEvent = lane.events[0];
                    if (firstEvent) selectLaneEvent(lane.events, eventMinute(firstEvent));
                  }}
                  tabIndex={0}
                  aria-label={`Show ${getTimelineLaneLabel(lane)} activity`}
                />
                {lane.events.map((event) => {
                  const active = activeEvent?.id === event.id;
                  return (
                    <span
                      key={event.id}
                      aria-hidden="true"
                      className={clsx(
                        'pointer-events-none absolute left-1/2 z-30 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 border border-bg-1 transition-[box-shadow,transform] hover:scale-150 focus-visible:scale-150 focus-visible:outline-none',
                        getEventShape(event.type),
                        active && 'scale-150 shadow-[0_0_18px_var(--event-color)]',
                      )}
                      style={
                        {
                          top: `${clampTimelinePct(((eventMinute(event) - timeline.start) / timeline.span) * 100)}%`,
                          background: color,
                          '--event-color': color,
                        } as CSSProperties
                      }
                    />
                  );
                })}
              </div>
            );
                })}
              </div>
            ))}
          </div>

          {activeLane && activeEvent ? (
            <>
              <div
                  className="pointer-events-none absolute right-3 left-[4.25rem] z-20 h-px bg-[linear-gradient(90deg,transparent,oklch(1_0_0/0.2),transparent)]"
                  style={{
                    top: `calc(1.75rem + (100% - 4.75rem) * ${clampTimelinePct(activeEventTop) / 100})`,
                  }}
                />
            </>
          ) : null}
        </div>
      </div>
      {activeLane && activeEvent && tooltipPosition
        ? createPortal(
            <div
              ref={tooltipRef}
              className="border-line bg-bg-1/95 fixed z-[10001] max-h-[min(360px,calc(100vh-96px))] w-56 overflow-y-auto rounded-[13px] border p-3 shadow-[0_18px_44px_-14px_oklch(0_0_0/0.82)] backdrop-blur-sm"
              style={{
                left: tooltipPosition.left,
                top: tooltipPosition.top,
                transform: 'translateY(-50%)',
              }}
            >
              <div className="flex items-center gap-2">
                <span className="text-ink-3 shrink-0 font-mono text-[11px] tabular-nums">
                  {getTimelineLaneKind(activeLane.id)}
                </span>
                <span className="text-ink-4 ml-auto font-mono text-[10px]">
                  {activeLane.events.length} ev
                </span>
              </div>
              <div className="text-ink-0 mt-2 line-clamp-2 text-xs leading-tight font-semibold">
                {activeLane.title}
              </div>
              <div className="border-line-soft mt-2 space-y-0.5 border-t pt-2">
                {activeLane.events.map((event) => {
                  const active = event.id === activeEvent.id;
                  return (
                    <div
                      key={event.id}
                      className={clsx(
                        'flex items-baseline gap-2 rounded-md px-1.5 py-1',
                        active && 'bg-white/[0.06]',
                      )}
                    >
                      <span className="text-ink-4 w-10 shrink-0 font-mono text-[10px] tabular-nums">
                        {timeFormatter.format(new Date(event.occurredAt))}
                      </span>
                      <span
                        className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: getProjectColor(eventProjectId(event)) }}
                      />
                      <span
                        className={clsx(
                          'line-clamp-1 text-[11px] leading-snug',
                          active ? 'text-ink-0' : 'text-ink-2',
                        )}
                      >
                        {formatEventType(event.type)} · {getEventLabel(event)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
