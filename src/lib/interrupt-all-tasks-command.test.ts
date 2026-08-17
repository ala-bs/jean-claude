import { describe, expect, it, vi } from 'vitest';

import type { ConfirmModalOptions } from '@/common/context/modal/types';
import { createInterruptAllTasksCommand } from './interrupt-all-tasks-command';

function setup({
  agentError,
  runCommandsError,
}: { agentError?: Error; runCommandsError?: Error } = {}) {
  let confirmation: ConfirmModalOptions | undefined;
  const confirm = vi.fn((options: ConfirmModalOptions) => {
    confirmation = options;
  });
  const addToast = vi.fn();
  const stopAllAgentTasks = agentError
    ? vi.fn().mockRejectedValue(agentError)
    : vi.fn().mockResolvedValue(undefined);
  const stopAllRunCommands = runCommandsError
    ? vi.fn().mockRejectedValue(runCommandsError)
    : vi.fn().mockResolvedValue(undefined);
  const command = createInterruptAllTasksCommand({
    confirm,
    addToast,
    stopAllAgentTasks,
    stopAllRunCommands,
  });

  return {
    command,
    confirm,
    addToast,
    stopAllAgentTasks,
    stopAllRunCommands,
    getConfirmation: () => confirmation,
  };
}

describe('createInterruptAllTasksCommand', () => {
  it('provides command palette metadata and opens a danger confirmation', () => {
    const { command, confirm, getConfirmation } = setup();

    expect(command).toMatchObject({
      label: 'Interrupt All Tasks',
      section: 'Task',
      keywords: expect.arrayContaining([
        'stop',
        'cancel',
        'interrupt',
        'tasks',
        'shell',
        'commands',
      ]),
    });

    command.handler();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(getConfirmation()).toMatchObject({
      title: 'Interrupt All Tasks',
      content: 'This will stop all running agent tasks and shell commands.',
      confirmLabel: 'Interrupt All',
      variant: 'danger',
    });
  });

  it('attempts both stop APIs and stays silent when both succeed', async () => {
    const {
      command,
      addToast,
      stopAllAgentTasks,
      stopAllRunCommands,
      getConfirmation,
    } = setup();
    command.handler();

    await getConfirmation()?.onConfirm?.();

    expect(stopAllAgentTasks).toHaveBeenCalledTimes(1);
    expect(stopAllRunCommands).toHaveBeenCalledTimes(1);
    expect(addToast).not.toHaveBeenCalled();
  });

  it.each([
    ['agent API fails', new Error('agent failed'), undefined],
    ['run-command API fails', undefined, new Error('commands failed')],
    [
      'both APIs fail',
      new Error('agent failed'),
      new Error('commands failed'),
    ],
  ])('adds one error toast when %s', async (_, agentError, runCommandsError) => {
    const {
      command,
      addToast,
      stopAllAgentTasks,
      stopAllRunCommands,
      getConfirmation,
    } = setup({ agentError, runCommandsError });
    command.handler();

    await getConfirmation()?.onConfirm?.();

    expect(stopAllAgentTasks).toHaveBeenCalledTimes(1);
    expect(stopAllRunCommands).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'Failed to interrupt all tasks',
    });
  });

  it.each([
    ['first callback throws', true, false],
    ['second callback throws', false, true],
    ['both callbacks throw', true, true],
  ])(
    'attempts both stops and adds one toast when %s synchronously',
    async (_, agentThrows, runCommandsThrows) => {
      const addToast = vi.fn();
      const stopAllAgentTasks = vi.fn(() => {
        if (agentThrows) throw new Error('agent sync failure');
        return Promise.resolve();
      });
      const stopAllRunCommands = vi.fn(() => {
        if (runCommandsThrows) throw new Error('commands sync failure');
        return Promise.resolve();
      });
      let confirmation: ConfirmModalOptions | undefined;
      const testedCommand = createInterruptAllTasksCommand({
        confirm: (options) => {
          confirmation = options;
        },
        addToast,
        stopAllAgentTasks,
        stopAllRunCommands,
      });
      testedCommand.handler();

      await confirmation?.onConfirm?.();

      expect(stopAllAgentTasks).toHaveBeenCalledOnce();
      expect(stopAllRunCommands).toHaveBeenCalledOnce();
      expect(addToast).toHaveBeenCalledOnce();
    },
  );
});
