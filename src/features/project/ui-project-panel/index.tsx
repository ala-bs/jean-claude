import {
  ArrowLeft,
  ExternalLink,
  FolderGit2,
  GitBranch,
  ListTodo,
  RotateCw,
  Settings,
} from 'lucide-react';
import { getEditorLabel, useEditorSetting } from '@/hooks/use-settings';
import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useNavigate } from '@tanstack/react-router';

import {
  getRunCommandLogLineCount,
  useTaskMessagesStore,
} from '@/stores/task-messages';
import {
  isFiltered,
  useProjectCommitCount,
  useProjectGitAutoFetch,
  useProjectGitGraphPages,
  useProjectGitRefresh,
  useProjectGitStatus,
} from '@/hooks/use-project-git';
import { useProject, useProjectBranches } from '@/hooks/use-projects';
import { cleanIpcError } from '@/lib/ipc-error';
import { CommandLogsPane } from '@/features/task/ui-task-panel/command-logs-pane';
import { CommitHistory } from './commit-history';
import { CommitPanel } from './commit-panel';
import { getProjectRootRunId } from '@shared/run-command-types';
import type { ProjectGitLogFilter } from '@shared/types';
import { ProjectLogoBackground } from '@/features/project/ui-project-logo';
import { RunButton } from '@/features/agent/ui-run-button';
import { SyncBar } from './sync-bar';
import { TasksRail } from './tasks-rail';
import { useCommands } from '@/common/hooks/use-commands';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useOverlaysStore } from '@/stores/overlays';
import { useProjectCommandAvailability } from '@/hooks/use-project-command-availability';
import { useSetBacklogSelectedProjectId } from '@/stores/backlog-overlay-draft';
import { useToastStore } from '@/stores/toasts';

/**
 * Turns a git remote into an `owner/repo` label.
 *
 * Handles both `https://host/owner/repo.git` and `git@host:owner/repo.git`,
 * and falls back to the raw URL rather than showing nothing for a remote shape
 * we do not recognise (a local path remote, say).
 */
function shortRemote(remoteUrl: string): string {
  const withoutSuffix = remoteUrl.replace(/\.git$/, '');
  const match = /[:/]([^/:]+\/[^/]+)$/.exec(withoutSuffix);
  return match ? match[1] : remoteUrl;
}

/** Only http(s) remotes are openable; `git@…` is not a URL a browser can take. */
function remoteHref(remoteUrl: string): string | null {
  return /^https?:\/\//.test(remoteUrl) ? remoteUrl : null;
}

function ProjectHeader({
  name,
  path,
  remoteUrl,
  onOpenBacklog,
  onOpenSettings,
  onOpenInEditor,
  editorLabel,
  onBack,
  runControl,
  onRefresh,
  isRefreshing,
  children,
}: {
  name: string;
  path: string;
  remoteUrl: string | null;
  onOpenBacklog: () => void;
  onOpenSettings: () => void;
  onOpenInEditor: () => void;
  editorLabel: string;
  onBack?: () => void;
  /** Run/stop controls for commands executed in the repository checkout. */
  runControl?: React.ReactNode;
  /** Omitted for non-git projects, where there is no git state to re-read. */
  onRefresh?: () => void;
  isRefreshing: boolean;
  children?: React.ReactNode;
}) {
  const href = remoteUrl ? remoteHref(remoteUrl) : null;

  return (
    <header className="border-line-soft relative shrink-0 overflow-hidden border-b px-5 pt-4 pb-3.5">
      {children}
      <div className="relative z-10 flex items-start gap-3.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            title="Back to task (Esc)"
            className="text-ink-2 hover:bg-glass-light hover:text-ink-0 mt-0.5 inline-flex h-[34px] w-[26px] shrink-0 items-center justify-center rounded-md transition-colors"
          >
            <ArrowLeft size={15} />
          </button>
        )}
        <div className="bg-acc-soft border-acc-line text-acc-ink mt-0.5 flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] border">
          <GitBranch size={16} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-ink-0 truncate text-[19px] font-semibold tracking-[-0.02em]">
              {name}
            </h1>
            {remoteUrl &&
              (href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  title={remoteUrl}
                  className="text-ink-3 hover:text-acc-ink inline-flex shrink-0 items-center gap-1.5 font-mono text-[11.5px] transition-colors"
                >
                  {shortRemote(remoteUrl)}
                  <ExternalLink size={10.5} />
                </a>
              ) : (
                <span
                  title={remoteUrl}
                  className="text-ink-3 shrink-0 truncate font-mono text-[11.5px]"
                >
                  {shortRemote(remoteUrl)}
                </span>
              ))}
          </div>
          <div
            title={path}
            className="text-ink-4 truncate font-mono text-[11.5px]"
          >
            {path}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {runControl}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-busy={isRefreshing}
              title="Re-read git state from disk (no network)"
              aria-label="Refresh git data"
              className="text-ink-2 hover:bg-glass-light hover:text-ink-0 inline-flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors disabled:opacity-60"
            >
              <RotateCw
                size={13}
                className={isRefreshing ? 'animate-spin' : undefined}
              />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenInEditor}
            title={`Open repository in ${editorLabel} (⌘⇧E)`}
            className="border-glass-border text-ink-1 hover:border-glass-border-strong hover:bg-glass-light hover:text-ink-0 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
          >
            <ExternalLink size={12} />
            <span>Open in {editorLabel}</span>
          </button>
          <button
            type="button"
            onClick={onOpenBacklog}
            className="border-glass-border text-ink-1 hover:border-glass-border-strong hover:bg-glass-light hover:text-ink-0 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
          >
            <ListTodo size={12} />
            <span>Backlog</span>
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="Project settings"
            className="text-ink-2 hover:bg-glass-light hover:text-ink-0 inline-flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors"
          >
            <Settings size={13} />
          </button>
        </div>
      </div>
    </header>
  );
}

