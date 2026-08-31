/**
 * Types for the "unused worktrees" maintenance flow.
 *
 * A worktree directory living under a project's worktrees folder is considered
 * unused when no *active* task points at it:
 *
 *   ~/.jean-claude/worktrees/<project>/<worktree>
 *        |
 *        +-- referenced by a running/waiting/open task ---> KEEP
 *        +-- referenced by a user-completed task       ---> UNUSED ('completed-task')
 *        +-- referenced by no task at all              ---> UNUSED ('orphaned')
 */

export type UnusedWorktreeReason = 'orphaned' | 'completed-task';

export interface UnusedWorktreeInfo {
  /** Absolute path of the worktree directory */
  path: string;
  /** Directory name */
  name: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  /** Branch currently checked out in the worktree (null when undetectable) */
  branchName: string | null;
  /** Task that used to own this worktree, when there is one */
  taskId: string | null;
  taskName: string | null;
  reason: UnusedWorktreeReason;
  /** Whether git still tracks this directory as a worktree of the project repo */
  registered: boolean;
  hasUncommittedChanges: boolean;
  unpushedCommits: number;
  /**
   * Git could not report the working state, so unsaved work cannot be ruled
   * out. Callers must treat this as unsafe rather than as "clean".
   */
  stateUnknown: boolean;
  sizeBytes: number;
  /** ISO timestamp of the last modification of the worktree directory */
  lastModifiedAt: string | null;
}

export interface UnusedWorktreeScanResult {
  worktrees: UnusedWorktreeInfo[];
  scannedProjects: number;
  /** Total worktree directories found across all scanned projects */
  totalWorktrees: number;
  /** Worktrees kept because an active task still uses them */
  activeWorktrees: number;
  /** Errors encountered while scanning individual projects */
  errors: { projectName: string; error: string }[];
}

export interface CleanupUnusedWorktreesResult {
  removed: string[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; error: string }[];
  freedBytes: number;
}
