import { execFile } from 'child_process';
import { promisify } from 'util';

import type { ProjectGitGraphRow, ProjectGitStatus } from '@shared/types';

import {
  buildGraphArgs,
  parseGraphLine,
  parseStatus,
  remoteFromUpstream,
} from './utils-project-git-parse';
import {
  getExecErrorMessage,
  getUpstreamRef,
  isGitRepository,
  pullBranch,
  pushBranch,
  runGitWithSshPrompt,
} from './worktree-service';
import { dbg } from '../lib/debug';
import { getChildProcessEnv } from '../lib/child-process-env';
import { getNonInteractiveGitEnv } from '../lib/git-non-interactive-env';

const execFileAsync = promisify(execFile);

/** Guards against pathological repos: a graph pane cannot usefully show more. */
const DEFAULT_GRAPH_LIMIT = 200;
const MAX_GRAPH_LIMIT = 1000;

/** `git log` on a large repo is cheap, but never let it pin a handler forever. */
const GIT_READ_TIMEOUT_MS = 30_000;

/**
 * Mutating commands get a far more generous ceiling than reads. Killing a
 * `checkout` partway through leaves a half-updated working tree and a stale
 * `index.lock`, so a slow-but-progressing command must be allowed to finish.
 */
const GIT_WRITE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Fetch talks to the network, so it needs the same generous ceiling the
 * push/pull paths use rather than the read timeout.
 */
const GIT_FETCH_TIMEOUT_MS = 5 * 60 * 1000;

/** Output cap for `git log --graph`; a runaway repo must not exhaust memory. */
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

async function runGit(
  repoPath: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout,
    maxBuffer: GIT_MAX_BUFFER_BYTES,
  });
  return { stdout, stderr };
}

/** Read-only git command. Bounded by the short read timeout. */
async function git(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return runGit(repoPath, args, GIT_READ_TIMEOUT_MS);
}

/** Mutating git command. Bounded by the long write timeout. */
async function gitWrite(
  repoPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return runGit(repoPath, args, GIT_WRITE_TIMEOUT_MS);
}

async function getRemoteUrl(
  repoPath: string,
  remote: string,
): Promise<string | null> {
  try {
    const { stdout } = await git(repoPath, ['remote', 'get-url', remote]);
    return stdout.trim() || null;
  } catch {
    // No such remote, or no remotes at all. Not an error for a local-only repo.
    return null;
  }
}

export async function getProjectGitStatus(
  repoPath: string,
): Promise<ProjectGitStatus> {
  if (!(await isGitRepository(repoPath))) {
    return {
      isGitRepository: false,
      branch: '',
      isDetached: false,
      upstream: null,
      ahead: null,
      behind: null,
      remoteUrl: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
    };
  }

  let stdout: string;
  try {
    ({ stdout } = await git(repoPath, [
      'status',
      '--porcelain=v2',
      '--branch',
      // Deliberately NOT `--untracked-files=all`: the panel only shows a
      // count, and `all` enumerates every file individually. One unignored
      // `node_modules` would emit hundreds of thousands of lines and blow the
      // output buffer on every poll. `normal` collapses untracked directories,
      // so the count is of untracked paths rather than files.
      '--untracked-files=normal',
    ]));
  } catch (error) {
    // A stale `index.lock`, a corrupt repo, or a bare repo. Surface a readable
    // message rather than letting a raw `Command failed: git status` cross IPC.
    throw new Error(
      `Failed to read git status for ${repoPath}: ${getExecErrorMessage(error)}`,
    );
  }

  const parsed = parseStatus(stdout);
  const remoteUrl = await getRemoteUrl(
    repoPath,
    remoteFromUpstream(parsed.upstream) ?? 'origin',
  );

  return { isGitRepository: true, ...parsed, remoteUrl };
}

