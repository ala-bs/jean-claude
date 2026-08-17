export async function assertProjectPathUnchanged({
  currentPath,
  suppliedPath,
}: {
  currentPath: string;
  suppliedPath: string | undefined;
}): Promise<void> {
  if (suppliedPath === undefined) return;
  if (currentPath !== suppliedPath) {
    throw new Error('Project path cannot be changed');
  }
}

export function omitProjectPath<T extends { path?: unknown }>(
  data: T,
): Omit<T, 'path'> {
  const { path: _suppliedPath, ...safeData } = data;
  return safeData;
}
