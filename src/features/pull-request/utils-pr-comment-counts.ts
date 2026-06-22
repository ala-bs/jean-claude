import type {
  AzureDevOpsCommentThread,
  AzureDevOpsFileChange,
} from '@/lib/api';

export function getCommentCountByPrFile({
  files,
  threads,
}: {
  files: AzureDevOpsFileChange[];
  threads: AzureDevOpsCommentThread[];
}) {
  const filePathByNormalizedPath = new Map(
    files.map((file) => [stripLeadingSlash(file.path), file.path]),
  );
  const counts: Record<string, number> = {};

  for (const thread of threads) {
    if (thread.isDeleted || !thread.threadContext?.filePath) continue;

    const filePath = filePathByNormalizedPath.get(
      stripLeadingSlash(thread.threadContext.filePath),
    );
    if (!filePath) continue;

    counts[filePath] = (counts[filePath] ?? 0) + thread.comments.length;
  }

  return counts;
}

export function getCommentStatusCountByPrFile({
  files,
  threads,
}: {
  files: AzureDevOpsFileChange[];
  threads: AzureDevOpsCommentThread[];
}) {
  const filePathByNormalizedPath = new Map(
    files.map((file) => [stripLeadingSlash(file.path), file.path]),
  );
  const counts: Record<string, { active: number; resolved: number }> = {};

  for (const thread of threads) {
    if (thread.isDeleted || !thread.threadContext?.filePath) continue;

    const filePath = filePathByNormalizedPath.get(
      stripLeadingSlash(thread.threadContext.filePath),
    );
    if (!filePath) continue;

    const existing = counts[filePath] ?? { active: 0, resolved: 0 };
    if (thread.status === 'active') {
      existing.active += thread.comments.length;
    } else {
      existing.resolved += thread.comments.length;
    }
    counts[filePath] = existing;
  }

  return counts;
}

function stripLeadingSlash(value: string) {
  return value.replace(/^\/+/, '');
}
