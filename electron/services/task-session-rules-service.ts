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
