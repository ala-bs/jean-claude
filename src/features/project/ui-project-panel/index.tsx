import { FolderGit2, Link2, ListTodo, Settings } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  useProjectGitAutoFetch,
  useProjectGitGraph,
  useProjectGitStatus,
} from '@/hooks/use-project-git';
import { ActiveTasksSummary } from './active-tasks-summary';
import { BranchSyncRow } from './branch-sync-row';
import { GitGraph } from './git-graph';
import { ProjectLogoBackground } from '@/features/project/ui-project-logo';
import { useOverlaysStore } from '@/stores/overlays';
import { useProject } from '@/hooks/use-projects';
import { useSetBacklogSelectedProjectId } from '@/stores/backlog-overlay-draft';
import { WorkingTreeSummary } from './working-tree-summary';

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-ink-2 text-[11px] font-semibold tracking-wide uppercase">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ProjectPanel({ projectId }: { projectId: string }) {
  const { data: project, isLoading: isLoadingProject } = useProject(projectId);
  const openSettingsForProject = useOverlaysStore(
    (state) => state.openSettingsForProject,
  );
  const open = useOverlaysStore((state) => state.open);
  const setBacklogProjectId = useSetBacklogSelectedProjectId();

  const { data: status, isLoading: isLoadingStatus } =
    useProjectGitStatus(projectId);
  const { data: graphRows = [], isLoading: isLoadingGraph } =
    useProjectGitGraph(projectId);

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
      <header className="border-line-soft relative shrink-0 overflow-hidden border-b px-5 py-4">
        <ProjectLogoBackground project={project} showColorFallback />
        <div className="relative z-10 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-ink-0 truncate text-base font-semibold">
              {project.name}
            </h2>
            <p className="text-ink-2 mt-0.5 truncate font-mono text-xs">
              {project.path}
            </p>
            {status?.remoteUrl && (
              <p className="text-ink-3 mt-0.5 flex items-center gap-1 truncate text-xs">
                <Link2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{status.remoteUrl}</span>
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={openBacklogForProject}
              className="border-glass-border text-ink-1 hover:border-glass-border-strong hover:bg-glass-light hover:text-ink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
            >
              <ListTodo size={12} />
              <span>Backlog</span>
            </button>
            <button
              type="button"
              onClick={() => openSettingsForProject(projectId)}
              className="border-glass-border text-ink-1 hover:border-glass-border-strong hover:bg-glass-light hover:text-ink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors"
            >
              <Settings size={12} />
              <span>Settings</span>
            </button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">
        {!isGitRepository ? (
          <div className="border-line-soft text-ink-3 flex flex-col items-center gap-2 rounded-lg border px-4 py-8 text-center text-sm">
            <FolderGit2 className="text-ink-3 h-5 w-5" />
            <p className="text-ink-1">Not a git repository</p>
            <p className="text-xs">
              Git status, branches and history are unavailable for this project.
            </p>
          </div>
        ) : (
          <>
            <Section title="Branch">
              {status ? (
                <BranchSyncRow projectId={projectId} status={status} />
              ) : (
                <p className="text-ink-3 text-xs">
                  {isLoadingStatus ? 'Loading git status…' : 'Unavailable'}
                </p>
              )}
            </Section>

            <Section title="Working tree">
              {status ? (
                <WorkingTreeSummary status={status} />
              ) : (
                <p className="text-ink-3 text-xs">
                  {isLoadingStatus ? 'Loading…' : 'Unavailable'}
                </p>
              )}
            </Section>
          </>
        )}

        <Section title="Active tasks">
          <ActiveTasksSummary projectId={projectId} />
        </Section>

        {isGitRepository && (
          <Section title="History">
            <GitGraph rows={graphRows} isLoading={isLoadingGraph} />
          </Section>
        )}
      </div>
    </div>
  );
}
