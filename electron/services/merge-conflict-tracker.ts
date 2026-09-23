/**
 * Tracks how merge conflicts were resolved during an agent turn.
 *
 * The turn diff produced by `shell-edit-tracker` flattens everything a turn
 * touched into one before/after per file. When the agent merges the base branch
 * in, that diff drowns the interesting part — the conflict resolution — in
 * hundreds of incoming files. This module recovers the resolution separately, so
 * it can be shown as its own entry with all four sides: base, ours, theirs and
 * the resolved result.
 *
 * ## Why a `pre-commit` hook
 *
 * Git has no `pre-merge` hook, and the two that sound right are useless here:
 * `pre-merge-commit` and `post-merge` only run when the merge succeeds
 * automatically, i.e. exactly when there is nothing to resolve. A *conflicting*
 * `git merge` fires no hook at all.
 *
 * The only point where both sides and the resolution coexist is the commit that
 * concludes the merge (`git commit` or `git merge --continue`). There,
 * `pre-commit` runs while `MERGE_HEAD` still exists and the resolved content is
 * staged:
 *
 * ```
 *   merge conflicts ──▶ (no hooks) ──▶ agent resolves ──▶ git commit
 *                                                             │
 *                                       pre-commit ◀──────────┘
 *                                         MERGE_HEAD present  → ours/theirs
 *                                         index staged        → resolved
 * ```
 *
 * The hook itself only records three object ids; all reconstruction happens here
 * in the main process at drain time.
 *
 * ## Why there is also a commit backfill
 *
 * `git commit --no-verify` skips `pre-commit` entirely, and the app passes it
 * whenever `project.commitWithNoVerify` is set. {@link backfillFromMergeCommits}
 * covers that by reconstructing the same information straight from any merge
 * commit created during the turn — its parents are ours/theirs and its tree is
 * the resolution.
 *
 * ## What is deliberately not covered
 *
 * Both paths key on a two-parent merge: the hook needs `MERGE_HEAD`, and the
 * backfill needs a merge commit. Conflicts resolved during these are therefore
 * invisible, and appear only in the ordinary turn diff:
 *
 *  - `git merge --squash` — writes no `MERGE_HEAD` and produces an ordinary
 *    single-parent commit
 *  - `git rebase` — sets `REBASE_HEAD`, and rewrites commits rather than merging
 *  - `git cherry-pick` — sets `CHERRY_PICK_HEAD`
 *  - octopus merges — no faithful two-sided replay exists, so they are skipped
 *    rather than reconstructed against an arbitrary parent
 */

import { execFile } from 'child_process';
// Uses `node:fs/promises` (not `fs/promises`) on purpose: git needs the real
// filesystem, and the test setup mocks the unprefixed specifier with memfs.
import * as fs from 'node:fs/promises';
import * as path from 'path';
import { promisify } from 'util';

import { dbg } from '../lib/debug';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;

/** Per-side content cap. A resolution persists up to four sides per file. */
const MAX_CONTENT_BYTES = 256 * 1024;

/** Total content captured across every side of every file in one resolution. */
const MAX_TOTAL_CONTENT_BYTES = 4 * 1024 * 1024;

/** Conflicted files reported per merge; beyond this only paths are kept. */
const MAX_CONFLICT_FILES = 100;

/** Directory (relative to the git dir) the hook drops its records into. */
const RECORD_DIR = path.join('jean-claude', 'merge-resolutions');

/** One side of the three-way merge, plus the committed result. */
export type MergeSide = 'base' | 'ours' | 'theirs' | 'resolved';

/**
 * Git file modes we can render as text.
 *
 * A gitlink (160000) names a *commit*, not a blob, so reading it as one fails
 * and would otherwise be reported as "binary or too large". Submodule pointer
 * conflicts are real but not textual, so they are marked unavailable on purpose.
 */
const TEXT_MODES = new Set(['100644', '100755', '120000']);

