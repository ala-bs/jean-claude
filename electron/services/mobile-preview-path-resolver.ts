import { isAbsolute, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

function isSameOrChildPath(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

export async function resolvePathInsideRoot({
  rootPath,
  relativePath,
}: {
  rootPath: string;
  relativePath: string;
}): Promise<string> {
  if (!relativePath.trim() || isAbsolute(relativePath)) {
    throw new Error('App path must be a relative path');
  }

  const canonicalRoot = await realpath(rootPath);
  const resolvedPath = resolve(canonicalRoot, relativePath);
  if (!isSameOrChildPath(canonicalRoot, resolvedPath)) {
    throw new Error('App path is outside task scope');
  }

  const canonicalPath = await realpath(resolvedPath);
  if (!isSameOrChildPath(canonicalRoot, canonicalPath)) {
    throw new Error('App path resolves outside task scope');
  }
  return canonicalPath;
}

async function getGitRepositoryIdentity(repositoryPath: string): Promise<{
  commonDir: string;
  topLevel: string;
}> {
  const { stdout } = await execFileAsync(
    'git',
    [
      '-C',
      repositoryPath,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--show-toplevel',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  const [commonDir, topLevel] = stdout.trim().split('\n');
  if (!commonDir || !topLevel) throw new Error('Invalid git repository identity');
  return {
    commonDir: await realpath(commonDir),
    topLevel: await realpath(topLevel),
  };
}

export async function resolveTrustedTaskRoot({
  projectPath,
  worktreePath,
  getRepositoryIdentity = getGitRepositoryIdentity,
}: {
  projectPath: string;
  worktreePath: string | null;
  getRepositoryIdentity?: typeof getGitRepositoryIdentity;
}): Promise<string> {
  const canonicalProjectPath = await realpath(projectPath);
  if (!worktreePath) return canonicalProjectPath;

  const canonicalWorktreePath = await realpath(worktreePath);
  if (canonicalWorktreePath === canonicalProjectPath) return canonicalProjectPath;

  try {
    const [projectIdentity, worktreeIdentity] = await Promise.all([
      getRepositoryIdentity(canonicalProjectPath),
      getRepositoryIdentity(canonicalWorktreePath),
    ]);
    const projectSubdirectory = relative(
      projectIdentity.topLevel,
      canonicalProjectPath,
    );
    if (
      worktreeIdentity.topLevel !== canonicalWorktreePath ||
      projectIdentity.commonDir !== worktreeIdentity.commonDir ||
      !isSameOrChildPath(projectIdentity.topLevel, canonicalProjectPath)
    ) {
      throw new Error('Task worktree does not belong to project repository');
    }
    const mappedProjectPath = await realpath(
      resolve(canonicalWorktreePath, projectSubdirectory),
    );
    if (!isSameOrChildPath(canonicalWorktreePath, mappedProjectPath)) {
      throw new Error('Task worktree does not contain project subdirectory');
    }
    return mappedProjectPath;
  } catch {
    throw new Error('Task worktree does not belong to project repository');
  }
}
