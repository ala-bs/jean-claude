/**
 * Resolves the git start point to use when creating a worktree, pulling the
 * source branch from origin first when possible.
 *
 * A source branch does not always exist on origin: creating a sub-task from a
 * PR/review worktree uses that worktree's local-only branch. In that case the
 * fetch fails with "couldn't find remote ref" and we fall back to the local
 * branch instead of failing task creation.
 */

type GitRunner = (args: string[], cwd: string) => Promise<string>;

const MISSING_REMOTE_REF_PATTERNS = [
  "couldn't find remote ref",
  'no such ref',
  'not found in upstream origin',
];

function isMissingRemoteRefError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return MISSING_REMOTE_REF_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

export async function resolveSourceBranchStartPoint({
  repoPath,
  sourceBranch,
  runGit,
  debug,
}: {
  repoPath: string;
  sourceBranch: string;
  runGit: GitRunner;
  debug?: (message: string, ...args: unknown[]) => void;
}): Promise<string> {
  const remoteBranch = sourceBranch.startsWith('origin/')
    ? sourceBranch.slice('origin/'.length)
    : sourceBranch;

  try {
    await runGit(
      [
        'fetch',
        'origin',
        `+refs/heads/${remoteBranch}:refs/remotes/origin/${remoteBranch}`,
      ],
      repoPath,
    );
  } catch (error) {
    // Only a genuinely missing remote ref is recoverable. Network/auth
    // failures must surface, otherwise we would silently branch off a stale
    // local commit.
    if (!isMissingRemoteRefError(error)) throw error;

    // Prefer an already-fetched remote-tracking ref over the local branch:
    // it is at least as fresh as the local one.
    const remoteTracking = await runGit(
      [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${remoteBranch}`,
      ],
      repoPath,
    ).catch(() => '');
    if (remoteTracking) {
      debug?.(
        'Source branch %s missing on origin, using cached origin/%s',
        remoteBranch,
        remoteBranch,
      );
      return `origin/${remoteBranch}`;
    }

    const localExists = await runGit(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${remoteBranch}`],
      repoPath,
    ).catch(() => '');
    if (!localExists) throw error;

    debug?.(
      'Source branch %s does not exist on origin, using local branch as start point',
      remoteBranch,
    );
    return remoteBranch;
  }

  const currentBranch = await runGit(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoPath,
  );

  if (currentBranch === sourceBranch) {
    await runGit(['pull', '--ff-only', 'origin', remoteBranch], repoPath);
    return sourceBranch;
  }

  return `origin/${remoteBranch}`;
}