/**
 * Counts lines the way `git diff --numstat` does.
 *
 * Content we could not capture counts as zero rather than guessing, so an
 * unreadable side shows no line counts instead of wrong ones.
 */
function countLines(content: string | undefined): number {
  if (!content) return 0;
  const withoutTrailingNewline = content.endsWith('\n')
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline.split('\n').length;
}

export interface MergeConflictFile {
  /** Absolute path, resolved against the repository root. */
  filePath: string;
  /** Common ancestor content. Absent for add/add conflicts. */
  base?: string;
  /** Content on the branch being merged into (HEAD at merge time). */
  ours?: string;
  /** Content on the incoming branch. */
  theirs?: string;
  /** What the agent actually committed. */
  resolved?: string;
  /**
   * True when the resolution genuinely removed the file. Distinct from a side
   * being present but unreadable — see {@link unavailable}.
   */
  resolvedDeleted?: boolean;
  /**
   * Sides that exist but whose content could not be captured (binary, over
   * {@link MAX_CONTENT_BYTES}, a submodule pointer, or past the total budget).
   * Tracked per side so one oversized side does not blank out a diff whose own
   * two sides were captured.
   */
  unavailable?: MergeSide[];
  additions: number;
  deletions: number;
}

export interface MergeResolution {
  /** Short sha of the branch merged into. */
  oursSha: string;
  /** Short sha of the incoming branch. */
  theirsSha: string;
  /** Human-readable description of the incoming commit, when resolvable. */
  theirsLabel?: string;
  files: MergeConflictFile[];
  /** True when the conflicted set was truncated at {@link MAX_CONFLICT_FILES}. */
  truncated?: boolean;
}

/** Raw record written by the hook; deliberately minimal so the hook stays fast. */
interface HookRecord {
  ours: string;
  theirs: string;
  resolvedTree: string;
}

function gitOptions(cwd: string) {
  return { cwd, encoding: 'utf-8' as const, maxBuffer: MAX_BUFFER };
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, gitOptions(cwd));
    return stdout;
  } catch (error) {
    dbg.worktree('merge-conflict-tracker: git %s failed: %o', args[0], error);
    return null;
  }
}

/** Resolves the `.git` directory for a worktree (a file-link for linked worktrees). */
async function getGitDir(worktreePath: string): Promise<string | null> {
  const stdout = await git(worktreePath, ['rev-parse', '--absolute-git-dir']);
  return stdout?.trim() || null;
}

/**
 * Every client-side hook git can invoke.
 *
 * `core.hooksPath` redirects *all* hook lookups, not just the one we care about,
 * so taking it over silently disables every hook the repository already had —
 * `commit-msg` (commitlint), `pre-push` (test gates), `prepare-commit-msg`
 * (issue-id injection). Each name here gets a forwarding stub so the user's
 * hooks keep running; only `pre-commit` also does our recording.
 */
const FORWARDED_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'pre-auto-gc',
  'push-to-checkout',
  'sendemail-validate',
  'post-index-change',
  'reference-transaction',
];

/**
 * Builds a stub that hands a hook straight back to the repository's own.
 *
 * The `-x` test runs at hook time rather than install time on purpose: a user who
 * runs `npx husky init` after we installed would otherwise have their new hooks
 * shadowed forever by a stub generated when the directory was empty.
 */
function buildForwardingStub(chainTo: string | null, hookName: string): string {
  if (chainTo === null) return '#!/bin/sh\nexit 0\n';
  const original = shellQuote(path.join(chainTo, hookName));
  return `#!/bin/sh
# Managed by Jean-Claude. Forwards to the repository's own hook, if any.
if [ -x ${original} ]; then
  exec ${original} "$@"
fi
exit 0
`;
}

/**
 * Builds the `pre-commit` script.
 *
 * The hook must be cheap and dependency-free — it runs on every commit the agent
 * makes. It writes three object ids and gets out of the way. `git write-tree`
 * turns the staged resolution into a real tree object, which keeps the content
 * reachable for reconstruction even after the merge commit lands.
 *
 * Recording happens *before* chaining because `exec` replaces this process; the
 * chained hook may still veto the commit, which is why a record alone is not
 * treated as proof that a merge was concluded (see {@link buildResolution}).
 *
 * @param chainTo - Hook directory that was in effect before we took over, so a
 *   `pre-commit` the user already had keeps running.
 */
