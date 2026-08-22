import { CircleAlert, FolderGit2, Search, Trash2 } from 'lucide-react';
import { type MouseEvent, useMemo, useState } from 'react';

import {
  useCleanupUnusedWorktrees,
  useScanUnusedWorktrees,
} from '@/hooks/use-unused-worktrees';
import { Button } from '@/common/ui/button';
import { Checkbox } from '@/common/ui/checkbox';
import { Chip } from '@/common/ui/chip';
import { formatRelativeTime } from '@/lib/time';
import { Modal } from '@/common/ui/modal';
import type { UnusedWorktreeInfo } from '@/lib/api';

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * A worktree is risky to delete when it holds work that exists nowhere else —
 * including when git could not tell us, which must never read as "clean".
 */
function hasUnsavedWork(worktree: UnusedWorktreeInfo): boolean {
  return (
    worktree.hasUncommittedChanges ||
    worktree.unpushedCommits > 0 ||
    worktree.stateUnknown
  );
}

/**
 * Clicking a <label> focuses its control and the browser scrolls that control
 * into view. Checkbox renders its input as `sr-only` (absolutely positioned,
 * `clip: rect(0,0,0,0)`) and each project group has a `sticky` header, so that
 * scroll lands badly and the list jumps. Focus the input ourselves with
 * `preventScroll` instead: no jump, and focus still ends up on the control the
 * user clicked (unlike a bare preventDefault, which would leave it behind).
 */
function focusWithoutScrolling(event: MouseEvent<HTMLElement>) {
  const input = event.currentTarget.querySelector('input');
  if (!input) return;
  event.preventDefault();
  input.focus({ preventScroll: true });
}

type Summary = {
  scannedProjects: number;
  totalWorktrees: number;
  activeWorktrees: number;
  errors: { projectName: string; error: string }[];
};

