/**
 * Lightweight git tree snapshots used to capture file changes made outside the
 * Edit/Write tools (for example `sed -i` or a python script run through Bash).
 *
 * The snapshot writes to a temporary index file via `GIT_INDEX_FILE`, so the
 * repository's real index, HEAD, refs and working tree are never touched. The
 * only side effect is unreferenced blob/tree objects in `.git/objects`, which
 * git prunes during its normal garbage collection.
 */

import { execFile } from 'child_process';
// Uses `node:fs/promises` (not `fs/promises`) on purpose: git needs the real
// filesystem, and the test setup mocks the unprefixed specifier with memfs.
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { nanoid } from 'nanoid';

import { dbg } from '../lib/debug';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024;

/** Per-file patch size cap, so a huge generated file cannot bloat a message row. */
const MAX_PATCH_BYTES = 256 * 1024;
/**
 * Per-file content size cap. Full before/after content is persisted in the
 * message row, so this bounds how much a single file can contribute.
 */
const MAX_CONTENT_BYTES = 256 * 1024;

/** Total before+after content captured for one diff, across all files. */
const MAX_TOTAL_CONTENT_BYTES = 4 * 1024 * 1024;

/** Bounds concurrent `git show` processes spawned while reading contents. */
const CONTENT_READ_CONCURRENCY = 8;

export interface TreeDiffFile {
  filePath: string;
  type: 'add' | 'update' | 'delete';
  patch?: string;
  additions: number;
  deletions: number;
  before?: string;
  after?: string;
}

/**
 * Allocates a path for a scratch index that can be reused across snapshots.
 *
 * Reuse matters for performance: an index seeded by `read-tree` has no stat
 * information, so the following `git add -A` must re-hash every file in the
 * worktree. Once `add` has run, the index carries stat data and later snapshots
 * only hash files whose mtime/size actually changed.
 */
export function createScratchIndexPath(): string {
  return path.join(os.tmpdir(), `jean-claude-index-${nanoid(10)}`);
}

/**
 * Resolves the repository root for a directory.
 *
 * Tree diffs are always root-relative, even when git runs from a subdirectory,
 * so paths must be resolved against the root rather than the working directory.
 */
export async function getRepoRoot(
  worktreePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: worktreePath, encoding: 'utf-8' },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Removes a scratch index created by {@link createScratchIndexPath}. */
export async function removeScratchIndex(indexFile: string): Promise<void> {
  await fs.rm(indexFile, { force: true }).catch(() => {});
}

/**
 * Captures the current state of the working tree (including untracked,
 * non-ignored files) as a git tree object hash.
 *
 * @param indexFile - Scratch index to use. Reusing the same path across
 *   snapshots of one worktree keeps git's stat cache warm; the repository's own
 *   index is never touched either way.
 * @returns The tree hash, or null when the snapshot could not be taken.
 */
export async function snapshotWorktreeTree(
  worktreePath: string,
  reusableIndexFile?: string,
): Promise<string | null> {
  const indexFile = reusableIndexFile ?? createScratchIndexPath();
  const options = {
    cwd: worktreePath,
    encoding: 'utf-8' as const,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_INDEX_FILE: indexFile },
  };
  try {
    // Seed the scratch index the first time it is used. A repository without
    // commits has no HEAD, in which case we start from an empty index.
    const alreadySeeded = await fs
      .stat(indexFile)
      .then(() => true)
      .catch(() => false);
    if (!alreadySeeded) {
      try {
        await execFileAsync('git', ['read-tree', 'HEAD'], options);
      } catch {
        await execFileAsync('git', ['read-tree', '--empty'], options);
      }
    }
    await execFileAsync('git', ['add', '-A', '.'], options);
    const { stdout } = await execFileAsync('git', ['write-tree'], options);
    const treeHash = stdout.trim();
    return treeHash || null;
  } catch (error) {
    dbg.worktree('snapshotWorktreeTree failed: %o', error);
    return null;
  } finally {
    if (!reusableIndexFile) await removeScratchIndex(indexFile);
  }
}

function parseNumstat(output: string): Map<
  string,
  { additions: number; deletions: number }
> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.split('\0')) {
    if (!line.trim()) continue;
    const [adds, dels, ...pathParts] = line.split('\t');
    const filePath = pathParts.join('\t');
    if (!filePath) continue;
    stats.set(filePath, {
      additions: adds === '-' ? 0 : Number.parseInt(adds ?? '0', 10) || 0,
      deletions: dels === '-' ? 0 : Number.parseInt(dels ?? '0', 10) || 0,
    });
  }
  return stats;
}

/**
 * Extracts the post-image path from a `diff --git` header.
 *
 * The header is either `a/path b/path` or, for paths with unusual characters,
 * the C-quoted form `"a/path" "b/path"`. Unquoted paths may contain spaces, so
 * the `+++ b/path` line that follows is used instead whenever it is available.
 */
function parsePatchHeaderPath(chunk: string): string | null {
  const plusLine = /^\+\+\+ (?:b\/(.*)|"b\/(.*)")$/m.exec(chunk);
  if (plusLine) {
    const quoted = plusLine[2];
    if (quoted !== undefined) return unquoteGitPath(quoted);
    if (plusLine[1] && plusLine[1] !== '/dev/null') return plusLine[1];
  }
  const header = chunk.split('\n', 1)[0]?.trim() ?? '';
  const quotedHeader = /^"a\/(.+)" "b\/(.+)"$/.exec(header);
  if (quotedHeader?.[2]) return unquoteGitPath(quotedHeader[2]);
  const match = /^a\/(.+?) b\/(.+)$/.exec(header);
  return match?.[2] ?? match?.[1] ?? null;
}

