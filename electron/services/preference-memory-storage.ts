import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

const DIRECT_PROJECT_ID_PATTERN = /^[a-z0-9_-]{1,128}$/;
const RESERVED_FILE_NAME_PATTERN = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/;
const projectOperationTails = new Map<string, Promise<void>>();

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

export function getPreferenceMemoryProjectKey(projectId: string): string {
  if (
    DIRECT_PROJECT_ID_PATTERN.test(projectId) &&
    !RESERVED_FILE_NAME_PATTERN.test(projectId)
  ) {
    return projectId;
  }
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 32);
  return `.hashed-${hash}`;
}

export function getPreferenceMemoryRootDir(
  homeDirectory = os.homedir(),
): string {
  return path.join(homeDirectory, '.jean-claude', 'memory');
}

export function getPreferenceMemoryProjectsDir(
  homeDirectory = os.homedir(),
): string {
  return path.join(getPreferenceMemoryRootDir(homeDirectory), 'projects');
}

export function getProjectPreferenceMemoryDir(
  projectId: string,
  homeDirectory = os.homedir(),
): string {
  return path.join(
    getPreferenceMemoryProjectsDir(homeDirectory),
    getPreferenceMemoryProjectKey(projectId),
  );
}

async function ensureRealDirectory(directoryPath: string): Promise<void> {
  try {
    await fs.mkdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafePreferenceMemoryPathError(
      `Unsafe preference memory directory: ${directoryPath}`,
    );
  }
}

async function assertRealDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UnsafePreferenceMemoryPathError(
        `Unsafe preference memory directory: ${directoryPath}`,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensurePreferenceMemoryProjectsDirectory(
  homeDirectory = os.homedir(),
): Promise<void> {
  const jeanClaudeDir = path.join(homeDirectory, '.jean-claude');
  const memoryDir = getPreferenceMemoryRootDir(homeDirectory);
  const projectsDir = getPreferenceMemoryProjectsDir(homeDirectory);
  await ensureRealDirectory(jeanClaudeDir);
  await ensureRealDirectory(memoryDir);
  await ensureRealDirectory(projectsDir);
}

export async function ensureProjectPreferenceMemoryDirectory({
  projectId,
  homeDirectory = os.homedir(),
  projectMemoryDir = getProjectPreferenceMemoryDir(projectId, homeDirectory),
}: {
  projectId: string;
  homeDirectory?: string;
  projectMemoryDir?: string;
}): Promise<void> {
  await ensurePreferenceMemoryProjectsDirectory(homeDirectory);
  const projectsDir = getPreferenceMemoryProjectsDir(homeDirectory);
  if (path.dirname(path.resolve(projectMemoryDir)) !== path.resolve(projectsDir)) {
    throw new UnsafePreferenceMemoryPathError(
      `Unsafe project memory directory: ${projectMemoryDir}`,
    );
  }
  await ensureRealDirectory(projectMemoryDir);
}

export async function assertSafeProjectPreferenceMemoryTree(
  projectMemoryDir: string,
): Promise<void> {
  const stat = await fs.lstat(projectMemoryDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafePreferenceMemoryPathError(
      `Unsafe project memory path: ${projectMemoryDir}`,
    );
  }

  const entries = await fs.readdir(projectMemoryDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(projectMemoryDir, entry.name);
    const entryStat = await fs.lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new UnsafePreferenceMemoryPathError(
        `Unsafe symlink in project memory: ${entryPath}`,
      );
    }
    if (entryStat.isDirectory()) {
      await assertSafeProjectPreferenceMemoryTree(entryPath);
    } else if (!entryStat.isFile()) {
      throw new UnsafePreferenceMemoryPathError(
        `Unsafe file type in project memory: ${entryPath}`,
      );
    }
  }
}

export async function writeProjectPreferenceMemoryMetadata({
  projectId,
  name,
  sourcePath,
  homeDirectory,
  projectMemoryDir = getProjectPreferenceMemoryDir(projectId, homeDirectory),
}: {
  projectId: string;
  name: string;
  sourcePath: string;
  homeDirectory?: string;
  projectMemoryDir?: string;
}): Promise<void> {
  await ensureProjectPreferenceMemoryDirectory({
    projectId,
    homeDirectory,
    projectMemoryDir,
  });
  await assertSafeProjectPreferenceMemoryTree(projectMemoryDir);

  const metadataPath = path.join(projectMemoryDir, 'project.json');
  const tempPath = path.join(
    projectMemoryDir,
    `.project.json-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(
      tempPath,
      `${JSON.stringify({ id: projectId, name, sourcePath }, null, 2)}\n`,
      { encoding: 'utf-8', flag: 'wx' },
    );
    await fs.rename(tempPath, metadataPath);
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

export async function removeProjectPreferenceMemory({
  projectId,
  homeDirectory,
}: {
  projectId: string;
  homeDirectory?: string;
}): Promise<void> {
  const managedDirectories = [
    path.join(homeDirectory ?? os.homedir(), '.jean-claude'),
    getPreferenceMemoryRootDir(homeDirectory),
    getPreferenceMemoryProjectsDir(homeDirectory),
  ];
  for (const directoryPath of managedDirectories) {
    if (!(await assertRealDirectory(directoryPath))) return;
  }
  const projectMemoryDir = getProjectPreferenceMemoryDir(
    projectId,
    homeDirectory,
  );
  if (!(await assertRealDirectory(projectMemoryDir))) return;
  await fs.rm(projectMemoryDir, {
    force: true,
    recursive: true,
  });
}

export async function withProjectPreferenceMemoryLock<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectOperationTails.get(projectId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  projectOperationTails.set(projectId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (projectOperationTails.get(projectId) === tail) {
      projectOperationTails.delete(projectId);
    }
  }
}
