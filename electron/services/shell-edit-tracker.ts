/**
 * Tracks file changes made by Bash commands so they show up in the prompt-group
 * diff summary.
 *
 * The diff summary is built from `edit`/`write` tool uses. When an agent edits
 * files through the shell instead (`sed -i`, a python script, a heredoc
 * redirect, ...) those changes are invisible. This tracker snapshots the git
 * tree around commands that look mutating and turns the resulting diff into a
 * synthetic `edit` entry attached to the Bash tool call.
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
import { isLikelyFileMutatingCommand } from './utils-shell-edit-detection';

import { dbg } from '../lib/debug';

/**
 * Bounds how many snapshots one Bash command can trigger, for backends that
 * stream a running command's output as repeated results.
 */
const MAX_CAPTURES_PER_COMMAND = 10;

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
  /**
   * Bash tool IDs whose command looked file-mutating, with how many times they
   * have been captured. Backends may report a running command's output several
   * times before it finishes, so a watch stays armed and re-captures; the count
   * bounds how often a single command can trigger a snapshot.
   */
  watchedToolIds: Map<string, number>;
  /**
   * Files already attributed to an `edit`/`write` tool use and not yet seen in a
   * tree diff. Entries are consumed on first match rather than cleared in bulk,
   * because a tool use is reported when the model requests it — the write may
   * only land after a later snapshot.
   */
  pendingToolEdits: Set<string>;
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
      existing.watchedToolIds.clear();
      existing.pendingToolEdits.clear();
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
      watchedToolIds: new Map(),
      pendingToolEdits: new Set(),
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

  /** Records that a Bash command may have modified files. */
  watchBashCommand({
    stepId,
    toolId,
    command,
  }: {
    stepId: string;
    toolId: string;
    command: string;
  }): void {
    const state = this.states.get(stepId);
    if (!state) return;
    if (!isLikelyFileMutatingCommand(command)) return;
    if (!state.watchedToolIds.has(toolId)) state.watchedToolIds.set(toolId, 0);
  }

  /**
   * Records a file already covered by an `edit`/`write` tool use, so it is not
   * also attributed to a shell command.
   */
  noteToolEditedFile({
    stepId,
    filePath,
  }: {
    stepId: string;
    filePath: string;
  }): void {
    const state = this.states.get(stepId);
    if (!state) return;
    state.pendingToolEdits.add(toAbsolutePath(state.workingDir, filePath));
  }

  /**
   * Called when a Bash tool call reports a result. Returns the files it changed
   * since the last capture, or null when the command is not watched, has been
   * captured too often, or changed nothing.
   *
   * Some backends report a result for a command that is still running, so the
   * watch stays armed and later calls capture whatever changed since. Each
   * capture only ever reports new changes, so a command cannot be counted twice.
   *
   * File paths are absolute so they match the paths reported by the Edit/Write
   * tools, which the renderer de-duplicates against.
   */
  async captureBashResult({
    stepId,
    toolId,
  }: {
    stepId: string;
    toolId: string;
  }): Promise<TreeDiffFile[] | null> {
    const state = this.states.get(stepId);
    const captureCount = state?.watchedToolIds.get(toolId);
    if (state === undefined || captureCount === undefined) return null;
    if (captureCount >= MAX_CAPTURES_PER_COMMAND) return null;
    state.watchedToolIds.set(toolId, captureCount + 1);

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
      // Consume rather than keep: a later shell edit of the same file should be
      // reported again.
      if (state.pendingToolEdits.delete(absolutePath)) continue;
      attributable.push({ ...file, filePath: absolutePath });
    }
    if (attributable.length === 0) return null;
    dbg.agent('Detected %d shell-edited file(s)', attributable.length);
    return attributable;
  }
}

function toAbsolutePath(workingDir: string, filePath: string): string {
  return path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(workingDir, filePath);
}

export const shellEditTracker = new ShellEditTracker();
