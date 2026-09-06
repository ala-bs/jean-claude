import { ExternalLink, FolderGit2, GitBranch, ListTodo, Settings } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import {
  isFiltered,
  useProjectCommitCount,
  useProjectGitAutoFetch,
  useProjectGitGraphPages,
  useProjectGitStatus,
} from '@/hooks/use-project-git';
import { useProject, useProjectBranches } from '@/hooks/use-projects';
import { CommitHistory } from './commit-history';
import { CommitPanel } from './commit-panel';
import type { ProjectGitLogFilter } from '@shared/types';
import { ProjectLogoBackground } from '@/features/project/ui-project-logo';
import { SyncBar } from './sync-bar';
import { TasksRail } from './tasks-rail';
import { useCommands } from '@/common/hooks/use-commands';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useOverlaysStore } from '@/stores/overlays';
import { useSetBacklogSelectedProjectId } from '@/stores/backlog-overlay-draft';

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
  children,
}: {
  name: string;
  path: string;
  remoteUrl: string | null;
  onOpenBacklog: () => void;
  onOpenSettings: () => void;
  children?: React.ReactNode;
}) {
  const href = remoteUrl ? remoteHref(remoteUrl) : null;

  return (
    <header className="border-line-soft relative shrink-0 overflow-hidden border-b px-5 pt-4 pb-3.5">
      {children}
      <div className="relative z-10 flex items-start gap-3.5">
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

export function ProjectPanel({ projectId }: { projectId: string }) {
  const { data: project, isLoading: isLoadingProject } = useProject(projectId);
  const openSettingsForProject = useOverlaysStore(
    (state) => state.openSettingsForProject,
  );
  const open = useOverlaysStore((state) => state.open);
  const setBacklogProjectId = useSetBacklogSelectedProjectId();

  const { data: status } = useProjectGitStatus(projectId);
  const { data: branches } = useProjectBranches(projectId);

  const [query, setQuery] = useState('');
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

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
          searchInput.current?.focus();
          searchInput.current?.select();
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
            onSelectCommit={(commit) =>
              // Clicking the open commit again closes the pane, so the rail can
              // be brought back without reaching for the Close button.
              setSelectedHash((current) =>
                current === commit.hash ? null : commit.hash,
              )
            }
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

        {selectedHash ? (
          <CommitPanel
            projectId={projectId}
            commitHash={selectedHash}
            onClose={() => setSelectedHash(null)}
          />
        ) : (
          <TasksRail projectId={projectId} />
        )}
      </div>
    </div>
  );
}
