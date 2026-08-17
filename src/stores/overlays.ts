// Global overlay state - only one overlay can be open at a time
// Opening an overlay automatically closes any other open overlay

import { create } from 'zustand';

export type OverlayType =
  | 'new-task'
  | 'command-palette'
  | 'project-switcher'
  | 'activity-center'
  | 'settings'
  | 'backlog'
  | 'azure-board'
  | 'pipelines'
  | 'running-commands'
  | 'calendar'
  | 'usage'
  | 'work-activity'
  | 'resources'
  | 'learning-center';

interface OverlaysState {
  // Current active overlay (null = none open)
  activeOverlay: OverlayType | null;
  runningCommandTarget: { taskId: string; runCommandId: string } | null;

  // Actions
  open: (overlay: OverlayType) => void;
  openRunningCommands: (target: {
    taskId: string;
    runCommandId: string;
  }) => void;
  clearRunningCommandTargetForTask: (taskId: string) => void;
  close: (overlay: OverlayType) => void;
  toggle: (overlay: OverlayType) => void;
  closeAll: () => void;
}

export const useOverlaysStore = create<OverlaysState>((set) => ({
  activeOverlay: null,
  runningCommandTarget: null,

  open: (overlay) =>
    set((s) =>
      s.activeOverlay === overlay
        ? s
        : {
            activeOverlay: overlay,
            runningCommandTarget: null,
          },
    ),
  openRunningCommands: (target) =>
    set({ activeOverlay: 'running-commands', runningCommandTarget: target }),
  clearRunningCommandTargetForTask: (taskId) =>
    set((s) =>
      s.runningCommandTarget?.taskId === taskId
        ? {
            activeOverlay:
              s.activeOverlay === 'running-commands' ? null : s.activeOverlay,
            runningCommandTarget: null,
          }
        : s,
    ),
  close: (overlay) =>
    set((s) =>
      s.activeOverlay === overlay
        ? {
            activeOverlay: null,
            runningCommandTarget:
              overlay === 'running-commands' ? null : s.runningCommandTarget,
          }
        : s,
    ),
  toggle: (overlay) =>
    set((s) => ({
      activeOverlay: s.activeOverlay === overlay ? null : overlay,
      runningCommandTarget: null,
    })),
  closeAll: () =>
    set((s) =>
      s.activeOverlay === null && s.runningCommandTarget === null
        ? s
        : { activeOverlay: null, runningCommandTarget: null },
    ),
}));