function buildHookScript(chainTo: string | null): string {
  const chain =
    chainTo === null
      ? ''
      : `\nif [ -x ${shellQuote(path.join(chainTo, 'pre-commit'))} ]; then\n  exec ${shellQuote(path.join(chainTo, 'pre-commit'))} "$@"\nfi\n`;
  return `#!/bin/sh
# Managed by Jean-Claude. Records how a merge conflict was resolved.
# Only fires on the commit that concludes a merge (MERGE_HEAD still present).
gitdir=$(git rev-parse --absolute-git-dir 2>/dev/null) || gitdir=""
if [ -n "$gitdir" ] && [ -f "$gitdir/MERGE_HEAD" ]; then
  out="$gitdir/${RECORD_DIR}"
  mkdir -p "$out" 2>/dev/null
  ours=$(git rev-parse HEAD 2>/dev/null)
  theirs=$(tr '\\n' ' ' < "$gitdir/MERGE_HEAD" 2>/dev/null)
  tree=$(git write-tree 2>/dev/null)
  if [ -n "$ours" ] && [ -n "$theirs" ] && [ -n "$tree" ]; then
    printf '{"ours":"%s","theirs":"%s","resolvedTree":"%s"}' \\
      "$ours" "$theirs" "$tree" > "$out/$(date +%s)-$$.json" 2>/dev/null
  fi
fi
${chain}exit 0
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Installs the `pre-commit` hook for a single worktree.
 *
 * Scoped with `git config --worktree` on purpose: `core.hooksPath` normally
 * lives in the shared `.git/config`, so setting it from a worktree would hijack
 * hooks in the user's main checkout too. Enabling `extensions.worktreeConfig`
 * keeps the override local to this worktree.
 *
 * @returns True when the hook is in place.
 */
export async function installMergeHook(worktreePath: string): Promise<boolean> {
  const gitDir = await getGitDir(worktreePath);
  if (!gitDir) return false;

  // Only ever install into a linked worktree, which Jean-Claude created and
  // owns. In the primary checkout these two paths are equal, and that is the
  // user's own repository: writing `core.hooksPath` there would redirect the
  // hooks for every commit they make by hand, with nothing to undo it if the app
  // is force-quit. Merges there are still covered by the merge-commit backfill,
  // which needs no hook at all.
  //
  // Both paths are taken from one `--path-format=absolute` invocation so git
  // normalises them the same way. Resolving `--git-common-dir` ourselves would
  // compare a symlinked path against git's realpath-resolved `--absolute-git-dir`
  // and classify the primary checkout as linked — which on macOS, where `/tmp`
  // and `/var` are symlinks, is the common case rather than the exotic one.
  const dirs = await git(worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
    '--git-dir',
  ]);
  const [commonDirAbs, gitDirAbs] = (dirs ?? '')
    .trim()
    .split('\n')
    .map((line) => line.trim());
  if (!commonDirAbs || !gitDirAbs) {
    dbg.worktree('skipping merge hook install: could not resolve git dirs');
    return false;
  }
  if (path.resolve(commonDirAbs) === path.resolve(gitDirAbs)) {
    dbg.worktree('skipping merge hook install outside a linked worktree');
    return false;
  }

  const hooksDir = path.join(gitDir, 'jean-claude', 'hooks');

  // Read the repository's *own* setting, ignoring our per-worktree override, so
  // reinstalling never chains to ourselves and a hook manager the user installed
  // after our first run is still picked up. All scopes are consulted, not just
  // `--local`: a global `core.hooksPath` (a shared team hooks directory) is
  // exactly the setup whose hooks we would otherwise silently stop running.
  const configured = await readInheritedHooksPath(worktreePath);
  const chainTo =
    configured !== null
      ? path.resolve(worktreePath, configured)
      : // Linked worktrees share the primary checkout's hooks directory, which
        // lives under the common dir rather than this worktree's git dir.
        path.resolve(commonDirAbs, 'hooks');

  // A pathological config could still point the repository's own hooksPath at
  // our directory; chaining there would fork-bomb on every commit.
  const safeChainTo =
    chainTo !== null && path.resolve(chainTo) === path.resolve(hooksDir)
      ? null
      : chainTo;

  try {
    await writeHooks(hooksDir, safeChainTo);
    // `--worktree` requires the extension; enabling it is a no-op for repos that
    // have no per-worktree config yet.
    await execFileAsync(
      'git',
      ['config', 'extensions.worktreeConfig', 'true'],
      gitOptions(worktreePath),
    );
    await execFileAsync(
      'git',
      ['config', '--worktree', 'core.hooksPath', hooksDir],
      gitOptions(worktreePath),
    );
    dbg.worktree(
      'merge hook installed at %s (chain: %s)',
      hooksDir,
      safeChainTo,
    );
    return true;
  } catch (error) {
    dbg.worktree('merge hook install failed: %o', error);
    return false;
  }
}

/**
 * Resolves the `core.hooksPath` the repository would use without our override.
 *
 * `git config --get` alone would return our own worktree-scoped value once
 * installed, which we would then chain to — a fork bomb. Reading every scope
 * with its origin lets us drop only our own entry and keep whatever global,
 * system or local value the user actually configured.
 */
async function readInheritedHooksPath(
  worktreePath: string,
): Promise<string | null> {
  const stdout = await git(worktreePath, [
    'config',
    '--show-origin',
    '--get-all',
    'core.hooksPath',
  ]);
  if (!stdout) return null;
  let inherited: string | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // `<origin>\t<value>` — origin is e.g. `file:/path/.git/config.worktree`.
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;
    const origin = line.slice(0, tabIndex);
    const value = line.slice(tabIndex + 1).trim();
    if (origin.endsWith('config.worktree')) continue;
    if (value) inherited = value;
  }
  return inherited;
}

/**
 * Writes our `pre-commit` plus a forwarding stub for every other hook.
 *
 * Without the stubs, pointing `core.hooksPath` at this directory would disable
 * the repository's entire hook set.
 */
async function writeHooks(
  hooksDir: string,
  chainTo: string | null,
): Promise<void> {
  await fs.mkdir(hooksDir, { recursive: true });
  const write = async (name: string, contents: string) => {
    const hookPath = path.join(hooksDir, name);
    await fs.writeFile(hookPath, contents, 'utf-8');
    await fs.chmod(hookPath, 0o755);
  };
  await write('pre-commit', buildHookScript(chainTo));
  await Promise.all(
    FORWARDED_HOOKS.map((name) =>
      write(name, buildForwardingStub(chainTo, name)),
    ),
  );
}

/** Removes the `core.hooksPath` override, restoring the repository's own hooks. */
export async function uninstallMergeHook(worktreePath: string): Promise<void> {
  await git(worktreePath, [
    'config',
    '--worktree',
    '--unset',
    'core.hooksPath',
  ]);
}

/** Current HEAD sha, used as the lower bound for the merge-commit backfill. */
export async function getHeadSha(worktreePath: string): Promise<string | null> {
  const stdout = await git(worktreePath, ['rev-parse', 'HEAD']);
  return stdout?.trim() || null;
}

/**
 * Collects every merge resolution that happened since `sinceHead`.
 *
 * Two sources, deduplicated by the `ours..theirs` pair:
 *  - records dropped by the hook (covers merges concluded normally, and merges
 *    whose commit was later amended away)
 *  - merge commits reachable from HEAD but not from `sinceHead` (covers
 *    `--no-verify`, which skips the hook entirely)
 */
export async function captureMergeResolutions({
  worktreePath,
  sinceHead,
}: {
  worktreePath: string;
  sinceHead: string | null;
}): Promise<MergeResolution[]> {
  const records = await drainHookRecords(worktreePath);
  const backfilled = await backfillFromMergeCommits(worktreePath, sinceHead);

  // Backfilled records come from commits that actually landed, so they win over
  // hook records for the same merge. A hook record is written before the
  // repository's own `pre-commit` runs, so a rejected attempt leaves one behind
  // whose tree is the resolution the agent then threw away.
  const seen = new Set<string>();
  const resolutions: MergeResolution[] = [];
  for (const record of [...backfilled, ...records]) {
    const key = `${record.ours}..${record.theirs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resolution = await buildResolution(worktreePath, record);
    if (resolution) resolutions.push(resolution);
  }
  if (resolutions.length) {
    dbg.worktree('captured %d merge resolution(s)', resolutions.length);
  }
  return resolutions;
}

