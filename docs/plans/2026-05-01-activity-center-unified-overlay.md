# Activity Center — Unified Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge the background jobs overlay and notification center into a single "Activity Center" overlay with a unified header button, matching the design prototype from Claude Design.

**Architecture:** Replace the separate bell-icon notification bar + Jobs button in the header with a single centered `ActivityButton` pill. This pill shows live running-job state (spinning ring + ticker) or the latest notification status when idle. Clicking opens a unified `ActivityCenterOverlay` with four tabs: All, Running, Builds (notifications), Debug. The overlay type `'activity-center'` replaces both `'background-jobs'` and `'notification-center'`. The shortcut `cmd+j` toggles it (replaces both `cmd+j` and `cmd+shift+j`).

**Tech Stack:** React, Zustand, Tailwind CSS (oklch theme), lucide-react icons, existing app component patterns.

---

## Task 1: Add `'activity-center'` overlay type and remove old types

**Files:**
- Modify: `src/stores/overlays.ts`

**Step 1: Update the OverlayType union**

Replace `'background-jobs'` and `'notification-center'` with `'activity-center'`:

```typescript
export type OverlayType =
  | 'new-task'
  | 'command-palette'
  | 'project-switcher'
  | 'keyboard-help'
  | 'activity-center'
  | 'settings'
  | 'project-backlog'
  | 'pipelines'
  | 'running-commands';
```

**Step 2: Verify no TS errors**

Run: `pnpm ts-check`
Expected: Errors in files still referencing old overlay types — we fix those next.

**Step 3: Commit**

```
feat(overlays): replace background-jobs + notification-center with activity-center overlay type
```

---

## Task 2: Create the ActivityButton header component

**Files:**
- Create: `src/layout/ui-header/activity-button.tsx`

This is the unified pill that sits in the center of the header. When jobs are running: spinning ring + job title ticker + pulsing dot with count. When idle: latest notification status icon + title.

**Step 1: Create the component**

