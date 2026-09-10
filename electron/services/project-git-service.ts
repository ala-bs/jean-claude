import { execFile } from 'child_process';
import { promisify } from 'util';

import type {
  ProjectCommitDetail,
  ProjectCommitFileContent,
  ProjectGitGraphRow,
  ProjectGitStatus,
  ProjectWorkingTreeFile,
} from '@shared/types';

import {
  buildGraphArgs,
  COMMIT_DETAIL_FORMAT,
  GRAPH_FORMAT,
  looksLikeCommitHash,
  parseCommitDetail,
  parseCommitDiffFiles,
  parseGraphLine,
  parseStatus,
  parseStatusFiles,
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

/** Enough to inspect a messy tree without rendering an unbounded list. */
const MAX_WORKING_TREE_FILES = 500;

/**
 * Changed paths in the working tree, for the sync bar's popover.
 *
 * Separate from `getProjectGitStatus` on purpose: that call polls on a timer
 * and only needs counts, so it must not carry a payload proportional to the
 * size of the diff.
 */
export async function getProjectWorkingTreeFiles(
  repoPath: string,
): Promise<ProjectWorkingTreeFile[]> {
  if (!(await isGitRepository(repoPath))) return [];

  try {
    const { stdout } = await git(repoPath, [
      'status',
      '--porcelain=v2',
      // Same reasoning as `getProjectGitStatus`: `all` would enumerate every
      // file under an unignored `node_modules` and blow the output buffer.
      '--untracked-files=normal',
    ]);
    return parseStatusFiles(stdout).slice(0, MAX_WORKING_TREE_FILES);
  } catch (error) {
    dbg.worktree(
      'getProjectWorkingTreeFiles failed for %s: %o',
      repoPath,
      error,
    );
    return [];
  }
}

/**
 * Total reachable commit count, used by the history pane's load progress.
 *
 * Counts the same ref set the graph walks so "loaded / total" cannot exceed
 * 100%, and stays a single `rev-list --count` rather than paging the log.
 */
export async function getProjectCommitCount(params: {
  repoPath: string;
  includeAllBranches?: boolean;
  /** Free-text query, or a commit hash prefix. Counts matches when set. */
  query?: string;
  /** Branches to count over instead of every ref. */
  branches?: string[];
}): Promise<number> {
  const { repoPath, includeAllBranches = true } = params;
  if (!(await isGitRepository(repoPath))) return 0;

  const query = params.query?.trim() ?? '';
  const branches = await resolveBranchRefs(repoPath, params.branches ?? []);

  // A hash query resolves to one commit or none, and `rev-list --count` over a
  // single revision would instead count its whole ancestry.
  if (query.length > 0 && looksLikeCommitHash(query)) {
    const hash = await resolveCommitHash(repoPath, query);
    if (hash) return 1;
  }

  try {
    const args = ['rev-list', '--count'];
    if (branches.length === 0) {
      args.push(includeAllBranches ? '--all' : 'HEAD');
    }
    if (query.length > 0) {
      args.push(`--grep=${query}`, '--fixed-strings', '--regexp-ignore-case');
    }
    if (branches.length > 0) args.push(...branches);
    args.push('--');

    const { stdout } = await git(repoPath, args);
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    // An empty repository has no HEAD to walk; zero is the honest answer.
    dbg.worktree('getProjectCommitCount failed for %s: %o', repoPath, error);
    return 0;
  }
}

/**
 * Narrows a caller-supplied branch list to refs that actually exist.
 *
 * The names arrive from the renderer and are passed to `git log` as revision
 * arguments, so they cannot be trusted: a value like `--output=/tmp/x` would
 * otherwise be read as an option. Rather than pattern-matching for dangerous
 * shapes, this intersects the request with the repository's real refs, so only
 * names git already knows about can ever be forwarded.
 */
async function resolveBranchRefs(
  repoPath: string,
  requested: string[],
): Promise<string[]> {
  if (requested.length === 0) return [];

  const { stdout } = await git(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  const known = new Set(
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  const resolved = requested.filter((name) => known.has(name));
  if (resolved.length !== requested.length) {
    dbg.worktree(
      'resolveBranchRefs: dropped %d unknown ref(s) for %s',
      requested.length - resolved.length,
      repoPath,
    );
  }
  return resolved;
}

/**
 * Resolves a query that looks like a commit hash to its full hash.
 *
 * Returns null when the prefix names no commit, which is what lets an ambiguous
 * query like `deadbeef` fall back to a text search instead of returning
 * nothing.
 */
async function resolveCommitHash(
  repoPath: string,
  query: string,
): Promise<string | null> {
  try {
    const { stdout } = await git(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${query.trim()}^{commit}`,
    ]);
    return stdout.trim() || null;
  } catch {
    // Exit 1 simply means the prefix does not name a commit.
    return null;
  }
}

export async function getProjectGitGraph(params: {
  repoPath: string;
  limit?: number;
  /** Commits to skip before the window, for paging older history. */
  skip?: number;
  /** When false, only the current branch's history is walked. */
  includeAllBranches?: boolean;
  /** Free-text query, or a commit hash prefix. */
  query?: string;
  /** Branches to walk instead of every ref. */
  branches?: string[];
}): Promise<ProjectGitGraphRow[]> {
  const { repoPath } = params;
  if (!(await isGitRepository(repoPath))) return [];

  const limit = Math.min(
    Math.max(1, params.limit ?? DEFAULT_GRAPH_LIMIT),
    MAX_GRAPH_LIMIT,
  );

  const query = params.query?.trim() ?? '';
  const branches = await resolveBranchRefs(repoPath, params.branches ?? []);

  // A hash prefix names exactly one commit, so it is resolved directly rather
  // than run through `--grep`, which only ever searches messages and would
  // report "no matches" for a perfectly valid sha.
  if (query.length > 0 && looksLikeCommitHash(query)) {
    const hash = await resolveCommitHash(repoPath, query);
    if (hash) {
      // A single hit has no second page; skipping past it yields nothing.
      if (params.skip && params.skip > 0) return [];
      try {
        const { stdout } = await git(repoPath, [
          'log',
          '--decorate=full',
          '--max-count=1',
          `--pretty=format:${GRAPH_FORMAT}`,
          hash,
          '--',
        ]);
        const row = parseGraphLine(stdout.split('\n')[0] ?? '');
        return row ? [row] : [];
      } catch (error) {
        dbg.worktree('getProjectGitGraph hash lookup failed: %o', error);
        return [];
      }
    }
  }

  const args = buildGraphArgs({
    limit,
    skip: params.skip,
    includeAllBranches: params.includeAllBranches,
    query,
    branches,
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

/** Ceiling on the file list of one commit, so a huge merge cannot stall the pane. */
const MAX_COMMIT_DIFF_FILES = 300;

/**
 * A commit's metadata and the files it touched.
 *
 * Uses `diff-tree` rather than `<hash>^..<hash>`: the caret form fails outright
 * on a root commit, which has no parent to diff against. `--root` handles that
 * case, and `-m --first-parent` makes a merge show its diff against the branch
 * it landed on instead of the empty combined diff git produces by default.
 */
export async function getProjectCommitDetail(params: {
  repoPath: string;
  commitHash: string;
}): Promise<ProjectCommitDetail | null> {
  const { repoPath, commitHash } = params;
  if (!(await isGitRepository(repoPath))) return null;

  const hash = await resolveCommitHash(repoPath, commitHash);
  if (!hash) {
    dbg.worktree('getProjectCommitDetail: unknown commit %s', commitHash);
    return null;
  }

  const diffTree = (mode: '--name-status' | '--numstat') => [
    'diff-tree',
    '--no-commit-id',
    '-r',
    '--root',
    '-m',
    '--first-parent',
    mode,
    hash,
    '--',
  ];

  try {
    const [header, nameStatus, numstat] = await Promise.all([
      git(repoPath, [
        'log',
        '--decorate=full',
        '--max-count=1',
        `--pretty=format:${COMMIT_DETAIL_FORMAT}`,
        hash,
        '--',
      ]),
      git(repoPath, diffTree('--name-status')),
      git(repoPath, diffTree('--numstat')),
    ]);

    const detail = parseCommitDetail(header.stdout);
    if (!detail) return null;

    const allFiles = parseCommitDiffFiles({
      nameStatus: nameStatus.stdout,
      numstat: numstat.stdout,
    });
    const files = allFiles.slice(0, MAX_COMMIT_DIFF_FILES);

    return {
      ...detail,
      files,
      // Summed over every file, not just the shown ones, so a truncated commit
      // still reports its real size.
      additions: allFiles.reduce((total, file) => total + file.additions, 0),
      deletions: allFiles.reduce((total, file) => total + file.deletions, 0),
      truncated: allFiles.length > files.length,
    };
  } catch (error) {
    dbg.worktree('getProjectCommitDetail failed for %s: %o', hash, error);
    return null;
  }
}

/** Files past this size are not worth diffing in a side panel. */
const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;

/** Reads one blob, returning null when the path did not exist at that revision. */
async function readBlobAt(
  repoPath: string,
  rev: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await git(repoPath, ['show', `${rev}:${filePath}`]);
    return stdout;
  } catch {
    // The path did not exist on that side of the diff.
    return null;
  }
}

/** True when git considers the path binary on either side of the commit. */
async function isBinaryAtCommit(
  repoPath: string,
  hash: string,
  filePath: string,
): Promise<boolean> {
  try {
    const { stdout } = await git(repoPath, [
      'diff-tree',
      '--no-commit-id',
      '-r',
      '--root',
      '-m',
      '--first-parent',
      '--numstat',
      hash,
      '--',
      filePath,
    ]);
    // git reports binary files as `-\t-\t<path>`.
    return stdout.split('\n').some((line) => line.startsWith('-\t-\t'));
  } catch {
    return false;
  }
}

/**
 * Both sides of one file in a commit, for the diff viewer.
 *
 * `<hash>^` is deliberately not used to name the old side: it does not resolve
 * on a root commit. The first parent is read from the commit itself, and its
 * absence is what marks the file as newly added.
 */
export async function getProjectCommitFileContent(params: {
  repoPath: string;
  commitHash: string;
  filePath: string;
}): Promise<ProjectCommitFileContent> {
  const { repoPath, filePath } = params;
  const empty = { oldContent: '', newContent: '', isBinary: false };
  if (!(await isGitRepository(repoPath))) return empty;

  const hash = await resolveCommitHash(repoPath, params.commitHash);
  if (!hash) return empty;

  if (await isBinaryAtCommit(repoPath, hash, filePath)) {
    return { oldContent: '', newContent: '', isBinary: true };
  }

  const { stdout: parentOut } = await git(repoPath, [
    'rev-list',
    '--parents',
    '--max-count=1',
    hash,
    '--',
  ]);
  const firstParent = parentOut.trim().split(' ')[1] ?? null;

  const [oldContent, newContent] = await Promise.all([
    firstParent ? readBlobAt(repoPath, firstParent, filePath) : null,
    readBlobAt(repoPath, hash, filePath),
  ]);

  const tooLarge =
    (oldContent?.length ?? 0) > MAX_DIFF_FILE_BYTES ||
    (newContent?.length ?? 0) > MAX_DIFF_FILE_BYTES;
  if (tooLarge) return { oldContent: '', newContent: '', isBinary: true };

  return {
    oldContent: oldContent ?? '',
    newContent: newContent ?? '',
    isBinary: false,
  };
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