/** Reads and deletes the hook's records, so each is reported exactly once. */
async function drainHookRecords(worktreePath: string): Promise<HookRecord[]> {
  const gitDir = await getGitDir(worktreePath);
  if (!gitDir) return [];

  // The hook records before it chains to the repository's own `pre-commit`,
  // which may still veto the commit. If that same merge is still in progress,
  // nothing was concluded and reporting it would claim a resolution the agent
  // never landed. A later successful commit writes a fresh record.
  const [pendingTheirs, head] = await Promise.all([
    fs
      .readFile(path.join(gitDir, 'MERGE_HEAD'), 'utf-8')
      .then((raw) => raw.trim().split('\n')[0]?.trim() ?? null)
      .catch(() => null),
    git(worktreePath, ['rev-parse', 'HEAD']).then((out) => out?.trim() ?? null),
  ]);

  const dir = path.join(gitDir, RECORD_DIR);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const records: HookRecord[] = [];
  // Newest first: filenames are `<unix-seconds>-<pid>.json`, and when one merge
  // produced several records (an attempt rejected by a chained hook, then a
  // successful retry) the later one is the resolution that stands.
  for (const name of names.sort().reverse()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const raw = await fs.readFile(file, 'utf-8').catch(() => null);
    await fs.rm(file, { force: true }).catch(() => {});
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as HookRecord;
      if (!parsed.ours || !parsed.theirs || !parsed.resolvedTree) continue;
      // The hook records every MERGE_HEAD line. More than one means an octopus
      // merge, which has no faithful two-sided replay — reporting it against a
      // single parent would show a resolution the agent never made.
      if (parsed.theirs.trim().includes(' ')) {
        dbg.worktree('skipping octopus merge record (%s)', parsed.theirs.trim());
        continue;
      }
      const theirs = parsed.theirs.trim();
      // Same merge still open at the same HEAD: the commit that wrote this
      // record was rejected downstream, so the merge was never concluded.
      if (
        pendingTheirs !== null &&
        pendingTheirs === theirs &&
        head === parsed.ours
      ) {
        dbg.worktree('dropping record for a merge that never landed (%s)', theirs);
        continue;
      }
      records.push({ ...parsed, theirs });
    } catch {
      // A truncated record is not worth failing the turn over.
    }
  }
  return records;
}