/** Decodes git's C-style quoting (octal escapes for non-ASCII bytes). */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < quoted.length; index += 1) {
    const char = quoted[index]!;
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf-8'));
      continue;
    }
    const escape = quoted[index + 1] ?? '';
    const octal = /^[0-7]{3}$/.exec(quoted.slice(index + 1, index + 4));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const simple: Record<string, number> = {
      a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92,
    };
    bytes.push(simple[escape] ?? escape.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString('utf-8');
}

/** Splits a combined `git diff` output into one patch per file path. */
function splitPatchByFile(patchOutput: string): Map<string, string> {
  const patches = new Map<string, string>();
  const chunks = patchOutput.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const filePath = parsePatchHeaderPath(chunk);
    if (!filePath) continue;
    patches.set(filePath, `diff --git ${chunk}`);
  }
  return patches;
}

/**
 * Diffs two tree snapshots taken by {@link snapshotWorktreeTree}.
 *
 * @param maxPatchFiles - Beyond this many changed files, patches are omitted
 *   and only per-file line counts are returned.
 * @param maxFiles - Hard cap on returned files. A command like `pnpm build` in a
 *   repo with non-ignored build output can touch thousands of files, which must
 *   not all be serialized into a single agent message.
 */
export async function diffWorktreeTrees({
  worktreePath,
  before,
  after,
  maxPatchFiles = 50,
  maxFiles = 200,
}: {
  worktreePath: string;
  before: string;
  after: string;
  maxPatchFiles?: number;
  maxFiles?: number;
}): Promise<TreeDiffFile[]> {
  if (before === after) return [];
  const options = {
    cwd: worktreePath,
    encoding: 'utf-8' as const,
    maxBuffer: MAX_BUFFER,
  };
  try {
    const [nameStatusResult, numstatResult] = await Promise.all([
      execFileAsync(
        'git',
        ['diff', '--name-status', '-z', '--no-renames', before, after],
        options,
      ),
      execFileAsync(
        'git',
        ['diff', '--numstat', '-z', '--no-renames', before, after],
        options,
      ),
    ]);

    const stats = parseNumstat(numstatResult.stdout);
    const entries = nameStatusResult.stdout.split('\0').filter(Boolean);
    const files: TreeDiffFile[] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const statusCode = entries[index]?.[0];
      const filePath = entries[index + 1];
      if (!statusCode || !filePath) continue;
      const type =
        statusCode === 'A' ? 'add' : statusCode === 'D' ? 'delete' : 'update';
      files.push({
        filePath,
        type,
        additions: stats.get(filePath)?.additions ?? 0,
        deletions: stats.get(filePath)?.deletions ?? 0,
      });
    }

    if (files.length > maxFiles) {
      dbg.worktree(
        'diffWorktreeTrees truncating %d changed files to %d',
        files.length,
        maxFiles,
      );
      return files.slice(0, maxFiles);
    }
    if (files.length === 0) return files;
    if (files.length > maxPatchFiles) return files;

    await attachFileContents(worktreePath, before, after, files);

    // Patches are a nice-to-have: if the diff is too large for the buffer we
    // still return the per-file line counts rather than losing the change.
    try {
      const { stdout: patchOutput } = await execFileAsync(
        'git',
        ['diff', '--no-renames', '--no-color', before, after],
        options,
      );
      const patches = splitPatchByFile(patchOutput);
      for (const file of files) {
        const patch = patches.get(file.filePath);
        if (patch && Buffer.byteLength(patch, 'utf-8') <= MAX_PATCH_BYTES) {
          file.patch = patch;
        }
      }
    } catch (error) {
      dbg.worktree('diffWorktreeTrees patch fetch failed: %o', error);
    }
    return files;
  } catch (error) {
    dbg.worktree('diffWorktreeTrees failed: %o', error);
    return [];
  }
}

/**
 * Fills in full before/after content for each changed file, so the renderer can
 * show one coherent diff per file instead of stitching fragmented patches.
 *
 * Reads run at bounded concurrency (each read is a `git show` child process) and
 * stop once the total captured content passes {@link MAX_TOTAL_CONTENT_BYTES};
 * line counts and patches still describe the change in that case.
 */
async function attachFileContents(
  worktreePath: string,
  before: string,
  after: string,
  files: TreeDiffFile[],
): Promise<void> {
  let totalBytes = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++];
      if (!file) continue;
      if (totalBytes >= MAX_TOTAL_CONTENT_BYTES) return;
      const [beforeContent, afterContent] = await Promise.all([
        file.type === 'add'
          ? null
          : readTreeFile(worktreePath, before, file.filePath),
        file.type === 'delete'
          ? null
          : readTreeFile(worktreePath, after, file.filePath),
      ]);
      const size =
        (beforeContent === null ? 0 : Buffer.byteLength(beforeContent)) +
        (afterContent === null ? 0 : Buffer.byteLength(afterContent));
      if (totalBytes + size > MAX_TOTAL_CONTENT_BYTES) {
        dbg.worktree('diffWorktreeTrees content budget exhausted');
        totalBytes = MAX_TOTAL_CONTENT_BYTES;
        return;
      }
      totalBytes += size;
      if (beforeContent !== null) file.before = beforeContent;
      if (afterContent !== null) file.after = afterContent;
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(CONTENT_READ_CONCURRENCY, files.length) },
      worker,
    ),
  );
}

/**
 * Returns a blob's text content, or null when it is missing, oversized or
 * binary. Binary blobs are skipped rather than decoded, so mojibake is never
 * persisted or rendered as a text diff.
 */
async function readTreeFile(
  worktreePath: string,
  tree: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${tree}:${filePath}`],
      {
        cwd: worktreePath,
        encoding: 'buffer',
        maxBuffer: MAX_CONTENT_BYTES,
      },
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