export async function getProjectGitGraph(params: {
  repoPath: string;
  limit?: number;
  /** When false, only the current branch's history is walked. */
  includeAllBranches?: boolean;
}): Promise<ProjectGitGraphRow[]> {
  const { repoPath } = params;
  if (!(await isGitRepository(repoPath))) return [];

  const limit = Math.min(
    Math.max(1, params.limit ?? DEFAULT_GRAPH_LIMIT),
    MAX_GRAPH_LIMIT,
  );

  const args = buildGraphArgs({
    limit,
    includeAllBranches: params.includeAllBranches,
  });

  try {
    const { stdout } = await git(repoPath, args);
    return stdout
      .split('\n')
      .map(parseGraphLine)
      .filter((row): row is ProjectGitGraphRow => row !== null);
  } catch (error) {
    // A repository with no commits yet makes `git log` exit non-zero. An empty
    // graph is the honest answer, not a failed panel.
    dbg.worktree('getProjectGitGraph failed for %s: %o', repoPath, error);
    return [];
  }
}

/**
 * In-flight fetch per repository path.
 *
 * The renderer also de-duplicates, but it cannot see other windows or a manual
 * refresh racing the interval, and this is the process that owns the resource:
 * concurrent `git fetch` on one repo contends on `FETCH_HEAD` and `.git/refs`
 * and surfaces as spurious failures.
 */
const inFlightFetches = new Map<
  string,
  { promise: Promise<void>; interactive: boolean }
>();

/** Reads `core.sshCommand` so a non-interactive fetch does not discard it. */
async function getConfiguredSshCommand(
  repoPath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await git(repoPath, [
      'config',
      '--get',
      'core.sshCommand',
    ]);
    return stdout.trim() || undefined;
  } catch {
    // Exit 1 simply means the key is unset.
    return undefined;
  }
}

/**
 * Fetches all remotes so ahead/behind reflect the server. Prunes deleted
 * remote branches so stale remote-tracking refs do not linger in the graph.
 *
 * `interactive` distinguishes the two callers, which need opposite behaviour.
 *
 * The background timer must never prompt: `offerKeyUnlock: false` only
 * suppresses the follow-up "add this key to ssh-agent?" offer, so a
 * passphrase-protected key would still raise a modal once per tick. It
 * therefore runs under `getNonInteractiveGitEnv()` and fails silently.
 *
 * An explicit click on Fetch should be able to ask for a passphrase the same
 * way push and pull do — otherwise a user with an encrypted key could never
 * refresh at all.
 */
export async function fetchProjectRemotes(
  repoPath: string,
  { interactive = false }: { interactive?: boolean } = {},
): Promise<void> {
  if (!(await isGitRepository(repoPath))) return;

  const pending = inFlightFetches.get(repoPath);
  if (pending) {
    // A background refresh is satisfied by any in-flight fetch, and so is an
    // interactive one that finds another interactive fetch already running.
    if (!interactive || pending.interactive) {
      dbg.worktree('fetchProjectRemotes: joining in-flight fetch %s', repoPath);
      return pending.promise;
    }

    // An explicit Fetch must not be silently absorbed by a background fetch:
    // under BatchMode that attempt cannot prompt, so joining it would report
    // failure to the user without ever offering the passphrase dialog. Wait
    // for it — if it succeeded there is nothing left to do — and only run our
    // own interactive attempt if it did not.
    const succeeded = await pending.promise.then(
      () => true,
      () => false,
    );
    if (succeeded) return;

    const restarted = inFlightFetches.get(repoPath);
    if (restarted?.interactive) return restarted.promise;
  }

  dbg.worktree('fetchProjectRemotes: %s (interactive=%s)', repoPath, interactive);

  // Resolved before the command is built so there is no `await` between
  // creating the promise and registering it as in-flight.
  const configuredSshCommand = interactive
    ? undefined
    : await getConfiguredSshCommand(repoPath);

  const run = interactive
    ? runGitWithSshPrompt({
        args: ['fetch', '--all', '--prune'],
        cwd: repoPath,
        label: 'git fetch',
        // The user asked for this fetch, but an "add key to ssh-agent?" offer
        // afterwards is still more than they asked for.
        offerKeyUnlock: false,
        timeoutMs: GIT_FETCH_TIMEOUT_MS,
      })
    : execFileAsync('git', ['fetch', '--all', '--prune'], {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: GIT_FETCH_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        env: getChildProcessEnv({
          overrides: getNonInteractiveGitEnv({ configuredSshCommand }),
        }),
      });

  const promise = run
    .then(() => undefined)
    .finally(() => {
      inFlightFetches.delete(repoPath);
    });

  inFlightFetches.set(repoPath, { promise, interactive });
  return promise;
}