/**
 * Reconstructs records from merge commits created during the turn.
 *
 * A merge commit carries everything needed on its own: parent 1 is ours,
 * parent 2 is theirs, and its tree is the resolution. This is what makes the
 * feature survive `--no-verify`.
 */
async function backfillFromMergeCommits(
  worktreePath: string,
  sinceHead: string | null,
): Promise<HookRecord[]> {
  if (!sinceHead) return [];
  const range = `${sinceHead}..HEAD`;
  const stdout = await git(worktreePath, [
    'rev-list',
    '--merges',
    // Without `--first-parent` this also returns merge commits that merely
    // became *reachable* this turn — every PR merge on the branch being merged
    // in — and each would be replayed and reported as the agent's own work.
    // Walking first parents only yields merges performed onto this branch.
    '--first-parent',
    '--format=%H %T %P',
    '--no-commit-header',
    range,
  ]);
  if (!stdout) return [];
  const records: HookRecord[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    // <sha> <tree> <parent1> <parent2> ...
    if (parts.length < 4) continue;
    const [, tree, ours, theirs] = parts;
    if (!tree || !ours || !theirs) continue;
    // An octopus merge has no faithful two-sided replay; skip rather than
    // report a resolution reconstructed against only one of its parents.
    if (parts.length > 4) {
      dbg.worktree('skipping octopus merge %s (%d parents)', parts[0], parts.length - 2);
      continue;
    }
    records.push({ ours, theirs, resolvedTree: tree });
  }
  return records;
}

