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

  it('reports files changed during the turn as absolute paths', async () => {
    snapshots.push('treeA', 'treeB');
    diffs.set('treeA->treeB', [{ filePath: 'src/a.ts', type: 'update' }]);
    begin();

    expect(await shellEditTracker.captureTurn(STEP)).toEqual([
      {
        filePath: path.join(WORKING_DIR, 'src/a.ts'),
        type: 'update',
        additions: 1,
        deletions: 0,
      },
    ]);
  });

  it('reports nothing when the tree is unchanged', async () => {
    snapshots.push('treeA', 'treeA');
    begin();
    expect(await shellEditTracker.captureTurn(STEP)).toBeNull();
  });

  it('includes files edited through the edit/write tools', async () => {
    // The turn summary is authoritative: the renderer, not the tracker, drops
    // the per-tool entries it supersedes.
    snapshots.push('treeA', 'treeB');
    diffs.set('treeA->treeB', [
      { filePath: 'edited.ts', type: 'update' },
      { filePath: 'shell.ts', type: 'update' },
    ]);
    begin();

    const files = await shellEditTracker.captureTurn(STEP);
    expect(files?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'edited.ts'),
      path.join(WORKING_DIR, 'shell.ts'),
    ]);
  });

  it('never reports the same change twice across turns', async () => {
    // The baseline advances with each capture, so a second capture only ever
    // reports what changed since the first.
    snapshots.push('treeA', 'treeB', 'treeC');
    diffs.set('treeA->treeB', [{ filePath: 'a.ts', type: 'update' }]);
    diffs.set('treeB->treeC', [{ filePath: 'b.ts', type: 'update' }]);
    begin();

    const first = await shellEditTracker.captureTurn(STEP);
    const second = await shellEditTracker.captureTurn(STEP);
    expect(first?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'a.ts'),
    ]);
    expect(second?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'b.ts'),
    ]);
  });

  it('serializes concurrent captures', async () => {
    snapshots.push('treeA', 'treeB', 'treeC');
    diffs.set('treeA->treeB', [{ filePath: 'a.ts', type: 'update' }]);
    diffs.set('treeB->treeC', [{ filePath: 'b.ts', type: 'update' }]);
    begin();

    const [first, second] = await Promise.all([
      shellEditTracker.captureTurn(STEP),
      shellEditTracker.captureTurn(STEP),
    ]);
    expect(first?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'a.ts'),
    ]);
    expect(second?.map((file) => file.filePath)).toEqual([
      path.join(WORKING_DIR, 'b.ts'),
    ]);
  });

  it('ignores end() from a superseded run', async () => {
    snapshots.push('treeA', 'treeA2', 'treeB');
    const staleToken = begin();
    const freshToken = begin();
    expect(freshToken).not.toBe(staleToken);

    shellEditTracker.end(STEP, staleToken);
    diffs.set('treeA2->treeB', [{ filePath: 'a.ts', type: 'update' }]);
    expect(await shellEditTracker.captureTurn(STEP)).not.toBeNull();
  });

  it('is inert once tracking ended', async () => {
    snapshots.push('treeA');
    const token = begin();
    shellEditTracker.end(STEP, token);
    expect(await shellEditTracker.captureTurn(STEP)).toBeNull();
  });
});
