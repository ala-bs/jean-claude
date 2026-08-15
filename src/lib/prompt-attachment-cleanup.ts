import type { PromptFilePart } from '@shared/agent-backend-types';

/**
 * Best-effort removal of unsent attachment files from disk.
 *
 * The main process refuses anything outside `<projectPath>/.jean-claude/tmp`,
 * so attachments that reference a user's original file (oversized drops, which
 * are never copied) are left untouched.
 */
export async function deleteAttachmentFiles({
  projectPath,
  files,
}: {
  projectPath: string | null | undefined;
  files: PromptFilePart[] | undefined;
}): Promise<void> {
  // Array check, not just length: persisted state is user-editable JSON, and a
  // malformed `files` value must not throw here.
  if (!projectPath || !Array.isArray(files) || files.length === 0) return;

  await Promise.all(
    files.map((file) =>
      window.api.fs
        .deleteAttachmentFile(projectPath, file.filePath)
        .catch((err: unknown) => {
          console.error('Failed to delete attachment file:', err);
        }),
    ),
  );
}

/**
 * Returns the paths that no longer exist on disk (deleted by hand, tmp cleaned).
 * Callers drop these silently — the user can simply re-attach.
 */
export async function findMissingAttachmentPaths(
  files: PromptFilePart[],
): Promise<Set<string>> {
  if (!Array.isArray(files) || files.length === 0) return new Set();

  const checks = await Promise.all(
    files.map(async (file) => {
      try {
        return (await window.api.fs.getFileSize(file.filePath)) !== null;
      } catch {
        return false;
      }
    }),
  );

  return new Set(
    files.filter((_, index) => !checks[index]).map((file) => file.filePath),
  );
}
