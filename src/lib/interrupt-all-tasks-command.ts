import type { ConfirmModalOptions } from '@/common/context/modal/types';

export function createInterruptAllTasksCommand({
  confirm,
  addToast,
  stopAllAgentTasks,
  stopAllRunCommands,
}: {
  confirm: (options: ConfirmModalOptions) => void;
  addToast: (toast: { message: string; type: 'error' | 'success' }) => void;
  stopAllAgentTasks: () => Promise<void>;
  stopAllRunCommands: () => Promise<void>;
}) {
  return {
    label: 'Interrupt All Tasks',
    section: 'Task',
    keywords: [
      'stop',
      'cancel',
      'interrupt',
      'running',
      'agents',
      'tasks',
      'shell',
      'commands',
    ],
    handler: () => {
      confirm({
        title: 'Interrupt All Tasks',
        content: 'This will stop all running agent tasks and shell commands.',
        confirmLabel: 'Interrupt All',
        variant: 'danger',
        onConfirm: async () => {
          const results = await Promise.allSettled([
            Promise.resolve().then(stopAllAgentTasks),
            Promise.resolve().then(stopAllRunCommands),
          ]);
          if (results.some((result) => result.status === 'rejected')) {
            addToast({
              type: 'error',
              message: 'Failed to interrupt all tasks',
            });
          }
        },
      });
    },
  };
}
