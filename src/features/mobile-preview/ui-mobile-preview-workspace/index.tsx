import {
  deriveMobilePreviewRuntimes,
  getMobilePreviewAppPath,
  type MobilePreviewRuntime,
  resolveMobilePreviewRuntime,
} from '../utils-mobile-preview-runtimes';
import {
  getMobilePreviewWorkspaceSelectionUpdate,
  handleMobilePreviewWorkspaceEscape,
  MOBILE_PREVIEW_WORKSPACE_KEYBOARD_LAYER_OPTIONS,
} from '../utils-mobile-preview-workspace';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProjects, useUpdateProject } from '@/hooks/use-projects';
import { createMobilePreviewRuntimeKey } from '@/lib/mobile-preview-runtime';
import { getMobilePreviewConfigForApp } from '../utils-mobile-preview-app-selection';
import { MobilePreviewPane } from '@/features/task/ui-task-panel/mobile-preview-pane';
import { useCommands } from '@/common/hooks/use-commands';
import { useKeyboardLayer } from '@/common/context/keyboard-bindings';
import { useMobilePreviewWorkspaceStore } from '@/stores/mobile-preview-workspace';
import { useTaskMessagesStore } from '@/stores/task-messages';
import { useTasks } from '@/hooks/use-tasks';

export function MobilePreviewWorkspace({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const appSelectionRequestRef = useRef(0);
  const appSelectionPendingRef = useRef(false);
  const [isSelectingAppPath, setIsSelectingAppPath] = useState(false);
  const [appSelectionError, setAppSelectionError] = useState<string | null>(
    null,
  );
  const currentTaskId = taskId;
  const { data: tasks, isLoading: isLoadingTasks } = useTasks();
  const { data: projects, isLoading: isLoadingProjects } = useProjects();
  const runCommandRunning = useTaskMessagesStore(
    (state) => state.runCommandRunning,
  );
  const areRunCommandStatusesHydrated = useTaskMessagesStore(
    (state) => state.areRunCommandStatusesHydrated,
  );
  const selectedRuntimeKey = useMobilePreviewWorkspaceStore(
    (state) => state.selectedRuntimeKey,
  );
  const selectRuntime = useMobilePreviewWorkspaceStore(
    (state) => state.selectRuntime,
  );
  const moveRuntimeSelection = useMobilePreviewWorkspaceStore(
    (state) => state.moveRuntimeSelection,
  );
  const updateProject = useUpdateProject();
  const keyboardLayer = useKeyboardLayer(
    'overlay',
    MOBILE_PREVIEW_WORKSPACE_KEYBOARD_LAYER_OPTIONS,
  );
  const [selectedRuntimeSnapshot, setSelectedRuntimeSnapshot] =
    useState<MobilePreviewRuntime | null>(null);

  const runtimes = useMemo(
    () =>
      deriveMobilePreviewRuntimes({
        tasks,
        projects,
        runCommandRunning,
        currentTaskId,
        selectedRuntimeKey,
        selectedRuntimeSnapshot,
      }).filter((runtime) => runtime.taskId === currentTaskId),
    [
      currentTaskId,
      projects,
      runCommandRunning,
      selectedRuntimeKey,
      selectedRuntimeSnapshot,
      tasks,
    ],
  );
  const selectedRuntime = useMemo(
    () =>
      resolveMobilePreviewRuntime({
        runtimes,
        selectedRuntimeKey,
        currentTaskId,
      }),
    [currentTaskId, runtimes, selectedRuntimeKey],
  );

  const isMetadataReady = !isLoadingTasks && !isLoadingProjects;

  useEffect(() => {
    let active = true;
    if (
      selectedRuntime?.key === selectedRuntimeKey &&
      selectedRuntime.isRunning &&
      (selectedRuntimeSnapshot?.key !== selectedRuntime.key ||
        selectedRuntimeSnapshot.port !== selectedRuntime.port ||
        selectedRuntimeSnapshot.commandStatus?.pid !==
          selectedRuntime.commandStatus?.pid)
    ) {
      queueMicrotask(() => {
        if (active) setSelectedRuntimeSnapshot(selectedRuntime);
      });
      return () => {
        active = false;
      };
    }
    if (
      selectedRuntimeSnapshot &&
      selectedRuntimeSnapshot.key !== selectedRuntimeKey
    ) {
      queueMicrotask(() => {
        if (active) setSelectedRuntimeSnapshot(null);
      });
    }
    return () => {
      active = false;
    };
  }, [selectedRuntime, selectedRuntimeKey, selectedRuntimeSnapshot]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setAppSelectionError(null);
    });
    return () => {
      active = false;
    };
  }, [selectedRuntimeKey]);

  useEffect(
    () => () => {
      appSelectionRequestRef.current += 1;
      appSelectionPendingRef.current = false;
    },
    [],
  );

  useEffect(() => {
    const selectionUpdate = getMobilePreviewWorkspaceSelectionUpdate({
      isMetadataReady,
      areRunCommandStatusesHydrated,
      selectedRuntimeKey,
      resolvedRuntimeKey: selectedRuntime?.key ?? null,
    });
    if (selectionUpdate !== undefined) selectRuntime(selectionUpdate);
  }, [
    areRunCommandStatusesHydrated,
    isMetadataReady,
    selectRuntime,
    selectedRuntime?.key,
    selectedRuntimeKey,
  ]);

  useCommands(
    'mobile-preview-workspace',
    [
      {
        label: 'Close Mobile Preview',
        shortcut: 'escape',
        hideInCommandPalette: true,
        handler: () => handleMobilePreviewWorkspaceEscape(onClose),
      },
    ],
    { layer: keyboardLayer },
  );

  const handleSelectAppPath = useCallback(
    (selectedAppPath: string | null) => {
      if (
        !selectedRuntime?.isContextAvailable ||
        selectedRuntime.isRunning ||
        selectedRuntime.taskId !== currentTaskId ||
        !selectedRuntime.mobileConfig ||
        appSelectionPendingRef.current
      ) {
        return;
      }
      const requestId = appSelectionRequestRef.current + 1;
      const requestRuntimeKey = selectedRuntime.key;
      const nextMobilePreviewConfig = getMobilePreviewConfigForApp({
        config: selectedRuntime.mobileConfig,
        selectedAppPath,
      });
      const nextRuntimeKey = createMobilePreviewRuntimeKey({
        taskId: selectedRuntime.taskId,
        appPath: getMobilePreviewAppPath(nextMobilePreviewConfig),
      });
      appSelectionRequestRef.current = requestId;
      appSelectionPendingRef.current = true;
      setIsSelectingAppPath(true);
      setAppSelectionError(null);
      void updateProject
        .mutateAsync({
          id: selectedRuntime.projectId,
          data: {
            mobilePreviewConfig: nextMobilePreviewConfig,
          },
        })
        .then(() => {
          if (appSelectionRequestRef.current !== requestId) return;
          moveRuntimeSelection(requestRuntimeKey, nextRuntimeKey);
        })
        .catch((error: unknown) => {
          if (
            appSelectionRequestRef.current !== requestId ||
            useMobilePreviewWorkspaceStore.getState().selectedRuntimeKey !==
              requestRuntimeKey
          ) {
            return;
          }
          setAppSelectionError(
            error instanceof Error
              ? error.message
              : 'Failed to update mobile project app',
          );
        })
        .finally(() => {
          if (appSelectionRequestRef.current !== requestId) return;
          appSelectionPendingRef.current = false;
          setIsSelectingAppPath(false);
        });
    },
    [currentTaskId, moveRuntimeSelection, selectedRuntime, updateProject],
  );

  const selectedTask = selectedRuntime?.isContextAvailable
    ? tasks?.find((task) => task.id === selectedRuntime.taskId)
    : null;
  const selectedProject = selectedRuntime?.isContextAvailable
    ? projects?.find((project) => project.id === selectedRuntime.projectId)
    : null;
  const canSelectProjectApp =
    !!selectedRuntime?.isContextAvailable && !selectedRuntime.isRunning;

  return (
    <section
      ref={workspaceRef}
      tabIndex={-1}
      className="bg-bg-0 flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      aria-label="Mobile preview workspace"
    >
      {!selectedRuntime ? (
        <div className="text-ink-4 flex h-full items-center justify-center p-8 text-center text-sm">
          Enable mobile preview on this project or start a mobile dev server.
        </div>
      ) : !selectedRuntime.isContextAvailable ||
        !selectedTask ||
        !selectedProject ? (
        <div className="text-ink-3 flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
          <span className="text-sm font-medium">Loading runtime context</span>
          <span className="font-mono text-[10px]">
            {selectedRuntime.taskId} · {selectedRuntime.appPath} :
            {selectedRuntime.port}
          </span>
        </div>
      ) : (
        <MobilePreviewPane
          key={selectedRuntime.key}
          taskId={selectedRuntime.taskId}
          projectId={selectedRuntime.projectId}
          projectPath={selectedTask.worktreePath ?? selectedProject.path}
          mobilePreviewConfig={selectedRuntime.mobileConfig ?? undefined}
          appPathOverride={selectedRuntime.appPath}
          metroPortOverride={selectedRuntime.port}
          metroStatusOverride={selectedRuntime.commandStatus ?? undefined}
          autoLaunchRunningRuntime={selectedRuntime.isRunning}
          isSelectingAppPath={isSelectingAppPath}
          appSelectionError={appSelectionError}
          retainSessions
          variant="standalone"
          onSelectAppPath={canSelectProjectApp ? handleSelectAppPath : undefined}
        />
      )}
    </section>
  );
}
