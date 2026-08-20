import { describe, expect, it, vi } from 'vitest';

import { resolveSourceBranchStartPoint } from './pull-source-branch';

const REPO = '/repo';

function makeRunner(
  handlers: Array<{ match: string[]; result: string | Error }>,
) {
  return vi.fn(async (args: string[]) => {
    const handler = handlers.find((h) =>
      h.match.every((token) => args.includes(token)),
    );
    if (!handler) return '';
    if (handler.result instanceof Error) throw handler.result;
    return handler.result;
  });
}

describe('resolveSourceBranchStartPoint', () => {
  it('pulls and returns the source branch when it is checked out', async () => {
    const runGit = makeRunner([
      { match: ['fetch'], result: '' },
      { match: ['--abbrev-ref'], result: 'main' },
      { match: ['pull'], result: '' },
    ]);

    const result = await resolveSourceBranchStartPoint({
      repoPath: REPO,
      sourceBranch: 'main',
      runGit,
    });

    expect(result).toBe('main');
    expect(runGit).toHaveBeenCalledWith(
      ['pull', '--ff-only', 'origin', 'main'],
      REPO,
    );
  });

  it('returns the remote-tracking ref when the branch is not checked out', async () => {
    const runGit = makeRunner([
      { match: ['fetch'], result: '' },
      { match: ['--abbrev-ref'], result: 'other-branch' },
    ]);

    await expect(
      resolveSourceBranchStartPoint({
        repoPath: REPO,
        sourceBranch: 'main',
        runGit,
      }),
    ).resolves.toBe('origin/main');
  });

  it('falls back to the local branch when the ref does not exist on origin', async () => {
    const runGit = makeRunner([
      {
        match: ['fetch'],
        result: new Error(
          "fatal: couldn't find remote ref refs/heads/jean-claude/review-x",
        ),
      },
      { match: ['refs/remotes/origin/jean-claude/review-x'], result: '' },
      { match: ['refs/heads/jean-claude/review-x'], result: 'abc123' },
    ]);

    await expect(
      resolveSourceBranchStartPoint({
        repoPath: REPO,
        sourceBranch: 'jean-claude/review-x',
        runGit,
      }),
    ).resolves.toBe('jean-claude/review-x');
  });

  it('prefers a cached remote-tracking ref over the local branch', async () => {
    const runGit = makeRunner([
      {
        match: ['fetch'],
        result: new Error("fatal: couldn't find remote ref refs/heads/feature"),
      },
      { match: ['refs/remotes/origin/feature'], result: 'deadbee' },
      { match: ['refs/heads/feature'], result: 'abc123' },
    ]);

    await expect(
      resolveSourceBranchStartPoint({
        repoPath: REPO,
        sourceBranch: 'feature',
        runGit,
      }),
    ).resolves.toBe('origin/feature');
  });

  it('rethrows when the branch exists neither on origin nor locally', async () => {
    const error = new Error(
      "fatal: couldn't find remote ref refs/heads/ghost-branch",
    );
    const runGit = makeRunner([
      { match: ['fetch'], result: error },
      { match: ['rev-parse'], result: '' },
    ]);

    await expect(
      resolveSourceBranchStartPoint({
        repoPath: REPO,
        sourceBranch: 'ghost-branch',
        runGit,
      }),
    ).rejects.toThrow('ghost-branch');
  });

  it('rethrows network/auth failures instead of silently using a stale local branch', async () => {
    const runGit = makeRunner([
      {
        match: ['fetch'],
        result: new Error(
          'fatal: could not read from remote repository (Permission denied)',
        ),
      },
      { match: ['refs/heads/main'], result: 'abc123' },
    ]);

    await expect(
      resolveSourceBranchStartPoint({
        repoPath: REPO,
        sourceBranch: 'main',
        runGit,
      }),
    ).rejects.toThrow('Permission denied');
  });

  it('strips an origin/ prefix before fetching', async () => {
    const runGit = makeRunner([
      { match: ['fetch'], result: '' },
      { match: ['--abbrev-ref'], result: 'main' },
    ]);

    await expect(
      resolveSourceBranchStartPoint({
        repoPath: REPO,
        sourceBranch: 'origin/main',
        runGit,
      }),
    ).resolves.toBe('origin/main');
    expect(runGit).toHaveBeenCalledWith(
      ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      REPO,
    );
  });
});
