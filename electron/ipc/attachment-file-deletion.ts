import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Resolve whether a path is inside the project's managed attachment directory.
 *
 * Attachments do not always live there: oversized files are attached by their
 * original path without being copied (see `processAttachmentFile`). Those must
 * never be deleted, so deletion is scoped to `<projectPath>/.jean-claude/tmp`.
 */
export function isManagedAttachmentPath({
  projectPath,
  filePath,
}: {
  projectPath: string;
  filePath: string;
}): boolean {
  if (!projectPath || !filePath) return false;

  const tmpDir = path.resolve(projectPath, '.jean-claude', 'tmp');
  const resolved = path.resolve(filePath);

  return resolved !== tmpDir && resolved.startsWith(tmpDir + path.sep);
}

/**
 * Delete an unsent attachment file. Returns false when the path is outside the
 * managed tmp dir (refused) or deletion failed; a missing file counts as success.
 */
export async function deleteAttachmentFile({
  projectPath,
  filePath,
  unlink = fs.unlink,
}: {
  projectPath: string;
  filePath: string;
  unlink?: (target: string) => Promise<void>;
}): Promise<boolean> {
  if (!isManagedAttachmentPath({ projectPath, filePath })) return false;

  try {
    await unlink(path.resolve(filePath));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
}