/**
 * Turns a record into a full resolution by replaying the merge.
 *
 * `git merge-tree --write-tree` re-runs the same three-way merge git originally
 * performed and reports the conflicted entries as index stages — stage 1 is the
 * common ancestor, stage 2 ours, stage 3 theirs. That gives the exact conflicted
 * file set plus a blob id per side, without needing anything captured at the
 * moment the conflict occurred.
 *
 * Returns null when the merge replayed cleanly, i.e. there was no conflict to
 * show and the plain turn diff already tells the whole story.
 */
async function buildResolution(
  worktreePath: string,
  record: HookRecord,
): Promise<MergeResolution | null> {
  const stages = await readConflictStages(worktreePath, record);
  if (stages.size === 0) return null;

  const root = (await git(worktreePath, ['rev-parse', '--show-toplevel']))
    ?.trim();
  const base = root || worktreePath;

  const paths = [...stages.keys()].sort();
  const truncated = paths.length > MAX_CONFLICT_FILES;
  const kept = truncated ? paths.slice(0, MAX_CONFLICT_FILES) : paths;

  // One listing of the resolved tree answers, for every file at once, both
  // "does this path still exist" and "is it a blob". Deriving that per side from
  // whether a `<tree>:<path>` string is non-empty cannot work — the string is
  // always non-empty, which silently made every deletion look unreadable.
  const resolvedEntries = await listTreeBlobs(worktreePath, record.resolvedTree);

  let budget = MAX_TOTAL_CONTENT_BYTES;
  const files: MergeConflictFile[] = [];
  for (const filePath of kept) {
    const stage = stages.get(filePath)!;
    const resolvedOid = resolvedEntries.get(filePath);
    let exhausted = false;
    /**
     * Reads one side.
     *
     * `missing` means the side genuinely has no blob — an add/add conflict has
     * no base, a modify/delete has no ours, a deleted resolution has no result.
     * `unavailable` means a blob exists but we would not persist it (binary,
     * oversized, a submodule pointer). The UI renders those two very
     * differently, so they must not collapse into one `undefined`.
     */
    const read = async (
      oid: string | undefined,
    ): Promise<{ missing: boolean; unavailable: boolean; content?: string }> => {
      if (!oid) return { missing: true, unavailable: false };
      if (budget <= 0) {
        exhausted = true;
        return { missing: false, unavailable: true };
      }
      // Reserve before awaiting: the sides below are read concurrently, so a
      // check-then-act here lets every one of them pass the same budget test.
      budget -= MAX_CONTENT_BYTES;
      const content = await readBlob(worktreePath, oid);
      // Refund the difference between the reservation and the real size.
      budget += MAX_CONTENT_BYTES - Buffer.byteLength(content ?? '', 'utf-8');
      if (content === null) return { missing: false, unavailable: true };
      return { missing: false, unavailable: false, content };
    };
    const [baseContent, ours, theirs, resolved] = await Promise.all([
      read(stage.base),
      read(stage.ours),
      read(stage.theirs),
      read(resolvedOid),
    ]);
    if (exhausted) {
      dbg.worktree('merge resolution content budget exhausted at %s', filePath);
    }
    const { additions, deletions } = await diffSides({
      worktreePath,
      fromOid: stage.ours,
      toOid: resolvedOid,
      fromContent: ours.content,
      toContent: resolved.content,
    });
    // Per side, not per file: an oversized `theirs` must not blank out the
    // resolution diff, whose own two sides were captured fine.
    const unavailable: MergeSide[] = [];
    if (baseContent.unavailable) unavailable.push('base');
    if (ours.unavailable) unavailable.push('ours');
    if (theirs.unavailable) unavailable.push('theirs');
    if (resolved.unavailable) unavailable.push('resolved');
    files.push({
      filePath: path.resolve(base, filePath),
      base: baseContent.content,
      ours: ours.content,
      theirs: theirs.content,
      resolved: resolved.content,
      resolvedDeleted: resolved.missing,
      unavailable: unavailable.length ? unavailable : undefined,
      additions,
      deletions,
    });
  }

  const [oursSha, theirsSha, theirsLabel] = await Promise.all([
    git(worktreePath, ['rev-parse', '--short', record.ours]),
    git(worktreePath, ['rev-parse', '--short', record.theirs]),
    git(worktreePath, ['log', '-1', '--format=%s', record.theirs]),
  ]);

  return {
    oursSha: oursSha?.trim() || record.ours.slice(0, 7),
    theirsSha: theirsSha?.trim() || record.theirs.slice(0, 7),
    theirsLabel: theirsLabel?.trim() || undefined,
    files,
    truncated: truncated || undefined,
  };
}

