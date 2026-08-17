import { stepResourceKey, taskStepsResourceKey } from './domains/steps';
import { cache$ } from './cache-store';
import { markResourceStale } from './cache-actions';
import { taskResourceKey } from './domains/tasks';

export function invalidateTaskStatusResources(taskId: string, stepId: string) {
  const resourceKeys = [
    taskResourceKey(taskId),
    taskStepsResourceKey(taskId),
    stepResourceKey(stepId),
  ];

  for (const resourceKey of resourceKeys) {
    if (cache$.resources[resourceKey].get()) {
      markResourceStale(resourceKey);
    }
  }
}
