import { type KeyboardEvent, useMemo, useState } from 'react';
import { RefreshCw, RotateCcw, Sparkles } from 'lucide-react';

import type {
  AgentMemoryDashboard,
  AgentMemoryExtractionRun,
  AgentMemoryItem,
  AgentMemoryItemGroup,
} from '@shared/agent-memory-types';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';

import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { useActiveProjects } from '@/hooks/use-projects';
import { useBackgroundJobsStore } from '@/stores/background-jobs';

export type DashboardView = 'global' | 'project' | 'candidates' | 'evidence' | 'runs';

const VIEWS: Array<{ id: DashboardView; label: string }> = [
  { id: 'global', label: 'Global Profile' },
  { id: 'project', label: 'Project Memory' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'evidence', label: 'Raw Evidence' },
  { id: 'runs', label: 'Extraction Runs' },
];

function tabId(view: DashboardView): string {
  return `agent-memory-tab-${view}`;
}

function panelId(view: DashboardView): string {
  return `agent-memory-panel-${view}`;
}

export function getNextAgentMemoryDashboardView({
  view,
  key,
}: {
  view: DashboardView;
  key: string;
}): DashboardView | null {
  const index = VIEWS.findIndex(({ id }) => id === view);
  if (key === 'Home') return VIEWS[0].id;
  if (key === 'End') return VIEWS.at(-1)!.id;
  if (key === 'ArrowRight') return VIEWS[(index + 1) % VIEWS.length].id;
  if (key === 'ArrowLeft') {
    return VIEWS[(index - 1 + VIEWS.length) % VIEWS.length].id;
  }
  return null;
}

export function AgentMemoryDashboardInitialError({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className="border-danger/30 bg-danger/5 mt-4 rounded-lg border p-4"
      role="alert"
    >
      <p className="text-danger text-sm font-medium">Agent Memory failed to load</p>
      <p className="text-ink-3 mt-1 text-xs">
        {error instanceof Error ? error.message : 'Unknown error'}
      </p>
      <button
        type="button"
        className="text-acc-ink mt-3 text-xs font-medium disabled:opacity-50"
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? 'Retrying...' : 'Retry'}
      </button>
    </div>
  );
}

