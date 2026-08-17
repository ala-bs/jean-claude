import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

import { type Kysely } from 'kysely';

import {
  ensurePreferenceMemoryProjectsDirectory,
  getPreferenceMemoryProjectsDir,
  getProjectPreferenceMemoryDir,
  isUnsafePreferenceMemoryPathError,
  UnsafePreferenceMemoryPathError,
  writeProjectPreferenceMemoryMetadata,
} from '../../services/preference-memory-storage';

async function isSafeDirectoryTree(rootPath: string): Promise<boolean> {
  let rootStat;
  try {
    rootStat = await fs.lstat(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const entryStat = await fs.lstat(entryPath);
    if (entryStat.isSymbolicLink()) return false;
    if (entryStat.isDirectory()) {
      if (!(await isSafeDirectoryTree(entryPath))) return false;
    } else if (!entryStat.isFile()) {
      return false;
    }
  }
  return true;
}

async function isSafeLegacyMemorySource(projectPath: string): Promise<boolean> {
  const jeanClaudePath = path.join(projectPath, '.jean-claude');
  const memoryPath = path.join(jeanClaudePath, 'memory');
  try {
    const resolvedProjectPath = await fs.realpath(projectPath);
    const jeanClaudeStat = await fs.lstat(jeanClaudePath);
    if (jeanClaudeStat.isSymbolicLink() || !jeanClaudeStat.isDirectory()) {
      return false;
    }
    const resolvedJeanClaudePath = await fs.realpath(jeanClaudePath);
    if (path.dirname(resolvedJeanClaudePath) !== resolvedProjectPath) {
      return false;
    }

    const memoryStat = await fs.lstat(memoryPath);
    if (memoryStat.isSymbolicLink() || !memoryStat.isDirectory()) return false;
    const resolvedMemoryPath = await fs.realpath(memoryPath);
    if (path.dirname(resolvedMemoryPath) !== resolvedJeanClaudePath) {
      return false;
    }
    return isSafeDirectoryTree(memoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function getDirectoryTreeDigest(rootPath: string): Promise<string> {
  const hash = createHash('sha256');

  async function addDirectory(directoryPath: string): Promise<void> {
    const entries = (await fs.readdir(directoryPath, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(rootPath, entryPath);
      if (entry.isDirectory()) {
        hash.update(`${JSON.stringify(['directory', relativePath])}\n`);
        await addDirectory(entryPath);
      } else {
        const content = await fs.readFile(entryPath);
        const contentDigest = createHash('sha256').update(content).digest('hex');
        hash.update(
          `${JSON.stringify([
            'file',
            relativePath,
            content.byteLength,
            contentDigest,
          ])}\n`,
        );
      }
    }
  }

  await addDirectory(rootPath);
  return hash.digest('hex');
}

function getStagingPath({
  projectKey,
  projectsDir,
}: {
  projectKey: string;
  projectsDir: string;
}): string {
  return path.join(projectsDir, `.staging-${projectKey}`);
}

export async function up(
  db: Kysely<unknown>,
  homeDirectory = os.homedir(),
): Promise<void> {
  const projects = await (
    db as Kysely<{
      projects: { id: string; name: string; path: string };
    }>
  )
    .selectFrom('projects')
    .select(['id', 'name', 'path'])
    .execute();

  const projectsDir = getPreferenceMemoryProjectsDir(homeDirectory);

  for (const project of projects) {
    const sourcePath = path.join(project.path, '.jean-claude', 'memory');
    const destinationPath = getProjectPreferenceMemoryDir(
      project.id,
      homeDirectory,
    );
    const stagingPath = getStagingPath({
      projectKey: path.basename(destinationPath),
      projectsDir,
    });

    if (!(await isSafeLegacyMemorySource(project.path))) continue;
    try {
      await ensurePreferenceMemoryProjectsDirectory(homeDirectory);
    } catch (error) {
      if (!isUnsafePreferenceMemoryPathError(error)) throw error;
      console.warn(
        `Preference memory migration skipped for project ${project.id} because the managed destination is unsafe:`,
        error,
      );
      continue;
    }
    await fs.rm(stagingPath, { force: true, recursive: true });
    if (await pathExists(destinationPath)) {
      if (!(await isSafeDirectoryTree(destinationPath))) {
        console.warn(
          `Preference memory migration skipped for project ${project.id} because the managed destination is unsafe:`,
          new UnsafePreferenceMemoryPathError(
            `Unsafe project memory destination: ${destinationPath}`,
          ),
        );
      }
      continue;
    }
    const sourceDigest = await getDirectoryTreeDigest(sourcePath);

    try {
      await fs.cp(sourcePath, stagingPath, { recursive: true });
      if (!(await isSafeDirectoryTree(stagingPath))) {
        throw new Error(
          `Unsafe symlink or file type in preference memory for project ${project.id}`,
        );
      }
      await writeProjectPreferenceMemoryMetadata({
        projectId: project.id,
        name: project.name,
        sourcePath: project.path,
        homeDirectory,
        projectMemoryDir: stagingPath,
      });
      await fs.rename(stagingPath, destinationPath);
    } catch (error) {
      await fs.rm(stagingPath, { force: true, recursive: true });
      throw error;
    }

    if (!(await isSafeLegacyMemorySource(project.path))) continue;
    if ((await getDirectoryTreeDigest(sourcePath)) !== sourceDigest) {
      console.warn(
        `Preference memory changed during migration for project ${project.id}; preserving legacy source`,
      );
      continue;
    }
    try {
      await fs.rm(sourcePath, { force: true, recursive: true });
    } catch (error) {
      console.warn(
        `Preference memory migrated for project ${project.id}, but legacy source cleanup failed:`,
        error,
      );
    }
  }
}

export async function down(): Promise<void> {
  // File migrations are not reversible without risking data loss.
}