```tsx
import clsx from 'clsx';
import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Kbd } from '@/common/ui/kbd';
import {
  getRunningJobsCount,
  useBackgroundJobsStore,
  type BackgroundJob,
} from '@/stores/background-jobs';
import { useNotificationsStore } from '@/stores/notifications';
import { useOverlaysStore } from '@/stores/overlays';

function MiniSpinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={clsx('h-3 w-3 shrink-0 animate-spin', className)}
    />
  );
}

function StatusIcon({
  status,
}: {
  status: 'succeeded' | 'failed' | 'cancelled' | 'idle';
}) {
  if (status === 'failed') {
    return (
      <span className="bg-status-fail/20 text-status-fail inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full">
        <X className="h-2 w-2" strokeWidth={3} />
      </span>
    );
  }
  if (status === 'succeeded') {
    return (
      <span className="bg-status-done/20 text-status-done inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full">
        <Check className="h-2 w-2" strokeWidth={3} />
      </span>
    );
  }
  return null;
}

function getLatestNotificationStatus(type: string) {
  if (type.includes('failed')) return 'failed' as const;
  if (type.includes('cancelled')) return 'cancelled' as const;
  return 'succeeded' as const;
}

export function ActivityButton() {
  const isOpen = useOverlaysStore((s) => s.activeOverlay === 'activity-center');
  const toggle = useOverlaysStore((s) => s.toggle);

  const jobs = useBackgroundJobsStore((s) => s.jobs);
  const runningJobs = useMemo(
    () => jobs.filter((j) => j.status === 'running'),
    [jobs],
  );
  const runningCount = runningJobs.length;
  const isRunning = runningCount > 0;

  const notifications = useNotificationsStore((s) => s.notifications);
  const latestNotification = notifications[0] ?? null;

  // Cycle through running jobs every 3s
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning || runningCount < 2) return;
    const id = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(id);
  }, [isRunning, runningCount]);
  const currentJob = runningJobs[tick % Math.max(1, runningCount)];

  // Derive idle state from latest notification or latest finished job
  const latestFinishedJob = useMemo(
    () => jobs.find((j) => j.status !== 'running'),
    [jobs],
  );

  const idleTitle = latestNotification?.title ?? latestFinishedJob?.title ?? null;
  const idleStatus = latestNotification
    ? getLatestNotificationStatus(latestNotification.type)
    : latestFinishedJob
      ? (latestFinishedJob.status as 'succeeded' | 'failed')
      : 'idle';

  return (
    <button
      type="button"
      onClick={() => toggle('activity-center')}
      className={clsx(
        'inline-flex h-6 shrink-0 cursor-pointer items-stretch overflow-hidden rounded-[5px] border transition-all duration-100',
        isOpen
          ? 'border-glass-border-strong bg-bg-2'
          : 'border-glass-border bg-glass-subtle hover:bg-glass-light',
        isRunning && 'shadow-[inset_0_0_0_1px_oklch(0.72_0.20_295_/_0.22)]',
      )}
    >
      {/* LEFT — live state */}
      <div className="flex min-w-0 items-center gap-2 px-2.5">
        {isRunning ? (
          <>
            <MiniSpinner className="text-acc" />
            <span className="max-w-[220px] truncate text-[11.5px] font-medium tracking-tight text-white">
              {currentJob?.title ?? 'Working'}
            </span>
          </>
        ) : idleTitle ? (
          <>
            <StatusIcon status={idleStatus} />
            <span className="max-w-[240px] truncate text-[11.5px] text-white/70">
              {idleTitle}{' '}
              <span
                className={clsx(
                  idleStatus === 'failed'
                    ? 'text-status-fail'
                    : 'text-status-done',
                )}
              >
                {idleStatus === 'idle' ? '' : idleStatus}
              </span>
            </span>
          </>
        ) : (
          <span className="text-[11.5px] text-white/50">No activity</span>
        )}
      </div>

      {/* DIVIDER */}
      <div className="bg-glass-border my-1 w-px" />

      {/* RIGHT — count + label + shortcut */}
      <div
        className={clsx(
          'flex items-center gap-1.5 px-2',
          isRunning ? 'bg-acc/12 text-acc-ink' : 'text-ink-2',
        )}
      >
        {isRunning && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <span className="bg-acc h-[5px] w-[5px] animate-pulse rounded-full" />
            <span className="text-[11.5px] font-medium">{runningCount}</span>
          </span>
        )}
        <span className="text-[11.5px]">Activity</span>
        <Kbd shortcut="cmd+j" className="text-[9px]" />
      </div>
    </button>
  );
}
```

**Step 2: Commit**

```
feat(header): create ActivityButton component — unified pill for jobs + notifications
```

---

## Task 3: Create the ActivityCenterOverlay component

**Files:**
- Create: `src/features/activity-center/ui-activity-center-overlay/index.tsx`

This is the unified panel with tabs: All, Running, Builds (pipeline notifications), Debug. It combines data from the background-jobs store, notifications store, and debug-logs store into a single feed.

**Step 1: Create the overlay**

