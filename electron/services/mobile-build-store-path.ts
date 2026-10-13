import { dirname, resolve } from 'node:path';

/**
 * Converts Git's common-dir result into the main repository root.
 *
 * Git returns `.git` for a regular checkout unless an absolute path format is
 * requested, while worktrees return the shared repository's absolute `.git`
 * directory. Resolving before taking dirname handles both forms.
 */
export function repositoryPathFromGitCommonDir(
  projectPath: string,
  commonDir: string,
): string | null {
  const trimmed = commonDir.trim();
  if (!trimmed) return null;
  return dirname(resolve(projectPath, trimmed));
}
