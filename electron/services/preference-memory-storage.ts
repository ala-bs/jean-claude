import {
  ensureAgentMemoryProjectsDirectory,
  getAgentMemoryProjectsDir,
  getProjectAgentMemoryDir,
  isUnsafeAgentMemoryPathError,
  writeProjectAgentMemoryMetadata,
} from './agent-memory-storage';

export class UnsafePreferenceMemoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePreferenceMemoryPathError';
  }
}

export function isUnsafePreferenceMemoryPathError(
  error: unknown,
): error is UnsafePreferenceMemoryPathError {
  return error instanceof UnsafePreferenceMemoryPathError;
}

function compatibilityError(error: unknown): never {
  if (isUnsafeAgentMemoryPathError(error)) {
    const message = error.message.startsWith('Unsafe symlink')
      ? error.message.replaceAll('agent memory', 'project memory')
      : error.message.replaceAll('agent memory', 'preference memory');
    throw new UnsafePreferenceMemoryPathError(
      message,
    );
  }
  throw error;
}

export const getPreferenceMemoryProjectsDir = getAgentMemoryProjectsDir;
export const getProjectPreferenceMemoryDir = getProjectAgentMemoryDir;

export async function ensurePreferenceMemoryProjectsDirectory(
  homeDirectory?: string,
): Promise<void> {
  try {
    await ensureAgentMemoryProjectsDirectory(homeDirectory);
  } catch (error) {
    compatibilityError(error);
  }
}

export async function writeProjectPreferenceMemoryMetadata(params: {
  projectId: string;
  name: string;
  sourcePath: string;
  homeDirectory?: string;
  projectMemoryDir?: string;
}): Promise<void> {
  try {
    await writeProjectAgentMemoryMetadata(params);
  } catch (error) {
    compatibilityError(error);
  }
}
