/* eslint-disable sort-imports */
import { LayoutDashboard, X } from 'lucide-react';
import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import FocusLock from 'react-focus-lock';

import { useKeyboardLayer } from '@/common/context/keyboard-bindings';
import { useCommands } from '@/common/hooks/use-commands';
import { Select } from '@/common/ui/select';
import { AzureBoardProjectContent } from '@/features/work-item/ui-azure-board-overlay/project-content';
import type { ConfiguredAzureBoardProject } from '@/features/work-item/ui-azure-board-overlay/project-content';
import { useActiveProjects } from '@/hooks/use-projects';
import { useAzureBoardStore } from '@/stores/azure-board';

export function AzureBoardOverlay({ onClose }: { onClose: () => void }) {
  const layer = useKeyboardLayer('overlay', {
    exclusive: true,
    passthrough: ['global-nav'],
  });
  useCommands(
    'azure-board-overlay',
    [
      {
        label: 'Close Azure Board',
        shortcut: 'escape',
        handler: onClose,
        hideInCommandPalette: true,
      },
    ],
    { layer },
  );
  const { data: allProjects = [] } = useActiveProjects();
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.workItemProviderId &&
          project.workItemProjectId &&
          project.workItemProjectName,
      ) as ConfiguredAzureBoardProject[],
    [allProjects],
  );
  const selectedProjectId = useAzureBoardStore((state) => state.selectedProjectId);
  const setSelectedProjectId = useAzureBoardStore((state) => state.setSelectedProjectId);
  const project =
    projects.find((candidate) => candidate.id === selectedProjectId) ?? projects[0];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2 pb-2 pt-[54px] backdrop-blur-sm sm:px-5 sm:pb-5">
      <FocusLock returnFocus className="h-full w-full">
        <section
          role="dialog"
          aria-modal="true"
          aria-label="Azure Board"
          className="bg-bg-0 border-line flex h-full w-full flex-col overflow-hidden rounded-xl border shadow-2xl"
        >
          {project ? (
            <>
              <div className="border-line flex min-h-12 items-center gap-2 border-b px-4 py-2.5">
                <LayoutDashboard className="text-acc-ink h-4 w-4" />
                <strong className="text-ink-0 mr-1 text-sm">Work items</strong>
                <Select
                  value={project.id}
                  onChange={setSelectedProjectId}
                  options={projects.map((candidate) => ({
                    value: candidate.id,
                    label: candidate.name,
                  }))}
                />
              </div>
              <AzureBoardProjectContent key={project.id} project={project} onClose={onClose} />
            </>
          ) : (
            <>
              <header className="border-line flex min-h-12 items-center gap-2 border-b px-4 py-2.5">
                <LayoutDashboard className="text-acc-ink h-4 w-4" />
                <strong className="text-ink-0 text-sm">Work items</strong>
                <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink-1 ml-auto rounded p-1" aria-label="Close Azure Board"><X size={17} /></button>
              </header>
              <div className="text-ink-3 grid flex-1 place-items-center text-sm">No projects have Azure Boards configured.</div>
            </>
          )}
        </section>
      </FocusLock>
    </div>,
    document.body,
  );
}