function title(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('-', ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Never';
}

function EmptyState({ children }: { children: string }) {
  return <p className="text-ink-3 py-10 text-center text-xs">{children}</p>;
}

function MemoryItemMetadata({ item }: { item: AgentMemoryItem }) {
  return (
    <dl
      aria-label="Memory item metadata"
      className="border-line-soft mt-2 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-2 sm:grid-cols-3"
    >
      <div>
        <dt className="text-ink-4 text-[9px] tracking-wider uppercase">Scope</dt>
        <dd className="text-ink-2 mt-0.5 text-[10px]">{title(item.scope)}</dd>
      </div>
      <div>
        <dt className="text-ink-4 text-[9px] tracking-wider uppercase">Confidence</dt>
        <dd className="text-ink-2 mt-0.5 text-[10px]">
          {Math.round(item.confidence * 100)}%
        </dd>
      </div>
      <div>
        <dt className="text-ink-4 text-[9px] tracking-wider uppercase">Evidence</dt>
        <dd className="text-ink-2 mt-0.5 text-[10px]">{item.evidenceIds.length}</dd>
      </div>
      <div>
        <dt className="text-ink-4 text-[9px] tracking-wider uppercase">First seen</dt>
        <dd className="text-ink-2 mt-0.5 text-[10px]">
          <time dateTime={item.firstSeenAt}>{formatDate(item.firstSeenAt)}</time>
        </dd>
      </div>
      <div>
        <dt className="text-ink-4 text-[9px] tracking-wider uppercase">Last seen</dt>
        <dd className="text-ink-2 mt-0.5 text-[10px]">
          <time dateTime={item.lastSeenAt}>{formatDate(item.lastSeenAt)}</time>
        </dd>
      </div>
    </dl>
  );
}

function MemoryGroups({
  groups,
  empty,
}: {
  groups: AgentMemoryItemGroup[];
  empty: string;
}) {
  if (groups.length === 0) return <EmptyState>{empty}</EmptyState>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {groups.map((group) => (
        <section
          key={group.category}
          className="border-glass-border bg-bg-2 rounded-lg border p-3"
        >
          <h4 className="text-ink-4 text-[10px] font-semibold tracking-wider uppercase">
            {title(group.category)}
          </h4>
          <div className="mt-2 space-y-2">
            {group.items.map((item) => (
              <article key={item.id} className="border-line-soft border-t pt-2 first:border-0 first:pt-0">
                <p className="text-ink-1 text-xs leading-5">{item.statement}</p>
                <MemoryItemMetadata item={item} />
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function contextEntries(context: Record<string, unknown> | null) {
  if (!context) return [];
  return Object.entries(context).flatMap(([key, value]) => {
    if (value === null || value === undefined || value === '') return [];
    return [
      {
        label: title(key).toLowerCase(),
        value: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ];
  });
}

function Pagination({
  page,
  pageSize,
  total,
  onPreviousPage,
  onNextPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between">
      <button
        type="button"
        className="text-acc-ink disabled:text-ink-4 text-xs disabled:cursor-not-allowed"
        disabled={page === 0}
        onClick={onPreviousPage}
      >
        Previous
      </button>
      <span className="text-ink-4 text-[10px]">
        Page {page + 1} of {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <button
        type="button"
        className="text-acc-ink disabled:text-ink-4 text-xs disabled:cursor-not-allowed"
        disabled={(page + 1) * pageSize >= total}
        onClick={onNextPage}
      >
        Next
      </button>
    </div>
  );
}

function RunCard({
  run,
  retrying,
  onRetry,
}: {
  run: AgentMemoryExtractionRun;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <article className="border-glass-border bg-bg-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-ink-1 text-xs font-medium">
            {title(run.scope)} extraction · {title(run.status)}
          </div>
          <div className="text-ink-4 mt-1 font-mono text-[10px]">
            {run.backend} / {run.model}
            {run.thinkingEffort ? ` / ${run.thinkingEffort}` : ''}
          </div>
        </div>
        {run.status === 'failed' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={retrying}
            onClick={onRetry}
            aria-label={`Retry failed extraction run ${run.id}`}
          >
            <RotateCcw size={13} /> Retry
          </Button>
        )}
      </div>
      <div className="text-ink-3 mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
        <span>{run.proposedItemCount} proposed</span>
        <span>{run.acceptedItemCount} accepted</span>
        <span>{run.durationMs === null ? 'Running' : `${(run.durationMs / 1_000).toFixed(1)}s`}</span>
        <span>{formatDate(run.startedAt)}</span>
      </div>
      {run.eventRanges.length > 0 && (
        <div className="border-line-soft mt-3 border-t pt-2">
          {run.eventRanges.map((range) => (
            <p key={`${range.fileName}:${range.fromOffset}`} className="text-ink-4 font-mono text-[10px]">
              {range.fileName} · bytes {range.fromOffset}-{range.toOffset} · {range.eventCount}{' '}
              {range.eventCount === 1 ? 'event' : 'events'}
            </p>
          ))}
        </div>
      )}
      {run.error && <p className="text-danger mt-3 text-xs">{run.error.message}</p>}
    </article>
  );
}

export function AgentMemoryDashboardView({
  dashboard,
  view,
  projects,
  selectedProjectId,
  isExtracting,
  retryingRunId,
  error,
  onViewChange,
  onProjectChange,
  onRefresh,
  onExtract,
  onRetry,
  onPreviousPage,
  onNextPage,
}: {
  dashboard: AgentMemoryDashboard;
  view: DashboardView;
  projects: Array<{ id: string; name: string }>;
  selectedProjectId: string;
  isExtracting: boolean;
  retryingRunId: string | null;
  error: unknown;
  onViewChange: (view: DashboardView) => void;
  onProjectChange: (projectId: string) => void;
  onRefresh: () => void;
  onExtract: () => void;
  onRetry: (run: AgentMemoryExtractionRun) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  const page = view === 'runs' ? dashboard.extractionRuns : dashboard.evidence;
  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentView: DashboardView,
  ) => {
    const nextView = getNextAgentMemoryDashboardView({
      view: currentView,
      key: event.key,
    });
    if (!nextView) return;
    event.preventDefault();
    onViewChange(nextView);
    document.getElementById(tabId(nextView))?.focus();
  };
  return (
    <div className="border-glass-border bg-bg-1 mt-4 overflow-hidden rounded-lg border">
      <div className="border-line-soft flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-ink-1 text-sm font-medium">Memory observatory</h3>
          <p className="text-ink-3 mt-0.5 text-xs">Inspect extracted knowledge and its exact evidence trail.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {projects.length > 0 && (
            <select
              aria-label="Agent Memory project"
              className="border-glass-border bg-bg-2 text-ink-1 h-8 rounded-md border px-2 text-xs"
              value={selectedProjectId}
              onChange={(event) => onProjectChange(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" variant="ghost" onClick={onRefresh} aria-label="Refresh Agent Memory">
            <RefreshCw size={14} />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!dashboard.enabled || !selectedProjectId || isExtracting}
            onClick={onExtract}
          >
            <Sparkles size={14} /> {isExtracting ? 'Extracting...' : 'Extract Now'}
          </Button>
        </div>
      </div>

      {!dashboard.enabled && (
        <div className="border-warning/25 bg-warning/5 border-b px-4 py-2.5">
          <p className="text-ink-2 text-xs">
            Agent Memory is disabled; capture and extraction are paused. Stored memory remains readable.
          </p>
        </div>
      )}
      {dashboard.repairNotice && (
        <div className="border-warning/25 bg-warning/5 border-b px-4 py-2.5">
          <p className="text-ink-2 text-xs">{dashboard.repairNotice}</p>
        </div>
      )}
      {Boolean(error) && (
        <p className="text-danger px-4 pt-3 text-xs">
          Memory operation failed: {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      )}

      <div className="border-line-soft overflow-x-auto border-b px-3 pt-3" role="tablist" aria-label="Agent Memory views">
        <div className="flex min-w-max gap-1">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              id={tabId(entry.id)}
              type="button"
              role="tab"
              aria-controls={panelId(entry.id)}
              aria-selected={view === entry.id}
              tabIndex={view === entry.id ? 0 : -1}
              className={`rounded-t-md border-b-2 px-3 py-2 text-xs transition-colors ${
                view === entry.id
                  ? 'border-acc text-ink-1 bg-bg-2'
                  : 'text-ink-3 hover:text-ink-1 border-transparent'
              }`}
              onClick={() => onViewChange(entry.id)}
              onKeyDown={(event) => handleTabKeyDown(event, entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {VIEWS.map((entry) => (
        <div
          key={entry.id}
          id={panelId(entry.id)}
          className="p-4"
          role="tabpanel"
          aria-labelledby={tabId(entry.id)}
          hidden={view !== entry.id}
        >
          {view === entry.id && (
            <>
        {view === 'global' && (
          <MemoryGroups groups={dashboard.globalProfile} empty="No global memory extracted yet." />
        )}
        {view === 'project' && (
          <MemoryGroups groups={dashboard.projectMemory} empty="No project memory extracted yet." />
        )}
        {view === 'candidates' &&
          (dashboard.candidates.length === 0 ? (
            <EmptyState>No promotion candidates.</EmptyState>
          ) : (
            <div className="space-y-2">
              {dashboard.candidates.map(({ item, blockers }) => (
                <article key={item.id} className="border-glass-border bg-bg-2 rounded-lg border p-3">
                  <p className="text-ink-1 text-xs leading-5">{item.statement}</p>
                  <MemoryItemMetadata item={item} />
                  <div className="mt-2 flex flex-wrap gap-2" aria-label="Promotion blockers">
                    {blockers.length === 0 ? (
                      <span className="text-warning text-[10px]">Awaiting next extraction review</span>
                    ) : (
                      blockers.map((blocker) => (
                        <span key={blocker.kind} className="border-glass-border text-ink-3 rounded-full border px-2 py-0.5 text-[10px]">
                          {blocker.current} of {blocker.required}{' '}
                          distinct {blocker.kind === 'task-count' ? 'tasks' : 'projects'}
                        </span>
                      ))
                    )}
                  </div>
                </article>
              ))}
            </div>
          ))}
        {view === 'evidence' &&
          (dashboard.evidence.items.length === 0 ? (
            <EmptyState>No captured evidence for this project.</EmptyState>
          ) : (
            <div className="space-y-2">
              {dashboard.evidence.items.map((event) => (
                <article key={event.id} className="border-glass-border bg-bg-2 rounded-lg border p-3">
                  <div className="text-ink-4 flex flex-wrap justify-between gap-2 text-[10px] uppercase tracking-wider">
                    <span>{title(event.source)}</span>
                    <span>{formatDate(event.createdAt)}</span>
                  </div>
                  <details className="text-ink-2 mt-2 text-xs" open>
                    <summary>Evidence body</summary>
                    <pre className="bg-bg-3 mt-2 overflow-auto rounded-md p-3 font-sans whitespace-pre-wrap">{event.text}</pre>
                  </details>
                  {contextEntries(event.context).map((entry) => (
                    <details key={entry.label} className="text-ink-2 mt-2 text-xs">
                      <summary>Context: {entry.label}</summary>
                      <pre className="bg-bg-3 mt-2 overflow-auto rounded-md p-3 font-sans whitespace-pre-wrap">{entry.value}</pre>
                    </details>
                  ))}
                </article>
              ))}
            </div>
          ))}
        {view === 'runs' &&
          (dashboard.extractionRuns.items.length === 0 ? (
            <EmptyState>No extraction runs yet.</EmptyState>
          ) : (
            <div className="space-y-2">
              {dashboard.extractionRuns.items.map((run) => (
                <RunCard
                  key={`${run.scope}:${run.id}`}
                  run={run}
                  retrying={retryingRunId === `${run.scope}:${run.id}`}
                  onRetry={() => onRetry(run)}
                />
              ))}
            </div>
          ))}
        {(view === 'evidence' || view === 'runs') && (
          <Pagination
            page={page.page}
            pageSize={page.pageSize}
            total={page.total}
            onPreviousPage={onPreviousPage}
            onNextPage={onNextPage}
          />
        )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function AgentMemoryDashboard() {
  const { data: projects = [] } = useActiveProjects();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [view, setView] = useState<DashboardView>('global');
  const [page, setPage] = useState(0);
  const selectedProjectId = projectId || projects[0]?.id || '';
  const dashboardQuery = useQuery({
    queryKey: ['agent-memory-dashboard', selectedProjectId, view, page],
    queryFn: () =>
      api.agentMemory.getDashboard({
        projectId: selectedProjectId || undefined,
        evidencePage: view === 'evidence' ? page : 0,
        extractionRunPage: view === 'runs' ? page : 0,
      }),
    // `view` is part of the key, so without this every tab switch drops to the
    // full-panel "Loading Agent Memory..." state, losing keyboard focus during
    // arrow-key tab navigation and refetching data that is mostly identical.
    placeholderData: keepPreviousData,
  });
  const addRunningJob = useBackgroundJobsStore((state) => state.addRunningJob);
  const markJobSucceeded = useBackgroundJobsStore((state) => state.markJobSucceeded);
  const markJobFailed = useBackgroundJobsStore((state) => state.markJobFailed);
  const jobs = useBackgroundJobsStore((state) => state.jobs);
  // Mutation state is component-local, so it resets when settings are closed and
  // reopened mid-extraction. The store is the durable signal.
  const hasRunningExtraction = useMemo(
    () =>
      jobs.some((job) => job.type === 'agent-memory-extraction' && job.status === 'running'),
    [jobs],
  );
  const startExtractionJob = (title: string) =>
    addRunningJob({
      type: 'agent-memory-extraction',
      title,
      projectId: selectedProjectId || null,
      details: {
        projectName: projects.find(({ id }) => id === selectedProjectId)?.name ?? null,
      },
    });
  const extract = useMutation({
    mutationFn: () => api.agentMemory.extractNow(selectedProjectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-memory-dashboard'] }),
  });
  const retry = useMutation({
    mutationFn: (run: AgentMemoryExtractionRun) =>
      api.agentMemory.retryRun({
        runId: run.id,
        scope: run.scope,
        projectId: run.projectId,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-memory-dashboard'] }),
  });
  const dashboard = dashboardQuery.data;
  if (!dashboard) {
    if (dashboardQuery.error) {
      return (
        <AgentMemoryDashboardInitialError
          error={dashboardQuery.error}
          retrying={dashboardQuery.isFetching}
          onRetry={() => void dashboardQuery.refetch()}
        />
      );
    }
    return <p className="text-ink-3 mt-4 py-8 text-center text-xs">Loading Agent Memory...</p>;
  }
  return (
    <AgentMemoryDashboardView
      dashboard={dashboard}
      view={view}
      projects={projects.map(({ id, name }) => ({ id, name }))}
      selectedProjectId={selectedProjectId}
      isExtracting={extract.isPending || hasRunningExtraction}
      retryingRunId={
        retry.isPending && retry.variables
          ? `${retry.variables.scope}:${retry.variables.id}`
          : null
      }
      error={dashboardQuery.error ?? extract.error ?? retry.error}
      onViewChange={(nextView) => {
        setView(nextView);
        setPage(0);
      }}
      onProjectChange={(nextProjectId) => {
        setProjectId(nextProjectId);
        setPage(0);
      }}
      onRefresh={() => void dashboardQuery.refetch()}
      onExtract={() => {
        const jobId = startExtractionJob('Extract agent memory');
        extract
          .mutateAsync()
          .then((result) =>
            markJobSucceeded(
              jobId,
              result.processed ? undefined : { warningMessage: 'Nothing to extract' },
            ),
          )
          .catch((error: unknown) => markJobFailed(jobId, errorMessage(error)));
      }}
      onRetry={(run) => {
        const jobId = startExtractionJob('Retry agent memory extraction');
        retry
          .mutateAsync(run)
          .then(() => markJobSucceeded(jobId))
          .catch((error: unknown) => markJobFailed(jobId, errorMessage(error)));
      }}
      onPreviousPage={() => setPage((value) => Math.max(0, value - 1))}
      onNextPage={() => setPage((value) => value + 1)}
    />
  );
}