```tsx
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import clsx from 'clsx';
import {
  Check,
  Loader2,
  Search,
  Trash2,
  X,
  ExternalLink,
  Copy,
} from 'lucide-react';
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import FocusLock from 'react-focus-lock';
import { RemoveScroll } from 'react-remove-scroll';

import { useRegisterKeyboardBindings } from '@/common/context/keyboard-bindings';
import { Button } from '@/common/ui/button';
import { Kbd } from '@/common/ui/kbd';
import { useProjects } from '@/hooks/use-projects';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/time';
import {
  getRunningJobsCount,
  useBackgroundJobsStore,
  type BackgroundJob,
} from '@/stores/background-jobs';
import { useDebugLogsStore } from '@/stores/debug-logs';
import { useNotificationsStore } from '@/stores/notifications';
import { useToastStore } from '@/stores/toasts';
import type { AppNotification } from '@shared/notification-types';
import type { DebugLogEntry } from '@shared/debug-log-types';
import type { Project } from '@shared/types';

type ActivityTab = 'all' | 'running' | 'builds' | 'debug';

// ---- Unified activity item type ----
type ActivityItem =
  | { source: 'job'; job: BackgroundJob }
  | { source: 'notification'; notification: AppNotification };

const TABS: { id: ActivityTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'builds', label: 'Builds' },
  { id: 'debug', label: 'Debug' },
];

// ---- Status icon for rows ----
function RowStatusIcon({
  status,
}: {
  status: 'running' | 'succeeded' | 'failed';
}) {
  if (status === 'running') {
    return <Loader2 className="text-acc-ink h-3.5 w-3.5 shrink-0 animate-spin" />;
  }
  if (status === 'failed') {
    return (
      <span className="bg-status-fail/20 text-status-fail inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full">
        <X className="h-2.5 w-2.5" strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span className="bg-status-done/20 text-status-done inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full">
      <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
}

// ---- Project pill ----
function ProjectPill({ project }: { project?: Project }) {
  if (!project) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[3px] px-1.5 py-px font-mono text-[10px]"
      style={{
        background: `color-mix(in oklch, ${project.color} 12%, transparent)`,
        color: project.color,
      }}
    >
      <span
        className="h-1 w-1 rounded-sm"
        style={{ background: project.color }}
      />
      {project.name}
    </span>
  );
}

// ---- Section divider ----
function SectionDivider({
  label,
  count,
  action,
}: {
  label: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-white/[0.04] bg-black/[0.18] px-3.5 py-1.5">
      <span className="text-ink-3 text-[9.5px] font-semibold tracking-wider uppercase">
        {label}
      </span>
      {count != null && (
        <span className="text-ink-4 font-mono text-[10px]">{count}</span>
      )}
      <div className="flex-1" />
      {action}
    </div>
  );
}

// ---- Job row ----
function JobRow({
  job,
  projectMap,
  onAction,
}: {
  job: BackgroundJob;
  projectMap: Map<string, Project>;
  onAction: (action: string, job: BackgroundJob) => void;
}) {
  const running = job.status === 'running';
  const failed = job.status === 'failed';
  const project = job.projectId ? projectMap.get(job.projectId) : undefined;
  const ts = job.completedAt ?? job.createdAt;

  return (
    <div className="hover:bg-bg-3/60 grid cursor-pointer grid-cols-[18px_1fr_auto] gap-2.5 border-b border-white/[0.04] px-3.5 py-2.5 transition-colors">
      <div className="pt-0.5">
        <RowStatusIcon status={job.status} />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-medium tracking-tight text-white">
          {job.title}
        </div>
        {failed && job.errorMessage && (
          <div className="text-status-fail mt-0.5 truncate font-mono text-[11px]">
            {job.errorMessage}
          </div>
        )}
        {running && job.type === 'task-creation' && job.details.promptPreview && (
          <div className="text-acc-ink mt-0.5 truncate font-mono text-[11px]">
            {job.details.promptPreview}
          </div>
        )}
        {!running && !failed && 'promptPreview' in job.details && job.details.promptPreview && (
          <div className="text-ink-3 mt-1 truncate text-[11px] italic">
            "{job.details.promptPreview}"
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          {project && <ProjectPill project={project} />}
          {job.type === 'task-creation' && job.status === 'succeeded' && job.taskId && (
            <button
              type="button"
              className="text-acc-ink text-[10px] font-medium hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                onAction('open-task', job);
              }}
            >
              Open Task
            </button>
          )}
          {job.type === 'task-creation' && job.status === 'failed' && (
            <button
              type="button"
              className="text-ink-3 hover:text-ink-1 text-[10px] font-medium"
              onClick={(e) => {
                e.stopPropagation();
                onAction('retry', job);
              }}
            >
              Retry
            </button>
          )}
          {job.type === 'task-creation' && 'creationInput' in job.details && job.details.creationInput.prompt.trim() && (
            <button
              type="button"
              className="text-ink-4 hover:text-ink-2 inline-flex items-center gap-1 text-[10px]"
              onClick={(e) => {
                e.stopPropagation();
                onAction('copy-prompt', job);
              }}
            >
              <Copy className="h-2.5 w-2.5" /> Copy
            </button>
          )}
        </div>
      </div>
      <div className="text-ink-4 shrink-0 pt-0.5 font-mono text-[10.5px]">
        {formatRelativeTime(ts)}
      </div>
    </div>
  );
}

// ---- Notification row ----
function NotificationRow({
  notification,
  projectMap,
  onClick,
}: {
  notification: AppNotification;
  projectMap: Map<string, Project>;
  onClick: () => void;
}) {
  const failed = notification.type.includes('failed');
  const cancelled = notification.type.includes('cancelled');
  const status = failed ? 'failed' : 'succeeded';
  const project = notification.projectId
    ? projectMap.get(notification.projectId)
    : undefined;

  return (
    <div
      className="hover:bg-bg-3/60 grid cursor-pointer grid-cols-[18px_1fr_auto] gap-2.5 border-b border-white/[0.04] px-3.5 py-2.5 transition-colors"
      onClick={onClick}
    >
      <div className="pt-0.5">
        <RowStatusIcon status={status} />
      </div>
      <div className="min-w-0">
        <div
          className={clsx(
            'truncate text-[12.5px] font-medium tracking-tight',
            !notification.read ? 'text-white' : 'text-white/80',
          )}
        >
          {notification.title}
        </div>
        {notification.body && (
          <div className="text-ink-3 mt-0.5 truncate text-[11px]">
            {notification.body}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          {project && <ProjectPill project={project} />}
          {notification.sourceUrl && (
            <ExternalLink className="text-ink-4 h-2.5 w-2.5" />
          )}
        </div>
      </div>
      <div className="text-ink-4 shrink-0 pt-0.5 font-mono text-[10.5px]">
        {formatRelativeTime(notification.createdAt)}
      </div>
    </div>
  );
}

// ---- Debug log stream ----
function DebugStream({
  logs,
  filter,
}: {
  logs: DebugLogEntry[];
  filter: string;
}) {
  const filtered = filter
    ? logs.filter((l) =>
        `${l.namespace} ${l.message}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      )
    : logs;

  if (filtered.length === 0) {
    return (
      <div className="text-ink-3 py-12 text-center text-xs">
        {filter ? 'No matching logs.' : 'No debug logs yet.'}
      </div>
    );
  }

  return (
    <div className="py-1">
      {filtered.map((l) => (
        <div
          key={l.id}
          className="hover:bg-bg-1/30 grid grid-cols-[60px_110px_1fr] gap-2.5 border-b border-white/[0.03] px-3.5 py-1 font-mono text-[10.5px] leading-relaxed"
        >
          <span className="text-ink-4">
            {new Date(l.timestamp).toLocaleTimeString('en-US', {
              hour12: false,
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
          <span className="text-acc-ink truncate">{l.namespace}</span>
          <span
            className={clsx(
              'truncate',
              l.level === 'error'
                ? 'text-status-fail'
                : l.level === 'warn'
                  ? 'text-status-run'
                  : 'text-ink-1',
            )}
          >
            {l.message}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- Main overlay ----
export function ActivityCenterOverlay({
  onClose,
  initialTab = 'all',
}: {
  onClose: () => void;
  initialTab?: ActivityTab;
}) {
  const [tab, setTab] = useState<ActivityTab>(initialTab);
  const [filter, setFilter] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const jobs = useBackgroundJobsStore((s) => s.jobs);
  const clearFinished = useBackgroundJobsStore((s) => s.clearFinished);
  const markJobRunning = useBackgroundJobsStore((s) => s.markJobRunning);
  const markJobSucceeded = useBackgroundJobsStore((s) => s.markJobSucceeded);
  const markJobFailed = useBackgroundJobsStore((s) => s.markJobFailed);

  const notifications = useNotificationsStore((s) => s.notifications);
  const markAsRead = useNotificationsStore((s) => s.markAsRead);
  const markAllAsRead = useNotificationsStore((s) => s.markAllAsRead);

  const debugLogs = useDebugLogsStore((s) => s.logs);
  const clearLogs = useDebugLogsStore((s) => s.clear);

  const { data: projects } = useProjects();
  const addToast = useToastStore((s) => s.addToast);

  const projectMap = useMemo(() => {
    const map = new Map<string, Project>();
    if (projects) {
      for (const p of projects) map.set(p.id, p);
    }
    return map;
  }, [projects]);

  const runningJobs = useMemo(
    () => jobs.filter((j) => j.status === 'running'),
    [jobs],
  );
  const finishedJobs = useMemo(
    () => jobs.filter((j) => j.status !== 'running'),
    [jobs],
  );

  // Tab counts
  const tabCounts = useMemo(
    () => ({
      all: jobs.length + notifications.length,
      running: runningJobs.length,
      builds: notifications.length,
      debug: debugLogs.length,
    }),
    [jobs.length, notifications.length, runningJobs.length, debugLogs.length],
  );

  useRegisterKeyboardBindings('activity-center-overlay', {
    escape: () => {
      onClose();
      return true;
    },
  });

  const handleJobAction = useCallback(
    async (action: string, job: BackgroundJob) => {
      if (action === 'open-task' && job.projectId && job.taskId) {
        navigate({
          to: '/projects/$projectId/tasks/$taskId',
          params: { projectId: job.projectId, taskId: job.taskId },
        });
        onClose();
      } else if (action === 'retry' && job.type === 'task-creation') {
        markJobRunning(job.id);
        try {
          const task = await api.tasks.createWithWorktree({
            ...job.details.creationInput,
            updatedAt: new Date().toISOString(),
          });
          markJobSucceeded(job.id, {
            taskId: task.id,
            projectId: task.projectId,
          });
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
        } catch (error) {
          markJobFailed(
            job.id,
            error instanceof Error ? error.message : 'Failed to create task',
          );
        }
      } else if (action === 'copy-prompt' && job.type === 'task-creation') {
        try {
          await navigator.clipboard.writeText(
            job.details.creationInput.prompt,
          );
          addToast({ type: 'success', message: 'Prompt copied to clipboard' });
        } catch {
          addToast({ type: 'error', message: 'Failed to copy prompt' });
        }
      }
    },
    [
      navigate,
      onClose,
      markJobRunning,
      markJobSucceeded,
      markJobFailed,
      queryClient,
      addToast,
    ],
  );

  const handleNotificationClick = useCallback(
    (notification: AppNotification) => {
      if (!notification.read) {
        markAsRead(notification.id);
      }
      if (notification.sourceUrl) {
        window.open(notification.sourceUrl, '_blank');
      }
    },
    [markAsRead],
  );

  const handleClear = useCallback(() => {
    if (tab === 'debug') {
      clearLogs();
    } else {
      clearFinished();
      markAllAsRead();
    }
  }, [tab, clearLogs, clearFinished, markAllAsRead]);

  return createPortal(
    <FocusLock returnFocus>
      <RemoveScroll>
        <div
          className="fixed inset-0 z-50 flex items-start justify-center pt-12"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          onClick={onClose}
          tabIndex={-1}
        >
          <div
            className="border-glass-border-strong bg-bg-0/[0.96] flex max-h-[70svh] w-[480px] flex-col overflow-hidden rounded-lg border shadow-[0_24px_60px_-12px_oklch(0_0_0/0.6)] backdrop-blur-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* TAB BAR */}
            <div className="border-glass-border flex shrink-0 items-center border-b px-1.5">
              {TABS.map((t) => {
                const active = tab === t.id;
                const count = tabCounts[t.id];
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    className={clsx(
                      'flex items-center gap-1.5 px-2.5 py-2.5 text-xs font-medium tracking-tight transition-colors',
                      active
                        ? 'border-acc text-ink-0 border-b-[1.5px]'
                        : 'text-ink-3 hover:text-ink-1 border-b-[1.5px] border-transparent',
                    )}
                    style={{ marginBottom: -1 }}
                  >
                    {t.label}
                    <span
                      className={clsx(
                        'font-mono text-[10px]',
                        active ? 'text-acc-ink' : 'text-ink-4',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
              <div className="flex-1" />
              <button
                type="button"
                onClick={handleClear}
                className="text-ink-3 hover:text-ink-1 flex items-center gap-1 px-2 py-1.5 text-[11px] transition-colors"
              >
                <Trash2 className="h-2.5 w-2.5" /> Clear
              </button>
            </div>

            {/* SEARCH/FILTER */}
            <div className="border-glass-border flex shrink-0 items-center gap-2 border-b bg-black/[0.15] px-3 py-1.5">
              <Search className="text-ink-3 h-3 w-3 shrink-0" />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={
                  tab === 'debug' ? 'Filter logs...' : 'Filter activity...'
                }
                className="text-ink-1 flex-1 border-none bg-transparent text-xs outline-none placeholder:text-white/30"
              />
              {tab !== 'debug' && (
                <span className="text-ink-4 shrink-0 font-mono text-[10px]">
                  {tabCounts[tab]} items
                </span>
              )}
            </div>

            {/* BODY */}
            <div className="flex-1 overflow-y-auto">
              {tab === 'debug' ? (
                <DebugStream logs={debugLogs} filter={filter} />
              ) : (
                <ActivityFeed
                  tab={tab}
                  filter={filter}
                  runningJobs={runningJobs}
                  finishedJobs={finishedJobs}
                  notifications={notifications}
                  projectMap={projectMap}
                  onJobAction={handleJobAction}
                  onNotificationClick={handleNotificationClick}
                />
              )}
            </div>

            {/* FOOTER */}
            <div className="border-glass-border text-ink-3 flex shrink-0 items-center gap-2.5 border-t bg-black/[0.20] px-3 py-1.5 text-[11px]">
              <Kbd shortcut="up" className="text-[9px]" />
              <Kbd shortcut="down" className="text-[9px]" />
              <span>Navigate</span>
              <Kbd shortcut="enter" className="text-[9px]" />
              <span>Open</span>
              <div className="flex-1" />
              <span className="font-mono text-[10px]">
                {tab === 'debug'
                  ? `${debugLogs.length} log entries`
                  : `${tabCounts[tab]} items`}
              </span>
            </div>
          </div>
        </div>
      </RemoveScroll>
    </FocusLock>,
    document.body,
  );
}

// ---- Activity feed (non-debug tabs) ----
function ActivityFeed({
  tab,
  filter,
  runningJobs,
  finishedJobs,
  notifications,
  projectMap,
  onJobAction,
  onNotificationClick,
}: {
  tab: ActivityTab;
  filter: string;
  runningJobs: BackgroundJob[];
  finishedJobs: BackgroundJob[];
  notifications: AppNotification[];
  projectMap: Map<string, Project>;
  onJobAction: (action: string, job: BackgroundJob) => void;
  onNotificationClick: (n: AppNotification) => void;
}) {
  const filterLower = filter.toLowerCase();

  const filteredRunning = useMemo(
    () =>
      filter
        ? runningJobs.filter((j) =>
            j.title.toLowerCase().includes(filterLower),
          )
        : runningJobs,
    [runningJobs, filter, filterLower],
  );

  const filteredFinished = useMemo(
    () =>
      filter
        ? finishedJobs.filter((j) =>
            j.title.toLowerCase().includes(filterLower),
          )
        : finishedJobs,
    [finishedJobs, filter, filterLower],
  );

  const filteredNotifications = useMemo(
    () =>
      filter
        ? notifications.filter(
            (n) =>
              n.title.toLowerCase().includes(filterLower) ||
              n.body.toLowerCase().includes(filterLower),
          )
        : notifications,
    [notifications, filter, filterLower],
  );

  const showRunning = tab === 'all' || tab === 'running';
  const showFinishedJobs = tab === 'all' || tab === 'running';
  const showNotifications = tab === 'all' || tab === 'builds';

  const hasContent =
    (showRunning && filteredRunning.length > 0) ||
    (showFinishedJobs && filteredFinished.length > 0) ||
    (showNotifications && filteredNotifications.length > 0);

  if (!hasContent) {
    return (
      <div className="text-ink-3 py-12 text-center text-xs">
        <Check className="text-status-done mx-auto mb-2 h-5 w-5" />
        <div>All clear.</div>
        <div className="text-ink-4 mt-1 text-[11px]">
          No {tab === 'running' ? 'running jobs' : 'activity'}.
        </div>
      </div>
    );
  }

  return (
    <>
      {showRunning && filteredRunning.length > 0 && (
        <>
          <SectionDivider label="Running" count={filteredRunning.length} />
          {filteredRunning.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              projectMap={projectMap}
              onAction={onJobAction}
            />
          ))}
        </>
      )}
      {showFinishedJobs && filteredFinished.length > 0 && (
        <>
          <SectionDivider label="Recent" count={filteredFinished.length} />
          {filteredFinished.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              projectMap={projectMap}
              onAction={onJobAction}
            />
          ))}
        </>
      )}
      {showNotifications && filteredNotifications.length > 0 && (
        <>
          <SectionDivider
            label={tab === 'builds' ? 'Builds' : 'Notifications'}
            count={filteredNotifications.length}
          />
          {filteredNotifications.map((n) => (
            <NotificationRow
              key={n.id}
              notification={n}
              projectMap={projectMap}
              onClick={() => onNotificationClick(n)}
            />
          ))}
        </>
      )}
    </>
  );
}
```

**Step 2: Commit**

```
feat(activity-center): create unified overlay with All/Running/Builds/Debug tabs
```

---

## Task 4: Rewire the header — replace NotificationBar + Jobs button with ActivityButton

**Files:**
- Modify: `src/layout/ui-header/index.tsx`

**Step 1: Replace the header layout**

The header currently has: `[Menu] ... [NotificationBar + Usage] ... [Jobs]`

It should become a 3-column grid: `[Menu] [ActivityButton centered] [Usage displays]`

Remove imports for `NotificationBar`, `Loader2`, `getRunningJobsCount`, and `useBackgroundJobsStore` (no longer needed in this file). Import `ActivityButton` instead. Remove the `runningJobsCount` logic and the Jobs button JSX. Remove the `NotificationBar` usage. Replace the middle/right sections with the new centered layout.

The new header body should be:

```tsx
<header
  className="grid h-10 grid-cols-[1fr_auto_1fr] items-center"
  style={{ WebkitAppRegion: 'drag' } as CSSProperties}
>
  {/* LEFT — traffic lights + menu */}
  <div
    className="flex min-w-0 items-center px-2"
    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
  >
    {isMac && !isWindowFullscreen && <div className="w-[70px]" />}
    <Dropdown ...menu dropdown unchanged... />
  </div>

  {/* CENTER — Activity */}
  <div
    className="flex justify-center"
    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
  >
    <ActivityButton />
  </div>

  {/* RIGHT — telemetry */}
  <div
    className="flex items-center justify-end gap-1 px-4"
    style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
  >
    <RamUsageDisplay />
    <CompletionCostDisplay />
    <UsageDisplay />
  </div>
</header>
```

Remove imports: `Loader2`, `getRunningJobsCount`, `useBackgroundJobsStore`, `NotificationBar`.
Add import: `ActivityButton` from `./activity-button`.
Remove: `runningJobsCount` memo, jobs store usage.
Keep: `NotificationBar`'s init and debug listener — move those to the `ActivityButton` or the root.

**IMPORTANT:** The `NotificationBar` currently calls `initNotificationsStore()` and `useDebugLogsListener()`. These must be preserved. Move them into the `ActivityButton` component (add them in Task 2's code). Actually — better to call them at root level. Add `useDebugLogsListener()` and `initNotificationsStore()` calls to `ActivityButton` component or to the new `ActivityCenterContainer` in `__root.tsx`.

**Step 2: Commit**

```
feat(header): replace notification bar + jobs button with centered ActivityButton
```

---

## Task 5: Rewire `__root.tsx` — replace both containers with a single ActivityCenterContainer

**Files:**
- Modify: `src/routes/__root.tsx`

**Step 1: Remove old containers, add new one**

Remove `BackgroundJobsContainer` and `NotificationCenterContainer` functions. Remove their imports (`BackgroundJobsOverlay`, `NotificationCenterOverlay`, `useNotificationsStore`).

Add new `ActivityCenterContainer`:

```tsx
import { ActivityCenterOverlay } from '@/features/activity-center/ui-activity-center-overlay';
```

```tsx
function ActivityCenterContainer() {
  const isOpen = useOverlaysStore(
    (s) => s.activeOverlay === 'activity-center',
  );
  const toggle = useOverlaysStore((s) => s.toggle);
  const close = useOverlaysStore((s) => s.close);

  useCommands('activity-center-trigger', [
    {
      shortcut: 'cmd+j',
      label: 'Activity Center',
      section: 'General',
      handler: () => {
        toggle('activity-center');
      },
    },
  ]);

  if (!isOpen) return null;
  return <ActivityCenterOverlay onClose={() => close('activity-center')} />;
}
```

In `RootLayout`, replace `<BackgroundJobsContainer />` and `<NotificationCenterContainer />` with `<ActivityCenterContainer />`.

**Step 2: Commit**

```
feat(root): replace background-jobs + notification-center containers with activity-center
```

---

## Task 6: Move init hooks into ActivityButton and clean up notification-bar

**Files:**
- Modify: `src/layout/ui-header/activity-button.tsx`
- Delete: `src/layout/ui-header/notification-bar.tsx` (no longer used)

**Step 1: Add initialization to ActivityButton**

Add to the `ActivityButton` component:

```tsx
import { useEffect } from 'react';
import { useDebugLogsListener } from '@/stores/debug-logs';
import { initNotificationsStore } from '@/stores/notifications';

// Inside the component:
useEffect(() => {
  initNotificationsStore();
}, []);
useDebugLogsListener();
```

**Step 2: Delete notification-bar.tsx**

The file `src/layout/ui-header/notification-bar.tsx` is no longer imported anywhere.

**Step 3: Commit**

```
refactor: move notification/debug init to ActivityButton, remove notification-bar
```

---

## Task 7: Verify, lint, and fix

**Step 1: Run TypeScript check**

```bash
pnpm ts-check
```

Fix any type errors (likely around the removed overlay types and the `BindingKey` for `up`/`down`/`enter` in the footer Kbd — may need to use plain `<kbd>` elements instead if those aren't valid binding keys).

**Step 2: Run lint**

```bash
pnpm lint --fix
pnpm lint
```

**Step 3: Commit any fixes**

```
fix: resolve lint and type errors from activity center merge
```

---

## Summary of file changes

| Action | File |
|--------|------|
| Modify | `src/stores/overlays.ts` — remove old types, add `'activity-center'` |
| Create | `src/layout/ui-header/activity-button.tsx` — unified header pill |
| Create | `src/features/activity-center/ui-activity-center-overlay/index.tsx` — merged overlay |
| Modify | `src/layout/ui-header/index.tsx` — 3-col grid, use ActivityButton |
| Modify | `src/routes/__root.tsx` — single container replaces two |
| Delete | `src/layout/ui-header/notification-bar.tsx` — no longer needed |
| Keep   | `src/features/background-jobs/` — store still used by many consumers |
| Keep   | `src/features/notifications/` — old overlay file becomes unused but store stays |
| Keep   | `src/stores/background-jobs.ts` — unchanged, still core infra |
| Keep   | `src/stores/notifications.ts` — unchanged |
| Keep   | `src/stores/debug-logs.ts` — unchanged |