export function UnusedWorktreesCleanup() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [scanned, setScanned] = useState<UnusedWorktreeInfo[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  // Bumped on every scan so the modal remounts and cannot carry a selection
  // over from a previous, differently-shaped result set.
  const [scanId, setScanId] = useState(0);
  const [message, setMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const scanMutation = useScanUnusedWorktrees();

  const handleScan = async () => {
    setMessage(null);
    try {
      const result = await scanMutation.mutateAsync();
      setScanned(result.worktrees);
      setSummary({
        scannedProjects: result.scannedProjects,
        totalWorktrees: result.totalWorktrees,
        activeWorktrees: result.activeWorktrees,
        errors: result.errors,
      });
      setScanId((id) => id + 1);
      setIsModalOpen(true);
    } catch (error) {
      setScanned(null);
      setSummary(null);
      setMessage({
        type: 'error',
        text: `Scan failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  return (
    <div>
      <h2 className="text-ink-1 text-lg font-semibold">
        Unused Worktrees Cleanup
      </h2>
      <p className="text-ink-3 mt-1 text-sm">
        Scans every project&apos;s worktrees folder under
        ~/.jean-claude/worktrees and lists the worktrees no active task is
        using. Results open in a dialog where you pick what to remove.
      </p>

      <div className="mt-4">
        <Button
          onClick={handleScan}
          disabled={scanMutation.isPending}
          loading={scanMutation.isPending}
          icon={<Search />}
        >
          Scan for Unused Worktrees
        </Button>
      </div>

      {summary && (
        <div className="text-ink-3 mt-3 text-xs">
          Scanned {summary.scannedProjects} project
          {summary.scannedProjects === 1 ? '' : 's'} · {summary.totalWorktrees}{' '}
          worktree{summary.totalWorktrees === 1 ? '' : 's'} total ·{' '}
          {summary.activeWorktrees} in use by active tasks
          {scanned && scanned.length > 0 && (
            <>
              {' · '}
              <button
                type="button"
                className="text-acc-ink underline underline-offset-2"
                onClick={() => setIsModalOpen(true)}
              >
                Review {scanned.length} unused
              </button>
            </>
          )}
        </div>
      )}

      {message && (
        <div
          className={`mt-4 rounded-lg border px-4 py-3 ${
            message.type === 'success'
              ? 'text-status-done border-status-done bg-status-done/30'
              : 'text-status-fail border-status-fail bg-status-fail/30'
          }`}
        >
          <span className="text-sm">{message.text}</span>
        </div>
      )}

      <UnusedWorktreesModal
        key={scanId}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        worktrees={scanned ?? []}
        scanErrors={summary?.errors ?? []}
        onCleaned={(remaining, resultMessage) => {
          setScanned(remaining);
          setMessage(resultMessage);
          if (remaining.length === 0) setIsModalOpen(false);
        }}
      />
    </div>
  );
}

function UnusedWorktreesModal({
  isOpen,
  onClose,
  worktrees,
  scanErrors,
  onCleaned,
}: {
  isOpen: boolean;
  onClose: () => void;
  worktrees: UnusedWorktreeInfo[];
  scanErrors: { projectName: string; error: string }[];
  onCleaned: (
    remaining: UnusedWorktreeInfo[],
    message: { type: 'success' | 'error'; text: string },
  ) => void;
}) {
  const cleanupMutation = useCleanupUnusedWorktrees();

  // Pre-select the worktrees that carry no unsaved work. Keyed off the scan
  // result so a fresh scan resets the selection.
  const defaultSelection = useMemo(
    () =>
      new Set(
        worktrees
          .filter((worktree) => !hasUnsavedWork(worktree))
          .map((worktree) => worktree.path),
      ),
    [worktrees],
  );
  const [overrides, setOverrides] = useState<Set<string> | null>(null);
  const selectedPaths = overrides ?? defaultSelection;

  const groupedByProject = useMemo(() => {
    const groups = new Map<string, UnusedWorktreeInfo[]>();
    for (const worktree of worktrees) {
      const existing = groups.get(worktree.projectName);
      if (existing) existing.push(worktree);
      else groups.set(worktree.projectName, [worktree]);
    }
    return Array.from(groups.entries());
  }, [worktrees]);

  const selectedSize = useMemo(
    () =>
      worktrees
        .filter((worktree) => selectedPaths.has(worktree.path))
        .reduce((total, worktree) => total + worktree.sizeBytes, 0),
    [worktrees, selectedPaths],
  );

  const handleToggle = (path: string) => {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOverrides(next);
  };

  const handleSelectAll = () =>
    setOverrides(new Set(worktrees.map((worktree) => worktree.path)));
  const handleSelectSafe = () => setOverrides(new Set(defaultSelection));
  const handleSelectNone = () => setOverrides(new Set());

  const handleCleanup = async () => {
    // Only submit paths that are actually on screen, so nothing invisible to
    // the user can ever be included in a destructive call.
    const visiblePaths = worktrees
      .map((worktree) => worktree.path)
      .filter((path) => selectedPaths.has(path));
    if (visiblePaths.length === 0) return;

    let result: Awaited<ReturnType<typeof cleanupMutation.mutateAsync>>;
    try {
      result = await cleanupMutation.mutateAsync({ paths: visiblePaths });
    } catch (error) {
      onCleaned(worktrees, {
        type: 'error',
        text: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const parts: string[] = [];
    if (result.removed.length > 0) {
      parts.push(
        `Removed ${result.removed.length} worktree${
          result.removed.length === 1 ? '' : 's'
        } (${formatBytes(result.freedBytes)} freed)`,
      );
    }
    if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
    if (result.failed.length > 0) {
      parts.push(
        `${result.failed.length} failed: ${result.failed
          .map((failure) => failure.error)
          .join('; ')}`,
      );
    }

    // Keep what the user chose, minus what actually went away. Resetting to
    // the defaults here would silently re-arm the items that just failed.
    const removed = new Set(result.removed);
    setOverrides(
      new Set(Array.from(selectedPaths).filter((path) => !removed.has(path))),
    );
    onCleaned(
      worktrees.filter((worktree) => !removed.has(worktree.path)),
      {
        type: result.failed.length > 0 ? 'error' : 'success',
        text: parts.join(' · ') || 'Nothing to remove',
      },
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      title="Unused worktrees"
      closeDisabled={cleanupMutation.isPending}
      closeDisabledReason="Cleanup in progress"
      contentClassName="flex min-h-0 flex-col p-0"
      ariaLabel="Unused worktrees"
    >
      {scanErrors.length > 0 && (
        <div className="border-glass-border border-b bg-amber-400/10 px-4 py-2">
          <div className="text-xs font-semibold text-amber-200">
            {scanErrors.length} project
            {scanErrors.length === 1 ? '' : 's'} could not be scanned
          </div>
          {scanErrors.map((scanError) => (
            <div key={scanError.projectName} className="text-ink-3 text-xs">
              {scanError.projectName}: {scanError.error}
            </div>
          ))}
        </div>
      )}

      {worktrees.length === 0 ? (
        <div className="text-ink-2 p-6 text-sm">
          {scanErrors.length > 0
            ? 'No unused worktrees found in the projects that could be scanned.'
            : 'No unused worktrees found. Everything is clean!'}
        </div>
      ) : (
        <>
          <div className="border-glass-border flex items-center justify-between border-b px-4 py-2">
            <span className="text-ink-2 text-sm">
              {worktrees.length} unused worktree
              {worktrees.length === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-2">
              <Button onClick={handleSelectAll} variant="ghost" size="sm">
                Select all
              </Button>
              <span className="text-ink-4">|</span>
              <Button onClick={handleSelectSafe} variant="ghost" size="sm">
                Select safe
              </Button>
              <span className="text-ink-4">|</span>
              <Button onClick={handleSelectNone} variant="ghost" size="sm">
                Select none
              </Button>
            </div>
          </div>

          <div className="max-h-[55vh] min-h-0 flex-1 overflow-y-auto">
            {groupedByProject.map(([projectName, projectWorktrees]) => (
              <div key={projectName}>
                <div className="text-ink-3 bg-bg-1 sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 text-xs font-semibold">
                  <FolderGit2 className="h-3 w-3" />
                  {projectName}
                </div>
                {projectWorktrees.map((worktree) => (
                  <div
                    key={worktree.path}
                    className="border-glass-border hover:bg-glass-medium/50 flex scroll-mt-9 items-start gap-3 border-b px-4 py-2 last:border-b-0"
                  >
                    <span
                      onMouseDown={focusWithoutScrolling}
                      className="contents"
                    >
                      <Checkbox
                        checked={selectedPaths.has(worktree.path)}
                        onChange={() => handleToggle(worktree.path)}
                        ariaLabel={`Select ${worktree.name}`}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ink-1 truncate font-mono text-sm">
                          {worktree.name}
                        </span>
                        <Chip
                          size="xs"
                          color={
                            worktree.reason === 'orphaned' ? 'purple' : 'blue'
                          }
                        >
                          {worktree.reason === 'orphaned'
                            ? 'no task'
                            : 'completed task'}
                        </Chip>
                        {worktree.hasUncommittedChanges && (
                          <Chip size="xs" color="orange" icon={<CircleAlert />}>
                            uncommitted changes
                          </Chip>
                        )}
                        {worktree.unpushedCommits > 0 && (
                          <Chip size="xs" color="red" icon={<CircleAlert />}>
                            {worktree.unpushedCommits} unpushed
                          </Chip>
                        )}
                        {worktree.stateUnknown && (
                          <Chip size="xs" color="amber" icon={<CircleAlert />}>
                            state unknown
                          </Chip>
                        )}
                        {!worktree.registered && (
                          <Chip size="xs" color="neutral">
                            untracked folder
                          </Chip>
                        )}
                      </div>
                      <div className="text-ink-4 mt-0.5 truncate text-xs">
                        {worktree.branchName ?? 'unknown branch'}
                        {worktree.taskName ? ` · ${worktree.taskName}` : ''}
                      </div>
                    </div>
                    <div className="text-ink-3 shrink-0 text-right text-xs">
                      <div>{formatBytes(worktree.sizeBytes)}</div>
                      {worktree.lastModifiedAt && (
                        <div className="text-ink-4">
                          {formatRelativeTime(worktree.lastModifiedAt)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="border-glass-border flex items-center justify-end gap-2 border-t px-4 py-3">
            <Button
              onClick={onClose}
              variant="secondary"
              disabled={cleanupMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCleanup}
              disabled={selectedPaths.size === 0 || cleanupMutation.isPending}
              loading={cleanupMutation.isPending}
              variant="danger"
              icon={<Trash2 />}
            >
              Remove Selected ({selectedPaths.size}
              {selectedSize > 0 ? ` · ${formatBytes(selectedSize)}` : ''})
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