/**
 * Replays the merge and parses the conflicted entries.
 *
 * Output of `git merge-tree --write-tree <ours> <theirs>` on conflict is the
 * merged tree oid, a blank line, then one line per conflicted stage:
 * `<mode> <oid> <stage>\t<path>`.
 */
async function readConflictStages(
  worktreePath: string,
  record: HookRecord,
): Promise<Map<string, { base?: string; ours?: string; theirs?: string }>> {
  const stages = new Map<
    string,
    { base?: string; ours?: string; theirs?: string }
  >();
  // git exits non-zero precisely when the replay conflicts, which is the case we
  // care about; a zero exit means the merge was clean and there is nothing to
  // show. Either way the payload we need is on stdout.
  let stdout: string;
  try {
    await execFileAsync(
      'git',
      ['merge-tree', '--write-tree', '-z', record.ours, record.theirs],
      gitOptions(worktreePath),
    );
    return stages;
  } catch (error) {
    const failure = error as { stdout?: string; code?: number | string };
    // git signals "conflicts found" with exit code 1 and the payload on stdout.
    // Any other failure — git missing (ENOENT), an unreachable object (128), or
    // output past maxBuffer, where `stdout` holds a truncated record that would
    // parse into a bogus file path — must not be mistaken for a clean merge.
    if (failure.code !== 1 || typeof failure.stdout !== 'string') {
      dbg.worktree('merge-tree replay failed (code %o): %o', failure.code, error);
      return stages;
    }
    stdout = failure.stdout;
  }

  const sections = stdout.split('\0');
  // sections[0] is the merged tree oid; conflicted stage entries follow until a
  // blank section separates them from the informational messages.
  for (let index = 1; index < sections.length; index += 1) {
    const entry = sections[index];
    if (entry === undefined) continue;
    if (entry === '') break;
    const match = /^(\d+) ([0-9a-f]+) ([123])\t(.*)$/s.exec(entry);
    if (!match) continue;
    const [, mode, oid, stageNumber, filePath] = match;
    if (!mode || !oid || !filePath) continue;
    // A gitlink stage names a commit, not a blob. Record the file as conflicted
    // but leave the side unset, so it reads as unavailable rather than as a
    // failed blob read.
    if (!TEXT_MODES.has(mode)) {
      if (!stages.has(filePath)) stages.set(filePath, {});
      continue;
    }
    const current = stages.get(filePath) ?? {};
    if (stageNumber === '1') current.base = oid;
    if (stageNumber === '2') current.ours = oid;
    if (stageNumber === '3') current.theirs = oid;
    stages.set(filePath, current);
  }
  return stages;
}

