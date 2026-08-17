import { useCallback, useEffect } from 'react';

import {
  ModalArbitrationScope,
  useModalArbitration,
} from '@/common/context/modal-arbitration';
import { type OverlayType, useOverlaysStore } from '@/stores/overlays';
import { ActivityCenterOverlay } from '@/features/activity-center/ui-activity-center-overlay';
import { AzureBoardOverlay } from '@/features/work-item/ui-azure-board-overlay';
import { BacklogOverlay } from '@/features/project/ui-backlog-overlay';
import { CalendarOverlay } from '@/features/calendar/ui-calendar-overlay';
import { CommandPaletteOverlay } from '@/features/command-palette/ui-command-palette-overlay';
import { LearningCenterOverlay } from '@/features/onboarding/ui-learning-center-overlay';
import { NewTaskOverlay } from '@/features/new-task/ui-new-task-overlay';
import { PipelinesOverlay } from '@/features/pipelines/ui-pipelines-overlay';
import { ProjectOverlay } from '@/features/project/ui-project-overlay';
import { ResourcesOverlay } from '@/features/resources/ui-resources-overlay';
import { RunningCommandsOverlay } from '@/features/run-commands/ui-running-commands-overlay';
import { SettingsOverlay } from '@/features/settings/ui-settings-overlay';
import { UsageOverlay } from '@/features/usage/ui-usage-overlay';
import { useCurrentVisibleProject } from '@/stores/navigation';
import { useNewTaskDraft } from '@/stores/new-task-draft';
import { WorkActivityOverlay } from '@/features/work-activity/ui-work-activity-overlay';

const RENDERED_OVERLAYS = new Set<string>([
  'new-task',
  'command-palette',
  'project-switcher',
  'activity-center',
  'calendar',
  'settings',
  'usage',
  'work-activity',
  'resources',
  'backlog',
  'azure-board',
  'running-commands',
  'pipelines',
  'learning-center',
] satisfies OverlayType[]);

export function OverlayHost() {
  const activeOverlay = useOverlaysStore((state) => state.activeOverlay);
  const close = useOverlaysStore((state) => state.close);
  const closeAll = useOverlaysStore((state) => state.closeAll);
  const rendersActiveOverlay =
    activeOverlay !== null && RENDERED_OVERLAYS.has(activeOverlay);
  const ownsArbitration = useModalArbitration(rendersActiveOverlay, 60);

  useEffect(() => {
    if (activeOverlay !== null && !rendersActiveOverlay) closeAll();
  }, [activeOverlay, closeAll, rendersActiveOverlay]);

  if (!rendersActiveOverlay || !ownsArbitration) return null;

  let overlay = null;
  switch (activeOverlay) {
    case 'new-task':
      overlay = <NewTaskOverlayContainer />;
      break;
    case 'command-palette':
      overlay = <CommandPaletteOverlay onClose={() => close('command-palette')} />;
      break;
    case 'project-switcher':
      overlay = <ProjectOverlay onClose={() => close('project-switcher')} />;
      break;
    case 'activity-center':
      overlay = <ActivityCenterOverlay onClose={() => close('activity-center')} />;
      break;
    case 'calendar':
      overlay = <CalendarOverlay onClose={() => close('calendar')} />;
      break;
    case 'settings':
      overlay = <SettingsOverlay onClose={() => close('settings')} />;
      break;
    case 'usage':
      overlay = <UsageOverlay onClose={() => close('usage')} />;
      break;
    case 'work-activity':
      overlay = <WorkActivityOverlay onClose={() => close('work-activity')} />;
      break;
    case 'resources':
      overlay = <ResourcesOverlay onClose={() => close('resources')} />;
      break;
    case 'backlog':
      overlay = <BacklogOverlay onClose={() => close('backlog')} />;
      break;
    case 'azure-board':
      overlay = <AzureBoardOverlay onClose={() => close('azure-board')} />;
      break;
    case 'running-commands':
      overlay = <RunningCommandsOverlay onClose={() => close('running-commands')} />;
      break;
    case 'pipelines':
      overlay = <PipelinesOverlay onClose={() => close('pipelines')} />;
      break;
    case 'learning-center':
      overlay = <LearningCenterOverlay onClose={() => close('learning-center')} />;
      break;
  }

  return <ModalArbitrationScope>{overlay}</ModalArbitrationScope>;
}

function NewTaskOverlayContainer() {
  const close = useOverlaysStore((state) => state.close);
  const { draft, discardDraft, setSelectedProjectId } = useNewTaskDraft();
  const { projectId } = useCurrentVisibleProject();

  useEffect(() => {
    if (projectId === 'all') return;
    if (draft?.backlogTodoIds?.length) return;
    setSelectedProjectId(projectId);
  }, [draft?.backlogTodoIds?.length, projectId, setSelectedProjectId]);

  const handleClose = useCallback(() => close('new-task'), [close]);
  const handleDiscardDraft = useCallback(() => {
    discardDraft();
    close('new-task');
  }, [discardDraft, close]);

  return (
    <NewTaskOverlay onClose={handleClose} onDiscardDraft={handleDiscardDraft} />
  );
}