export function ProjectPanel({
  projectId,
  backToTaskId,
}: {
  projectId: string;
  /** Set when opened from a task, so we can offer a way back to it. */
  backToTaskId?: string;
}) {
  const navigate = useNavigate();
  const { data: editorSetting } = useEditorSetting();
  const editorLabel = editorSetting ? getEditorLabel(editorSetting) : 'Editor';
  const goBackToTask = useCallback(() => {
    if (!backToTaskId) return;
    void navigate({ to: '/all/$taskId', params: { taskId: backToTaskId } });
  }, [backToTaskId, navigate]);
  const { data: project, isLoading: isLoadingProject } = useProject(projectId);
  const openSettingsForProject = useOverlaysStore(
    (state) => state.openSettingsForProject,
  );
  const open = useOverlaysStore((state) => state.open);
  const setBacklogProjectId = useSetBacklogSelectedProjectId();

  const addToast = useToastStore((state) => state.addToast);
  const { refresh, isRefreshing } = useProjectGitRefresh(projectId);
  // Mirrors SyncBar's `run()` helper: a silent failure here would stop the
  // spinner and change nothing on screen, which reads as "the button is broken".
  const runRefresh = useCallback(() => {
    void refresh().catch((error: unknown) => {
      addToast({
        message: `Refresh failed: ${cleanIpcError(error)}`,
        type: 'error',
      });
    });
  }, [addToast, refresh]);

  const { data: status } = useProjectGitStatus(projectId);
  const { data: branches } = useProjectBranches(projectId);

  const [query, setQuery] = useState('');
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // Run commands from the repository checkout itself. The run service is keyed
  // by task id, so project-root runs borrow a synthetic id derived from the
  // project — the same one the running-commands overlay uses for favorites, so
  // a command started here shows up there (and vice versa) rather than twice.
  const runTaskId = getProjectRootRunId(projectId);
  const [isLogsPaneOpen, setIsLogsPaneOpen] = useState(false);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(
    null,
  );
  const runDropdownRef = useRef<{ toggle: () => void } | null>(null);
  // The run dropdown renders nothing without configured commands, so offering
  // its shortcut would be a command palette entry that silently does nothing.
  const { hasConfiguredItems } = useProjectCommandAvailability(projectId);
  // Logs outlive their configuration: RunButton keeps showing its ⌘L badge for
  // historical logs after the commands are deleted, so the shortcut has to stay
  // bound in that case too — otherwise the badge advertises a dead key.
  const hasRunCommandLogs = useTaskMessagesStore((state) => {
    const logs = state.runCommandLogs[runTaskId];
    if (!logs) return false;
    return Object.values(logs).some(
      (entry) => getRunCommandLogLineCount(entry) > 0,
    );
  });
  // ...and while the pane is open the shortcut is also the way to close it.
  const canToggleLogs =
    hasConfiguredItems || hasRunCommandLogs || isLogsPaneOpen;

  // The logs pane, the commit diff and the tasks rail all share the right
  // column. Opening one closes the other so every action has a visible effect —
  // otherwise ⌘L behind an open commit diff would look like a dead key.
  const openLogsPane = useCallback(() => {
    setSelectedHash(null);
    setIsLogsPaneOpen(true);
  }, []);
  // Clearing the commit only belongs on the opening path: closing the logs
  // reveals the tasks rail, and discarding a commit the user never saw behind
  // the pane would be a side effect with nothing to show for it.
  const toggleLogsPane = useCallback(() => {
    if (isLogsPaneOpen) {
      setIsLogsPaneOpen(false);
      return;
    }
    openLogsPane();
  }, [isLogsPaneOpen, openLogsPane]);

  // Every keystroke would otherwise run a fresh `git log` over the whole
  // repository; the field itself stays responsive because only the query that
  // reaches git is delayed.
  const debouncedQuery = useDebouncedValue(query, 250);

  const filter = useMemo<ProjectGitLogFilter>(
    () => ({ query: debouncedQuery, branches: selectedBranches }),
    [debouncedQuery, selectedBranches],
  );

  const { data: totalCommits, isFetching: isCountingMatches } =
    useProjectCommitCount(projectId, filter);

  const {
    data: graphPages,
    isLoading: isLoadingGraph,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useProjectGitGraphPages(projectId, filter);

  const commits = useMemo(
    () => graphPages?.pages.flat() ?? [],
    [graphPages],
  );

  useCommands(
    'project-panel-history',
    [
      {
        label: 'Search Commits',
        section: 'Project',
        shortcut: 'cmd+f',
        handler: () => {
          // The command logs pane binds ⌘F to its own log filter on a bubbling
          // window listener, which this capture-phase dispatcher would otherwise
          // pre-empt. Declining hands the key back to whatever is focused.
          if (document.activeElement?.closest('[data-command-logs-pane]')) {
            return false;
          }
          searchInput.current?.focus();
          searchInput.current?.select();
          return true;
        },
      },
      // Only bound while a commit is open, so Escape stays available to
      // whatever else is mounted when the diff pane is closed.
      selectedHash !== null && {
        label: 'Close Commit Diff',
        shortcut: 'escape',
        handler: () => setSelectedHash(null),
        hideInCommandPalette: true,
      },
      // Escape closes the pane rather than leaving the project entirely. The
      // three Escape bindings here are mutually exclusive by construction: only
      // one of the right column's occupants is ever on screen.
      isLogsPaneOpen && {
        label: 'Close Command Logs',
        shortcut: 'escape',
        handler: () => setIsLogsPaneOpen(false),
        hideInCommandPalette: true,
      },
      status?.isGitRepository !== false && {
        label: 'Refresh Git Data',
        section: 'Project',
        handler: runRefresh,
      },
      // Only when we came from a task and no commit diff is open, so Escape
      // still closes the diff first.
      !!project?.path && {
        label: 'Open Project in Editor',
        section: 'Project',
        shortcut: 'cmd+shift+e',
        handler: () => {
          void api.shell.openInEditor(project.path);
        },
      },
      hasConfiguredItems && {
        label: 'Run Command',
        section: 'Project',
        shortcut: 'cmd+u',
        handler: () => runDropdownRef.current?.toggle(),
      },
      canToggleLogs && {
        label: 'Toggle Command Logs',
        section: 'Project',
        shortcut: 'cmd+l',
        handler: toggleLogsPane,
      },
      backToTaskId !== undefined &&
        selectedHash === null &&
        !isLogsPaneOpen && {
          label: 'Back to Task',
          section: 'Project',
          shortcut: 'escape',
          handler: goBackToTask,
        },
    ],
  );

  // Hold off until we know it is a repo, so a non-git project does not fire a
  // doomed fetch on every interval tick.
  useProjectGitAutoFetch(projectId, status?.isGitRepository !== false);

  const openBacklogForProject = () => {
    // The backlog overlay reads its project from the persisted draft store, so
    // without this it would open whichever project was last selected there.
    setBacklogProjectId(projectId);
    open('backlog');
  };

  if (isLoadingProject && !project) {
    return (
      <div className="bg-bg-0 text-ink-3 flex h-full flex-1 items-center justify-center text-sm">
        Loading project…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="bg-bg-0 text-ink-3 flex h-full flex-1 items-center justify-center text-sm">
        Project not found
      </div>
    );
  }

  const isGitRepository = status?.isGitRepository ?? true;

  return (
    <div className="bg-bg-0 flex h-full min-h-0 flex-1 flex-col">
      <ProjectHeader
        name={project.name}
        path={project.path}
        remoteUrl={status?.remoteUrl ?? null}
        onOpenBacklog={openBacklogForProject}
        onOpenSettings={() => openSettingsForProject(projectId)}
        onOpenInEditor={() => {
          void api.shell.openInEditor(project.path);
        }}
        editorLabel={editorLabel}
        onBack={backToTaskId ? goBackToTask : undefined}
        runControl={
          <RunButton
            taskId={runTaskId}
            projectId={projectId}
            workingDir={project.path}
            dropdownRef={runDropdownRef}
            isLogsPaneOpen={isLogsPaneOpen}
            onToggleLogs={toggleLogsPane}
            onRunCommand={(runCommandIds) => {
              setSelectedCommandId(runCommandIds[0] ?? null);
              openLogsPane();
            }}
          />
        }
        onRefresh={isGitRepository ? runRefresh : undefined}
        isRefreshing={isRefreshing}
      >
        <ProjectLogoBackground project={project} showColorFallback />
      </ProjectHeader>

      {isGitRepository && status && (
        <SyncBar projectId={projectId} status={status} />
      )}

      <div className="flex min-h-0 flex-1">
        {isGitRepository ? (
          <CommitHistory
            commits={commits}
            branch={status?.branch ?? ''}
            totalCommits={totalCommits}
            isLoading={isLoadingGraph}
            isLoadingMore={isFetchingNextPage}
            hasMore={!!hasNextPage}
            onLoadMore={() => void fetchNextPage()}
            query={query}
            onQueryChange={setQuery}
            selectedBranches={selectedBranches}
            onSelectedBranchesChange={setSelectedBranches}
            branches={branches ?? []}
            matchCount={totalCommits}
            isCountingMatches={isCountingMatches && isFiltered(filter)}
            searchInputRef={searchInput}
            selectedHash={selectedHash}
            onSelectCommit={(commit) => {
              // Clicking the open commit again closes the pane, so the rail can
              // be brought back without reaching for the Close button.
              setSelectedHash((current) =>
                current === commit.hash ? null : commit.hash,
              );
              setIsLogsPaneOpen(false);
            }}
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center p-5">
            <div className="border-line-soft text-ink-3 flex flex-col items-center gap-2 rounded-lg border px-4 py-8 text-center text-sm">
              <FolderGit2 className="text-ink-3 h-5 w-5" />
              <p className="text-ink-1">Not a git repository</p>
              <p className="text-xs">
                Git status, branches and history are unavailable for this
                project.
              </p>
            </div>
          </div>
        )}

        {/* One right-hand column, three occupants. The commit history beside it
            is `flex-1` with `flex-basis: 0`, so it carries no shrink weight —
            the wrapper keeps the pane at the width the user dragged it to
            instead of letting it absorb every shortfall. */}
        <div className="flex shrink-0">
          {selectedHash ? (
            <CommitPanel
              projectId={projectId}
              commitHash={selectedHash}
              onClose={() => setSelectedHash(null)}
            />
          ) : isLogsPaneOpen ? (
            <CommandLogsPane
              taskId={runTaskId}
              projectId={projectId}
              workingDir={project.path}
              selectedCommandId={selectedCommandId}
              onSelectCommand={setSelectedCommandId}
              onClose={() => setIsLogsPaneOpen(false)}
            />
          ) : (
            <TasksRail projectId={projectId} />
          )}
        </div>
      </div>
    </div>
  );
}