/**
 * Line counts for the resolution itself (ours → resolved).
 *
 * Only counts are produced: the card renders from the captured `ours`/`resolved`
 * contents via `DiffView`, so a stored patch would be dead weight in the message
 * row — and unlike the turn-summary path there is no patch size cap here.
 */
async function diffSides({
  worktreePath,
  fromOid,
  toOid,
  fromContent,
  toContent,
}: {
  worktreePath: string;
  fromOid: string | undefined;
  toOid: string | undefined;
  fromContent: string | undefined;
  toContent: string | undefined;
}): Promise<{ additions: number; deletions: number }> {
  // A side with no blob is an addition or a deletion, not "no change": a
  // modify/delete conflict resolved by keeping a 200-line file would otherwise
  // report +0/-0 next to a diff showing 200 lines.
  //
  // Counted from content rather than by diffing against git's empty blob, which
  // is not in the object database unless something happened to write it — `git
  // diff <oid> <empty>` fails with "bad object" and silently yields 0/0.
  if (!fromOid || !toOid) {
    if (!fromOid && !toOid) return { additions: 0, deletions: 0 };
    const lines = countLines(fromOid ? fromContent : toContent);
    return fromOid
      ? { additions: 0, deletions: lines }
      : { additions: lines, deletions: 0 };
  }
  if (fromOid === toOid) return { additions: 0, deletions: 0 };
  // `git diff <blob> <blob>` compares two objects directly, so nothing needs to
  // be checked out and the real worktree and index stay untouched.
  const numstat = await runDiff(worktreePath, [
    'diff',
    '--numstat',
    fromOid,
    toOid,
  ]);
  const [adds, dels] = (numstat ?? '').trim().split(/\s+/);
  return {
    additions: Number.parseInt(adds ?? '0', 10) || 0,
    deletions: Number.parseInt(dels ?? '0', 10) || 0,
  };
}

async function runDiff(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, gitOptions(cwd));
    return stdout;
  } catch (error) {
    // `git diff` exits non-zero when there are differences under some configs.
    const failure = error as { stdout?: string };
    return typeof failure.stdout === 'string' ? failure.stdout : null;
  }
}

/**
 * Grouped entry points, mirroring the `shellEditTracker` singleton this sits
 * alongside in the turn lifecycle.
 */
export const mergeConflictTracker = {
  install: installMergeHook,
  uninstall: uninstallMergeHook,
  capture: captureMergeResolutions,
  headSha: getHeadSha,
};

/**
 * Lists every text blob in a tree, keyed by path.
 *
 * Used to answer "does this path still exist in the resolution, and is it
 * renderable" for all files in one subprocess. Non-text modes (submodules) are
 * omitted, so they read as unavailable rather than missing.
 */
async function listTreeBlobs(
  worktreePath: string,
  tree: string,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  const stdout = await git(worktreePath, ['ls-tree', '-r', '-z', tree]);
  if (!stdout) return entries;
  for (const entry of stdout.split('\0')) {
    if (!entry) continue;
    // `<mode> <type> <oid>\t<path>`
    const match = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(entry);
    if (!match) continue;
    const [, mode, oid, filePath] = match;
    if (!mode || !oid || !filePath) continue;
    if (!TEXT_MODES.has(mode)) continue;
    entries.set(filePath, oid);
  }
  return entries;
}

/** Reads a blob, skipping binaries and anything oversized. */
async function readBlob(
  worktreePath: string,
  revision: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['cat-file', 'blob', revision],
      { cwd: worktreePath, encoding: 'buffer', maxBuffer: MAX_CONTENT_BYTES },
    );
    const buffer = stdout as unknown as Buffer;
    if (buffer.length > MAX_CONTENT_BYTES) return null;
    // Git's own heuristic: a NUL byte anywhere means "treat as binary".
    if (buffer.includes(0)) return null;
    return buffer.toString('utf-8');
  } catch {
    return null;
  }
}
