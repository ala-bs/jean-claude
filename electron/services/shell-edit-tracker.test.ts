import * as path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const snapshots: string[] = [];
const diffs = new Map<string, { filePath: string; type: string }[]>();

vi.mock('./worktree-tree-snapshot', () => ({
  createScratchIndexPath: () => '/tmp/index',
  removeScratchIndex: async () => {},
  getRepoRoot: async () => WORKING_DIR,
  snapshotWorktreeTree: async () => snapshots.shift() ?? null,
  diffWorktreeTrees: async ({
    before,
    after,
  }: {
    before: string;
    after: string;
  }) =>
    (diffs.get(`${before}->${after}`) ?? []).map((file) => ({
      ...file,
      additions: 1,
      deletions: 0,
    })),
}));

const WORKING_DIR = path.resolve('/repo');
const STEP = 'step-1';

const { shellEditTracker } = await import('./shell-edit-tracker');

function begin(): object {
  return shellEditTracker.begin({ stepId: STEP, workingDir: WORKING_DIR });
}

describe('shellEditTracker', () => {
  beforeEach(() => {
    shellEditTracker.end(STEP);
    snapshots.length = 0;
    diffs.clear();
  });

  it('reports files changed by a mutating bash command as absolute paths', async () => {
    snapshots.push('treeA', 'treeB');
    diffs.set('treeA->treeB', [{ filePath: 'src/a.ts', type: 'update' }]);
    begin();
    shellEditTracker.watchBashCommand({
      stepId: STEP,
      toolId: 't1',
      command: 'sed -i s/a/b/ src/a.ts',
    });

    const files = await shellEditTracker.captureBashResult({
      stepId: STEP,
      toolId: 't1',
    });
    expect(files).toEqual([
      {
        filePath: path.join(WORKING_DIR, 'src/a.ts'),
        type: 'update',
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it('ignores read-only commands', async () => {
    snapshots.push('treeA');
    begin();
    shellEditTracker.watchBashCommand({
      stepId: STEP,
      toolId: 't1',
      command: "sed -n '1,60p' src/a.ts",
    });
    expect(
      await shellEditTracker.captureBashResult({ stepId: STEP, toolId: 't1' }),
    ).toBeNull();
  });

  it('never reports the same change twice for a repeated result', async () => {
    // Some backends report a result while the command is still running, so the
    // watch stays armed — but the baseline advances, so nothing is double-counted.
    snapshots.push('treeA', 'treeB', 'treeC');
    diffs.set('treeA->treeB', [{ filePath: 'a.ts', type: 'update' }]);
    diffs.set('treeB->treeC', [{ filePath: 'b.ts', type: 'update' }]);
    begin();
    shellEditTracker.watchBashCommand({
      stepId: STEP,
      toolId: 't1',
      command: 'sed -i s/a/b/ a.ts',
    });
    const first = await shellEditTracker.captureBashResult({
      stepId: STEP,
      toolId: 't1',
    });
    const second = await shellEditTracker.captureBashResult({
      stepId: STEP,
      toolId: 't1',
    });
    expect(first?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'a.ts'),
    ]);
    expect(second?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'b.ts'),
    ]);
  });

  it('stops capturing a single command after the cap', async () => {
    for (let index = 0; index < 20; index += 1) snapshots.push(`tree${index}`);
    begin();
    shellEditTracker.watchBashCommand({
      stepId: STEP,
      toolId: 't1',
      command: 'sed -i s/a/b/ a.ts',
    });
    let captures = 0;
    for (let index = 0; index < 15; index += 1) {
      const result = await shellEditTracker.captureBashResult({
        stepId: STEP,
        toolId: 't1',
      });
      if (result !== null) captures += 1;
    }
    expect(captures).toBe(0); // no diffs registered
    expect(snapshots.length).toBeGreaterThan(0); // capped, did not drain
  });

  it('serializes concurrent captures', async () => {
    snapshots.push('treeA', 'treeB', 'treeC');
    diffs.set('treeA->treeB', [{ filePath: 'a.ts', type: 'update' }]);
    diffs.set('treeB->treeC', [{ filePath: 'b.ts', type: 'update' }]);
    begin();
    for (const toolId of ['t1', 't2']) {
      shellEditTracker.watchBashCommand({
        stepId: STEP,
        toolId,
        command: 'sed -i s/a/b/ a.ts',
      });
    }
    const [first, second] = await Promise.all([
      shellEditTracker.captureBashResult({ stepId: STEP, toolId: 't1' }),
      shellEditTracker.captureBashResult({ stepId: STEP, toolId: 't2' }),
    ]);
    expect(first?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'a.ts'),
    ]);
    expect(second?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'b.ts'),
    ]);
  });

  it('does not attribute files already claimed by an edit tool use', async () => {
    snapshots.push('treeA', 'treeB');
    diffs.set('treeA->treeB', [
      { filePath: 'edited.ts', type: 'update' },
      { filePath: 'shell.ts', type: 'update' },
    ]);
    begin();
    shellEditTracker.noteToolEditedFile({
      stepId: STEP,
      filePath: path.join(WORKING_DIR, 'edited.ts'),
    });
    shellEditTracker.watchBashCommand({
      stepId: STEP,
      toolId: 't1',
      command: 'sed -i s/a/b/ shell.ts',
    });

    const files = await shellEditTracker.captureBashResult({
      stepId: STEP,
      toolId: 't1',
    });
    expect(files?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'shell.ts'),
    ]);
  });

  it('keeps a tool-edited file pending until it actually appears in a diff', async () => {
    // The edit tool use is reported before the write lands, so the file shows up
    // in a later snapshot. It must still not be attributed to a shell command.
    snapshots.push('treeA', 'treeB', 'treeC');
    diffs.set('treeA->treeB', []);
    diffs.set('treeB->treeC', [{ filePath: 'late.ts', type: 'update' }]);
    begin();
    shellEditTracker.noteToolEditedFile({
      stepId: STEP,
      filePath: path.join(WORKING_DIR, 'late.ts'),
    });
    for (const toolId of ['t1', 't2']) {
      shellEditTracker.watchBashCommand({
        stepId: STEP,
        toolId,
        command: 'sed -i s/a/b/ x.ts',
      });
    }

    expect(
      await shellEditTracker.captureBashResult({ stepId: STEP, toolId: 't1' }),
    ).toBeNull();
    expect(
      await shellEditTracker.captureBashResult({ stepId: STEP, toolId: 't2' }),
    ).toBeNull();
  });

  it('ignores end() from a superseded run', async () => {
    snapshots.push('treeA', 'treeA2', 'treeB');
    const staleToken = begin();
    const freshToken = begin();
    expect(freshToken).not.toBe(staleToken);

    shellEditTracker.end(STEP, staleToken);
    shellEditTracker.watchBashCommand({
      stepId: STEP,
      toolId: 't1',
      command: 'sed -i s/a/b/ a.ts',
    });
    diffs.set('treeA2->treeB', [{ filePath: 'a.ts', type: 'update' }]);
    expect(
      await shellEditTracker.captureBashResult({ stepId: STEP, toolId: 't1' }),
    ).not.toBeNull();
  });

  it('is inert once tracking ended', async () => {
    snapshots.push('treeA');
    const token = begin();
    shellEditTracker.end(STEP, token);
    shellEditTracker.watchBashCommand({
      stepId: STEP,
      toolId: 't1',
      command: 'sed -i s/a/b/ a.ts',
    });
    expect(
      await shellEditTracker.captureBashResult({ stepId: STEP, toolId: 't1' }),
    ).toBeNull();
  });
});
