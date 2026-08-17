import { afterEach, describe, expect, it } from 'vitest';

import { useOverlaysStore } from './overlays';

describe('overlays store', () => {
  afterEach(() => {
    useOverlaysStore.setState({
      activeOverlay: null,
      runningCommandTarget: null,
    });
  });

  it('does not notify subscribers for redundant overlay state changes', () => {
    let notifications = 0;
    const unsubscribe = useOverlaysStore.subscribe(() => {
      notifications += 1;
    });

    useOverlaysStore.getState().open('settings');
    useOverlaysStore.getState().open('settings');
    useOverlaysStore.getState().close('new-task');
    useOverlaysStore.getState().close('settings');
    useOverlaysStore.getState().close('settings');
    useOverlaysStore.getState().closeAll();

    unsubscribe();

    expect(notifications).toBe(2);
  });

  it('opens running commands with a target atomically and clears it on close', () => {
    const target = { taskId: 'task-1', runCommandId: 'command-1' };
    let notifications = 0;
    const unsubscribe = useOverlaysStore.subscribe(() => {
      notifications += 1;
    });

    useOverlaysStore.getState().openRunningCommands(target);

    expect(useOverlaysStore.getState()).toMatchObject({
      activeOverlay: 'running-commands',
      runningCommandTarget: target,
    });
    expect(notifications).toBe(1);

    useOverlaysStore.getState().close('running-commands');
    unsubscribe();

    expect(useOverlaysStore.getState()).toMatchObject({
      activeOverlay: null,
      runningCommandTarget: null,
    });
  });

  it('preserves a target when the running commands overlay is opened again', () => {
    const target = {
      taskId: 'task-1',
      runCommandId: 'command-1',
    };
    useOverlaysStore.getState().openRunningCommands({
      ...target,
    });
    useOverlaysStore.getState().open('running-commands');

    expect(useOverlaysStore.getState()).toMatchObject({
      activeOverlay: 'running-commands',
      runningCommandTarget: target,
    });
  });

  it('clears only a deleted task running-command target', () => {
    useOverlaysStore.getState().openRunningCommands({
      taskId: 'task-1',
      runCommandId: 'command-1',
    });

    useOverlaysStore.getState().clearRunningCommandTargetForTask('task-2');
    expect(useOverlaysStore.getState().activeOverlay).toBe('running-commands');

    useOverlaysStore.getState().clearRunningCommandTargetForTask('task-1');
    expect(useOverlaysStore.getState()).toMatchObject({
      activeOverlay: null,
      runningCommandTarget: null,
    });
  });
});
