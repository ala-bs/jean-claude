import type { PermissionScope } from '@shared/permission-types';
import type { Task } from '@shared/types';

import { emitTaskUpsert } from './cache-event-service';
import { TaskRepository } from '../database/repositories';

const taskSessionRuleLocks = new Map<string, Promise<void>>();

export async function withTaskSessionRulesLock<T>(
  taskId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = taskSessionRuleLocks.get(taskId) ?? Promise.resolve();
  taskSessionRuleLocks.set(taskId, next);

  await previous;
  try {
    return await operation();
  } finally {
    release!();
    if (taskSessionRuleLocks.get(taskId) === next) {
      taskSessionRuleLocks.delete(taskId);
    }
  }
}

export async function mutateTaskSessionRules(
  taskId: string,
  mutate: (rules: PermissionScope, task: Task) => PermissionScope,
): Promise<Task> {
  return withTaskSessionRulesLock(taskId, async () => {
    const task = await TaskRepository.findById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const sessionRules = mutate({ ...(task.sessionRules ?? {}) }, task);
    const updatedTask = await TaskRepository.update(taskId, { sessionRules });
    emitTaskUpsert(updatedTask);
    return updatedTask;
  });
}