/**
 * Pushes the main repository's current branch to its remote.
 *
 * The local branch name is not necessarily the remote branch name, so the
 * upstream's ref wins when one is configured. Pushing `status.branch` blindly
 * would create a *new* remote branch (and, with `-u`, silently repoint
 * tracking at it) whenever the two names differ.
 */
export async function pushProject(repoPath: string): Promise<void> {
  const status = await getProjectGitStatus(repoPath);
  if (!status.isGitRepository) {
    throw new Error('Project is not a git repository');
  }
  if (status.isDetached || !status.branch) {
    throw new Error('Cannot push a detached HEAD');
  }

  const upstream = await getUpstreamRef({
    worktreePath: repoPath,
    branchName: status.branch,
  });

  if (!upstream) {
    // No upstream yet: publish the branch under its own name and set tracking.
    await pushBranch({ worktreePath: repoPath, branchName: status.branch });
    return;
  }

  dbg.worktree(
    'pushProject: %s -> %s/%s',
    status.branch,
    upstream.remote,
    upstream.branch,
  );
  await runGitWithSshPrompt({
    args: ['push', upstream.remote, `${status.branch}:${upstream.branch}`],
    cwd: repoPath,
    label: 'git push',
  });
}

export async function pullProject(repoPath: string): Promise<void> {
  const status = await getProjectGitStatus(repoPath);
  if (!status.isGitRepository) {
    throw new Error('Project is not a git repository');
  }
  if (status.isDetached || !status.branch) {
    throw new Error('Cannot pull onto a detached HEAD');
  }

  await pullBranch({
    worktreePath: repoPath,
    branchName: status.branch,
    remote: remoteFromUpstream(status.upstream),
  });
}

/**
 * Switches the main repository to an existing local branch.
 *
 * The branch name arrives from the renderer, so it is validated as a real,
 * existing branch before it reaches git. `git checkout <arg>` is dangerously
 * overloaded: with a path argument it restores that path from the index —
 * silently discarding uncommitted work and exiting 0 — and with a leading dash
 * it is parsed as an option (`-B`, `-f`, `--orphan`). Neither is reachable
 * here: the name must pass `check-ref-format`, must resolve to an existing
 * `refs/heads/` entry, and is passed with a `--` terminator so git can only
 * ever read it as a revision.
 *
 * No `-f`: if the working tree has changes that would be clobbered, git
 * refuses and we surface that rather than discarding the user's work.
 */
export async function checkoutProjectBranch(params: {
  repoPath: string;
  branchName: string;
}): Promise<void> {
  const { repoPath, branchName } = params;

  // The leading-dash check is load-bearing, not belt-and-braces:
  // `git check-ref-format refs/heads/-B` exits 0, so the validation below
  // would happily pass `-B`, `-f` or `--orphan` straight through as options.
  if (
    typeof branchName !== 'string' ||
    !branchName ||
    branchName.startsWith('-')
  ) {
    throw new Error(`"${branchName}" is not a valid git branch name`);
  }

  await git(repoPath, ['check-ref-format', `refs/heads/${branchName}`]).catch(
    () => {
      throw new Error(`"${branchName}" is not a valid git branch name`);
    },
  );

  // `--list` with an exact name, rather than `rev-parse`, so a tag or remote
  // ref with the same name cannot satisfy the check.
  const { stdout: existing } = await git(repoPath, [
    'branch',
    '--list',
    branchName,
    '--format=%(refname:short)',
  ]);
  if (!existing.trim()) {
    throw new Error(`Branch ${branchName} does not exist`);
  }

  dbg.worktree('checkoutProjectBranch: %s -> %s', repoPath, branchName);
  await gitWrite(repoPath, ['checkout', branchName, '--']);
}
