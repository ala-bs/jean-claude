/**
 * Tracks every file change made during a turn so it shows up in the
 * prompt-group diff summary.
 *
 * A baseline git tree is snapshotted when the turn starts and diffed against
 * the worktree when it ends, producing one synthetic `edit` entry for the whole
 * turn. This covers changes made through the shell (`sed -i`, a python script,
 * a heredoc redirect, ...), which no `edit`/`write` tool use reports.
 *
 * Snapshots use a throwaway git index, so the repository's real index, refs and
 * working tree are never touched. See {@link snapshotWorktreeTree}.
 */

import * as path from 'path';

import {
  createScratchIndexPath,
  diffWorktreeTrees,
  getRepoRoot,
  removeScratchIndex,
  snapshotWorktreeTree,
  type TreeDiffFile,
} from './worktree-tree-snapshot';

import { dbg } from '../lib/debug';

interface StepState {
  /** Identifies the run that owns this state, so a stale run cannot clear it. */
  owner: object;
  workingDir: string;
  /** Repository root; tree diffs report paths relative to it, not to cwd. */
  repoRoot: Promise<string | null>;
  /** Scratch index reused across snapshots to keep git's stat cache warm. */
  indexFile: string;
  /** Tree hash of the last snapshot, or a snapshot still in flight. */
  baseline: Promise<string | null>;
  /** Serializes captures so concurrent tool results cannot interleave. */
  captureChain: Promise<unknown>;
}

class ShellEditTracker {
  private states = new Map<string, StepState>();

  /**
   * Starts tracking for a run and captures the baseline tree.
   *
   * @returns A token identifying this run; pass it to {@link end} so a stale run
   *   finishing late cannot tear down a newer one.
   */
  begin({ stepId, workingDir }: { stepId: string; workingDir: string }): object {
    // runBackend recurses for queued prompts. Keep the existing scratch index in
    // that case so git's stat cache survives; only the baseline is refreshed.
    const existing = this.states.get(stepId);
    const owner = {};
    if (existing?.workingDir === workingDir) {
      // A fresh token each time: a previous session tearing down late must not
      // be able to stop tracking for the run that replaced it.
      existing.owner = owner;
      // Refresh through the chain: a capture from the previous prompt may still
      // be running against the same scratch index.
      this.refreshBaseline(existing);
      return owner;
    }
    this.end(stepId);
    const indexFile = createScratchIndexPath();
    const state: StepState = {
      owner,
      workingDir,
      repoRoot: getRepoRoot(workingDir),
      indexFile,
      baseline: Promise.resolve(null),
      captureChain: Promise.resolve(),
    };
    this.states.set(stepId, state);
    this.refreshBaseline(state);
    return owner;
  }

  /** Queues a baseline snapshot on the state's serialized capture chain. */
  private refreshBaseline(state: StepState): void {
    const snapshot = state.captureChain.then(() =>
      snapshotWorktreeTree(state.workingDir, state.indexFile),
    );
    state.captureChain = snapshot.catch(() => undefined);
    state.baseline = snapshot.catch(() => null);
  }

  /** Stops tracking. When `owner` is given, only that run's state is removed. */
  end(stepId: string, owner?: object): void {
    const state = this.states.get(stepId);
    if (!state) return;
    if (owner && state.owner !== owner) return;
    this.states.delete(stepId);
    void removeScratchIndex(state.indexFile);
  }

  /**
   * Captures everything that changed since the baseline as one diff.
   *
   * Called once at the end of a turn. Reporting full before/after state per file
   * avoids fragmented patches when several commands touch the same file, and
   * covers Edit/Write tool changes too — the renderer drops the per-tool entries
   * that the summary already accounts for.
   */
  async captureTurn(stepId: string): Promise<TreeDiffFile[] | null> {
    const state = this.states.get(stepId);
    if (state === undefined) return null;

    const capture = state.captureChain.then(() => this.capture(state));
    state.captureChain = capture.catch(() => undefined);
    return capture;
  }

  private async capture(state: StepState): Promise<TreeDiffFile[] | null> {
    const before = await state.baseline;
    const after = await snapshotWorktreeTree(state.workingDir, state.indexFile);
    if (after) state.baseline = Promise.resolve(after);
    if (!before || !after || before === after) return null;

    const files = await diffWorktreeTrees({
      worktreePath: state.workingDir,
      before,
      after,
    });

    // Tree diffs are relative to the repository root, which is not necessarily
    // the working directory (a project can point at a package subdirectory).
    const root = (await state.repoRoot) ?? state.workingDir;
    const attributable: TreeDiffFile[] = [];
    for (const file of files) {
      const absolutePath = path.resolve(root, file.filePath);
      attributable.push({ ...file, filePath: absolutePath });
    }
    if (attributable.length === 0) return null;
    dbg.agent('Detected %d turn-edited file(s)', attributable.length);
    return attributable;
  }
}

export const shellEditTracker = new ShellEditTracker();
