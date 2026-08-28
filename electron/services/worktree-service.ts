import * as fs from 'fs/promises';
import * as path from 'path';
import { exec, execFile, type ExecOptions } from 'child_process';
import { promisify } from 'util';


import { app } from 'electron';
import ignore from 'ignore';
import { nanoid } from 'nanoid';



import { getImageMimeType, isSvgPath } from '@shared/image-types';
import {
  isSpreadsheetPath,
  MAX_SPREADSHEET_BYTES,
} from '@shared/spreadsheet-types';
import type { BranchInfo } from '@shared/types';
import type { WorktreeFileCopyEntry } from '@shared/permission-types';



import { isEnoent, pathExists } from '../lib/fs';
import { dbg } from '../lib/debug';
import { ProjectRepository } from '../database/repositories/projects';



import {
  addKeyToAgent,
  getSshAgentStatus,
  isKeyLoadedInAgent,
  runWithSshAskpass,
  type SshPromptRequest,
} from './ssh-askpass-broker';
import {
  buildWorktreeSettings,
  readSettings,
} from './permission-settings-service';
import { formatCreateWorktreeError } from './utils-worktree-errors';
import { installMcpForWorktree } from './mcp-template-service';


const execAsync = promisify(exec) as (
  command: string,
  options?: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

const COMMIT_IGNORE_RELATIVE_PATH = path.join('.jean-claude', 'ignore');

function getCommitIgnorePath(projectPath: string): string {
  return path.join(projectPath, COMMIT_IGNORE_RELATIVE_PATH);
}

export async function getProjectCommitIgnore(
  projectPath: string,
): Promise<string> {
  const ignorePath = getCommitIgnorePath(projectPath);
  try {
    return await fs.readFile(ignorePath, 'utf-8');
  } catch (error) {
    if (isEnoent(error)) return '';
    throw error;
  }
}

export async function updateProjectCommitIgnore({
  projectPath,
  content,
}: {
  projectPath: string;
  content: string;
}): Promise<void> {
  const ignorePath = getCommitIgnorePath(projectPath);
  await fs.mkdir(path.dirname(ignorePath), { recursive: true });
  await fs.writeFile(ignorePath, content, 'utf-8');
}

async function getIgnoredCommitPaths({
  worktreePath,
  projectPath,
}: {
  worktreePath: string;
  projectPath?: string;
}): Promise<{ ignoredPaths: Set<string>; ignoredStagedPaths: Set<string> }> {
  if (!projectPath) {
    return { ignoredPaths: new Set(), ignoredStagedPaths: new Set() };
  }

  const ignoreContent = await getProjectCommitIgnore(projectPath);
  if (!ignoreContent.trim()) {
    return { ignoredPaths: new Set(), ignoredStagedPaths: new Set() };
  }

  const matcher = ignore().add(ignoreContent);
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
  );
  const entries = stdout.split('\0').filter(Boolean);
  const ignoredPaths = new Set<string>();
  const ignoredStagedPaths = new Set<string>();

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    const sourcePath =
      status[0] === 'R' || status[0] === 'C' ? entries[i + 1] : undefined;
    const isIgnored =
      matcher.ignores(filePath) ||
      (status[0] === 'R' &&
        sourcePath !== undefined &&
        matcher.ignores(sourcePath));
    if (isIgnored) {
      ignoredPaths.add(filePath);
      if (status[0] !== ' ' && status[0] !== '?') {
        ignoredStagedPaths.add(filePath);
      }
    }
    if (sourcePath !== undefined) i += 1;
  }

  return { ignoredPaths, ignoredStagedPaths };
}

async function runGitPathCommand({
  worktreePath,
  args,
  paths,
}: {
  worktreePath: string;
  args: string[];
  paths: string[];
}): Promise<void> {
  for (let i = 0; i < paths.length; i += 100) {
    await execFileAsync('git', [...args, '--', ...paths.slice(i, i + 100)], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
  }
}

/**
 * Stages every change in the repository except `excludedPaths`.
 *
 * Uses a broad `:/` pathspec narrowed by `:(exclude)` pathspecs rather than
 * listing the included paths. Naming a path explicitly makes `git add` fail
 * hard when that path is matched by a .gitignore rule but still appears in
 * `git status` (e.g. a tracked file that was `git rm --cached`-ed while
 * staying on disk); a broad pathspec lets git apply .gitignore itself.
 *
 * The pathspecs go over stdin because they cannot be chunked -- an exclude
 * only narrows the pathspec it is passed alongside -- and a large ignore list
 * would otherwise overflow ARG_MAX.
 *
 * `:/` and the `top` magic keep every pathspec relative to the repository
 * root, matching the repo-root-relative paths that `git status` reports, so
 * this stays correct even if `worktreePath` is a subdirectory of the repo.
 */
async function gitAddAllExcept({
  worktreePath,
  excludedPaths,
}: {
  worktreePath: string;
  excludedPaths: Set<string>;
}): Promise<void> {
  const pathspecs = [
    ':/',
    ...[...excludedPaths].map((p) => `:(exclude,literal,top)${p}`),
  ];

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      'git',
      ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { cwd: worktreePath, encoding: 'utf-8' },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin?.on('error', reject);
    child.stdin?.end(pathspecs.join('\0'));
  });
}

async function hasStagedChanges(worktreePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet', '--exit-code'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    return false;
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 1) return true;
    throw error;
  }
}

async function gitCommit({
  cwd,
  message,
  noVerify = false,
}: {
  cwd: string;
  message: string;
  noVerify?: boolean;
}): Promise<void> {
  await execFileAsync(
    'git',
    ['commit', ...(noVerify ? ['--no-verify'] : []), '-m', message],
    {
      cwd,
      encoding: 'utf-8',
    },
  );
}

/**
 * Escapes a string for safe use in shell commands within double quotes.
 * Handles characters that have special meaning in bash: $ ` \ " !
 */
function escapeForShell(str: string): string {
  return str.replace(/[$`\\!"]/g, '\\$&');
}

/**
 * Checks if a file is binary by looking for null bytes in the first 8KB.
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/**
 * Normalizes a name to kebab-case, removing special characters.
 * Used for creating safe directory names from project names or prompts.
 */
export function normalizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // replace non-alphanumeric with dashes
      .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
      .slice(0, 50) || 'unnamed' // reasonable max length with fallback
  );
}

/**
 * Generates a worktree directory name from a prompt.
 * Takes first ~3-4 meaningful words, kebab-cases them, and adds a short unique suffix.
 */
export function generateWorktreeName(prompt: string): string {
  const words = prompt
    .split(/\s+/)
    .filter((word) => word.length > 2) // skip short words like "a", "to", etc.
    .slice(0, 4)
    .join(' ');

  const normalized = normalizeName(words);
  const suffix = nanoid(4);

  return `${normalized}-${suffix}`;
}

/**
 * Gets the base worktrees directory for Jean-Claude: ~/.jean-claude/worktrees/
 */
export function getWorktreesBaseDir(): string {
  const homeDir = app.getPath('home');
  return path.join(homeDir, '.jean-claude', 'worktrees');
}

/**
 * Depth below ~/.jean-claude/worktrees that a directory must sit at before we
 * will `rm -rf` it: <base>/<project>/<worktree>. This is what stops a project
 * whose worktreesPath was mis-pointed at the base itself from turning every
 * *other* project's folder into a deletion candidate.
 */
export const WORKTREE_DEPTH_BELOW_BASE = 2;

/**
 * Resolves a path through symlinks so comparisons against git's canonical
 * worktree paths (always real paths) succeed on macOS (/var -> /private/var).
 * Returns null when the path cannot be resolved.
 */
export async function canonicalizeWorktreePath(
  target: string,
): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

/** Path segments of `target` relative to the worktrees base, or null if outside it. */
export async function segmentsBelowWorktreesBase(
  target: string,
): Promise<string[] | null> {
  const base =
    (await canonicalizeWorktreePath(getWorktreesBaseDir())) ??
    getWorktreesBaseDir();
  const resolved =
    (await canonicalizeWorktreePath(target)) ?? path.resolve(target);
  if (resolved === base) return [];
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved.slice(base.length + path.sep.length).split(path.sep);
}

/**
 * Guards raw recursive deletion. Only directories that sit exactly where
 * Jean-Claude puts worktrees may be removed without git's involvement.
 */
export async function assertSafeToRawDelete(target: string): Promise<void> {
  const segments = await segmentsBelowWorktreesBase(target);
  if (segments === null) {
    throw new Error(
      `Refusing to delete "${target}" — it is not under "${getWorktreesBaseDir()}"`,
    );
  }
  if (segments.length < WORKTREE_DEPTH_BELOW_BASE) {
    throw new Error(
      `Refusing to delete "${target}" — expected a <base>/<project>/<worktree> path, got depth ${segments.length}`,
    );
  }
}

/**
 * Gets or creates the worktrees path for a project.
 * Uses the project's stored worktreesPath if available, otherwise creates a new one.
 */
export async function getOrCreateProjectWorktreesPath(
  projectId: string,
  projectName: string,
): Promise<string> {
  const project = await ProjectRepository.findById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  // If project already has a worktrees path, use it
  if (project.worktreesPath) {
    // Ensure the directory exists
    await fs.mkdir(project.worktreesPath, { recursive: true });
    return project.worktreesPath;
  }

  // Create a new worktrees path for this project
  const baseDir = getWorktreesBaseDir();
  const normalizedName = normalizeName(projectName);
  let worktreesPath = path.join(baseDir, normalizedName);

  // Handle collisions by checking for .project-id file
  let suffix = 1;
  while (await pathExists(worktreesPath)) {
    const projectIdFile = path.join(worktreesPath, '.project-id');
    if (await pathExists(projectIdFile)) {
      const existingId = (await fs.readFile(projectIdFile, 'utf-8')).trim();
      if (existingId === projectId) {
        // This is our directory, reuse it
        break;
      }
    }
    // Collision with different project, try next suffix
    suffix++;
    worktreesPath = path.join(baseDir, `${normalizedName}-${suffix}`);
  }

  // Create the directory and mark it with project ID
  await fs.mkdir(worktreesPath, { recursive: true });
  await fs.writeFile(path.join(worktreesPath, '.project-id'), projectId);

  // Save the worktrees path to the project
  await ProjectRepository.update(projectId, {
    worktreesPath,
    updatedAt: new Date().toISOString(),
  });

  return worktreesPath;
}

/**
 * Deletes the worktrees folder for a project and clears the stored path.
 */
export async function deleteProjectWorktreesFolder(
  projectId: string,
): Promise<void> {
  const project = await ProjectRepository.findById(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  if (project.worktreesPath && (await pathExists(project.worktreesPath))) {
    // Validate the path is under the expected worktrees base directory to
    // prevent accidental recursive deletion of arbitrary directories.
    const resolvedPath = await fs.realpath(project.worktreesPath);
    const expectedBase = getWorktreesBaseDir();
    if (
      !resolvedPath.startsWith(expectedBase + path.sep) &&
      resolvedPath !== expectedBase
    ) {
      throw new Error(
        `Refusing to delete worktrees path "${project.worktreesPath}" — it is not under the expected base directory "${expectedBase}"`,
      );
    }
    await fs.rm(project.worktreesPath, { recursive: true, force: true });
  }

  await ProjectRepository.update(projectId, {
    worktreesPath: null,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Gets the current HEAD commit hash for a git repository.
 */
export async function getCurrentCommitHash(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get current commit hash: ${error}`);
  }
}

/**
 * Gets the current branch name for a git repository.
 */
export async function getCurrentBranchName(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get current branch name: ${error}`);
  }
}

/**
 * Checks if a path is a git repository.
 */
export async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --git-dir', {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    return true;
  } catch {
    return false;
  }
}

export interface CreateWorktreeResult {
  worktreePath: string;
  startCommitHash: string;
  branchName: string;
  sourceBranch: string;
}

/**
 * Generates a worktree directory name from a task name.
 * Normalizes the name and adds a short unique suffix.
 */
export function generateWorktreeNameFromTaskName(taskName: string): string {
  const normalized = normalizeName(taskName);
  const suffix = nanoid(4);

  return `${normalized}-${suffix}`;
}

/**
 * Creates a git worktree for a task.
 *
 * @param projectPath - The path to the main git repository
 * @param projectId - The project ID
 * @param projectName - The project name (for directory naming)
 * @param prompt - The task prompt (fallback for worktree naming if taskName not provided)
 * @param taskName - Optional task name to use for worktree naming (preferred over prompt)
 * @returns The path to the created worktree and the starting commit hash
 */
export interface WorktreeDiffFile {
  path: string;
  originalPath?: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export interface WorktreeDiffResult {
  files: WorktreeDiffFile[];
  worktreeDeleted?: boolean;
}

export interface WorktreeLocalChanges {
  staged: WorktreeDiffFile[];
  unstaged: WorktreeDiffFile[];
  worktreeDeleted?: boolean;
}

export interface WorktreeFileContent {
  oldContent: string | null;
  newContent: string | null;
  isBinary: boolean;
  oldImageDataUrl?: string | null;
  newImageDataUrl?: string | null;
  /** Raw base64 bytes of a spreadsheet file, parsed client-side. */
  oldSpreadsheetBase64?: string | null;
  newSpreadsheetBase64?: string | null;
  spreadsheetTooLarge?: boolean;
}

function parseNameStatusOutput(output: string): WorktreeDiffFile[] {
  const files: WorktreeDiffFile[] = [];
  const entries = output.split('\0').filter(Boolean);
  for (let index = 0; index < entries.length;) {
    const inlineParts = entries[index]!.split('\t');
    const statusCode = inlineParts[0];
    const isRename = statusCode?.[0] === 'R' || statusCode?.[0] === 'C';
    const originalPath = isRename && inlineParts.length === 1
      ? entries[index + 1]
      : undefined;
    const filePath = inlineParts.length > 1
      ? inlineParts.slice(1).join('\t')
      : isRename
        ? entries[index + 2]
        : entries[index + 1];
    index += inlineParts.length > 1 ? 1 : isRename ? 3 : 2;
    const status = statusCode?.[0];
    if (!filePath || !status) continue;
    files.push({
      path: filePath,
      ...(originalPath ? { originalPath } : {}),
      status: status === 'A' || status === 'R' || status === 'C'
          ? status === 'A' ? 'added' : 'modified'
        : status === 'D'
          ? 'deleted'
          : 'modified',
      additions: 0,
      deletions: 0,
    });
  }
  return files;
}

async function readGitFileContent(
  worktreePath: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${ref === ':' ? ':' : `${ref}:`}${filePath}`],
      { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 15 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Reads a file from a git ref as base64. Unlike readGitFileContent this keeps
 * the raw bytes intact, which is required for binary formats like spreadsheets.
 */
async function readGitFileBase64(
  worktreePath: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['show', `${ref === ':' ? ':' : `${ref}:`}${filePath}`],
      {
        cwd: worktreePath,
        encoding: 'buffer',
        maxBuffer: MAX_SPREADSHEET_BYTES,
      },
    );
    return Buffer.from(stdout).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Reads a spreadsheet from the working tree as base64.
 *
 * Resolves symlinks and rejects anything that escapes the worktree, matching
 * the guard the text path applies in getWorktreeLocalFileContent — without it
 * a tracked symlink pointing outside the repo would leak its target's bytes
 * into the renderer.
 */
async function readSpreadsheetBase64FromDisk(
  worktreePath: string,
  filePath: string,
): Promise<{ base64: string | null; tooLarge: boolean }> {
  try {
    const fullPath = path.join(worktreePath, filePath);
    const [realRoot, realPath] = await Promise.all([
      fs.realpath(worktreePath),
      fs.realpath(fullPath),
    ]);
    if (
      realPath !== realRoot &&
      !realPath.startsWith(`${realRoot}${path.sep}`)
    ) {
      throw new Error(`File path escapes worktree: ${filePath}`);
    }
    const stats = await fs.stat(realPath);
    if (stats.size > MAX_SPREADSHEET_BYTES) {
      return { base64: null, tooLarge: true };
    }
    const buffer = await fs.readFile(realPath);
    return { base64: buffer.toString('base64'), tooLarge: false };
  } catch {
    return { base64: null, tooLarge: false };
  }
}

export async function getWorktreeLocalFileContent(
  worktreePath: string,
  filePath: string,
  status: 'added' | 'modified' | 'deleted',
  scope: 'staged' | 'unstaged',
  originalPath?: string,
): Promise<WorktreeFileContent> {
  const normalizedPath = path.normalize(filePath);
  if (
    path.isAbsolute(filePath) ||
    normalizedPath === '..' ||
    normalizedPath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Invalid worktree file path: ${filePath}`);
  }
  const oldRef = scope === 'staged' ? 'HEAD' : ':';

  // Spreadsheets are binary: ship raw bytes and let the renderer parse them.
  if (isSpreadsheetPath(filePath)) {
    const oldSpreadsheetBase64 =
      status === 'added'
        ? null
        : await readGitFileBase64(
            worktreePath,
            oldRef,
            originalPath ?? filePath,
          );
    let newSpreadsheetBase64: string | null = null;
    let spreadsheetTooLarge = false;
    if (status !== 'deleted') {
      if (scope === 'staged') {
        newSpreadsheetBase64 = await readGitFileBase64(
          worktreePath,
          ':',
          filePath,
        );
      } else {
        const result = await readSpreadsheetBase64FromDisk(
          worktreePath,
          filePath,
        );
        newSpreadsheetBase64 = result.base64;
        spreadsheetTooLarge = result.tooLarge;
      }
    }
    return {
      oldContent: null,
      newContent: null,
      isBinary: true,
      oldSpreadsheetBase64,
      newSpreadsheetBase64,
      spreadsheetTooLarge,
    };
  }

  const oldContent = status === 'added'
    ? null
    : await readGitFileContent(worktreePath, oldRef, originalPath ?? filePath);
  let newContent: string | null = null;
  let newIsBinary = false;
  if (status !== 'deleted') {
    if (scope === 'staged') {
      newContent = await readGitFileContent(worktreePath, ':', filePath);
    } else {
      try {
        const fullPath = path.join(worktreePath, filePath);
        const [realRoot, realPath] = await Promise.all([
          fs.realpath(worktreePath),
          fs.realpath(fullPath),
        ]);
        if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
          throw new Error(`File path escapes worktree: ${filePath}`);
        }
        newIsBinary = await isBinaryFile(fullPath);
        newContent = newIsBinary ? null : await fs.readFile(fullPath, 'utf-8');
      } catch {
        newContent = null;
      }
    }
  }
  const isBinary =
    newIsBinary ||
    (scope === 'staged' && status !== 'deleted' && newContent === null) ||
    (oldContent?.includes('\0') ?? false) ||
    (newContent?.includes('\0') ?? false) ||
    (oldContent === null && newContent === null && status === 'modified');
  return { oldContent, newContent, isBinary };
}

async function getLocalChangeFiles(
  worktreePath: string,
): Promise<WorktreeLocalChanges> {
  const { stdout: statusOutput } = await execFileAsync(
    'git',
    ['status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: worktreePath, encoding: 'utf-8' },
  );
  const staged = parseNameStatusOutput(
    (await execFileAsync('git', ['diff', '--cached', '--name-status', '-z'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })).stdout,
  );
  const unstaged = parseNameStatusOutput(
    (await execFileAsync('git', ['diff', '--name-status', '-z'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })).stdout,
  );
  const unstagedPaths = new Set(unstaged.map((file) => file.path));
  const statusEntries = statusOutput.split('\0').filter(Boolean);
  for (const entry of statusEntries) {
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (status === '??' && filePath && !unstagedPaths.has(filePath)) {
      unstaged.push({
        path: filePath,
        status: 'added',
        additions: 0,
        deletions: 0,
      });
    }
  }
  return { staged, unstaged };
}

export async function getWorktreeLocalChanges(
  worktreePath: string,
): Promise<WorktreeLocalChanges> {
  if (!(await pathExists(worktreePath))) {
    return { staged: [], unstaged: [], worktreeDeleted: true };
  }
  try {
    return await getLocalChangeFiles(worktreePath);
  } catch (error) {
    if (isEnoent(error)) return { staged: [], unstaged: [], worktreeDeleted: true };
    throw error;
  }
}

function getSourceBranchRefs(
  sourceBranch: string,
  remoteNames: Set<string>,
): {
  localBranch: string;
  refs: string[];
  exactLocalRef: string | null;
} {
  const remoteRefMatch = sourceBranch.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
  const shorthandParts = sourceBranch.split('/');
  const shorthandRemote = remoteNames.has(shorthandParts[0])
    ? shorthandParts[0]
    : sourceBranch.startsWith('origin/')
      ? 'origin'
      : null;
  const remoteName = remoteRefMatch?.[1] ?? shorthandRemote;
  const localBranch = remoteRefMatch
    ? remoteRefMatch[2]
    : remoteName
      ? shorthandParts.slice(1).join('/')
      : sourceBranch.replace(/^refs\/heads\//, '');

  const refs = [`refs/heads/${localBranch}`];
  let exactLocalRef: string | null = null;
  if (shorthandRemote && !remoteRefMatch) {
    exactLocalRef = `refs/heads/${sourceBranch}`;
    refs.unshift(exactLocalRef);
  }
  refs.push(`refs/remotes/${remoteName ?? 'origin'}/${localBranch}`);

  return { localBranch, refs, exactLocalRef };
}

/**
 * Diagnostic helper: resolves the base commit / source ref that the diff
 * functions would use, plus the current HEAD. Used to explain why a task
 * reports an empty diff (e.g. HEAD already merged into the source branch).
 */
export async function getDiffBaseInfo(
  worktreePath: string,
  startCommitHash: string,
  sourceBranch: string | null,
): Promise<{
  baseCommit: string;
  sourceRef: string | null;
  headCommit: string | null;
  headIsMergedIntoSource: boolean;
}> {
  const { baseCommit, sourceRef } = await getDiffBaseCommit(
    worktreePath,
    startCommitHash,
    sourceBranch,
  );

  let headCommit: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    headCommit = stdout.trim();
  } catch {
    // HEAD unavailable (e.g. worktree removed) — leave null.
  }

  return {
    baseCommit,
    sourceRef,
    headCommit,
    // Only meaningful when a real source ref was resolved: without one,
    // baseCommit is just the (possibly stale) startCommitHash, so equality
    // says nothing about the source branch.
    headIsMergedIntoSource: Boolean(
      sourceRef && headCommit && baseCommit && headCommit === baseCommit,
    ),
  };
}

/**
 * Resolves the merge-base a source branch would produce for a worktree.
 * Returns null when no common ancestor is reachable, meaning the diff would
 * silently fall back to the (stale) start commit.
 */
export async function resolveSourceBranchMergeBase(
  worktreePath: string,
  sourceBranch: string,
): Promise<string | null> {
  const { sourceRef, baseCommit } = await getDiffBaseCommit(
    worktreePath,
    '',
    sourceBranch,
  );
  return sourceRef ? baseCommit : null;
}

/**
 * Gets the commit hash to use as the diff base.
 * If sourceBranch is provided, uses the merge-base between HEAD and the source branch.
 * This ensures we only see changes unique to this branch, even after merging
 * the source branch to resolve conflicts or stay up-to-date.
 * Falls back to startCommitHash if sourceBranch is not available or merge-base fails.
 *
 * @param worktreePath - The path to the worktree
 * @param startCommitHash - The fallback commit hash
 * @param sourceBranch - The source branch to compute merge-base against
 * @returns The commit hash to use for diffing
 */
async function getDiffBaseCommit(
  worktreePath: string,
  startCommitHash: string,
  sourceBranch: string | null,
): Promise<{ baseCommit: string; sourceRef: string | null }> {
  if (!sourceBranch) {
    dbg.worktree('No sourceBranch, using startCommitHash: %s', startCommitHash);
    return { baseCommit: startCommitHash, sourceRef: null };
  }

  let remoteNames = new Set<string>();
  try {
    const { stdout } = await execFileAsync('git', ['remote'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    remoteNames = new Set(stdout.trim().split('\n').filter(Boolean));
  } catch {
    // Ref resolution still supports local branches and origin without remotes.
  }
  const { localBranch, refs, exactLocalRef } = getSourceBranchRefs(
    sourceBranch,
    remoteNames,
  );

  try {
    await execFileAsync('git', ['check-ref-format', '--branch', localBranch], {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
  } catch {
    dbg.worktree(
      'Invalid sourceBranch, falling back to startCommitHash: %s',
      startCommitHash,
    );
    return { baseCommit: startCommitHash, sourceRef: null };
  }

  if (exactLocalRef) {
    try {
      await execFileAsync('git', ['show-ref', '--verify', exactLocalRef], {
        cwd: worktreePath,
        encoding: 'utf-8',
      });
      refs.splice(0, refs.length, exactLocalRef);
    } catch {
      // No exact local branch; interpret sourceBranch as remote shorthand.
    }
  }

  let nearest:
    | { baseCommit: string; sourceRef: string; distance: number }
    | undefined;

  for (const ref of refs) {
    try {
      const mergeBase = await execFileAsync('git', ['merge-base', 'HEAD', ref], {
        cwd: worktreePath,
        encoding: 'utf-8',
      });
      const baseCommit = mergeBase.stdout.trim();
      const commitCount = await execFileAsync(
        'git',
        ['rev-list', '--count', `${baseCommit}..HEAD`],
        {
          cwd: worktreePath,
          encoding: 'utf-8',
        },
      );
      const distance = Number.parseInt(commitCount.stdout.trim(), 10);
      if (!nearest || distance < nearest.distance) {
        nearest = { baseCommit, sourceRef: ref, distance };
      }
    } catch {
      continue;
    }
  }

  if (nearest) {
    dbg.worktree(
      'Using nearest merge-base with %s: %s (%d commits from HEAD)',
      nearest.sourceRef,
      nearest.baseCommit,
      nearest.distance,
    );
    return {
      baseCommit: nearest.baseCommit,
      sourceRef: nearest.sourceRef,
    };
  }

  // Fall back to startCommitHash if merge-base fails
  dbg.worktree(
    'merge-base failed, falling back to startCommitHash: %s',
    startCommitHash,
  );
  return { baseCommit: startCommitHash, sourceRef: null };
}

/**
 * Gets the set of files in the working tree that differ from the source branch.
 * Files NOT in this set have content identical to the source branch — they are
 * merge artifacts (staged/unstaged changes from merging the source branch) and
 * should be excluded from the task diff.
 *
 * Returns null if source branch is unavailable (no filtering should be applied).
 */
async function getTaskChangedFiles(
  worktreePath: string,
  sourceRef: string | null,
): Promise<Set<string> | null> {
  if (!sourceRef) return null;

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', sourceRef],
      {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const files = new Set(
      stdout
        .trim()
        .split('\n')
        .filter((f) => f),
    );
    dbg.worktree(
      'Task-changed files (vs %s): %d files',
      sourceRef,
      files.size,
    );
    return files;
  } catch {
    dbg.worktree('Could not use resolved source branch for filtering, skipping');
    return null;
  }
}

/**
 * Gets the list of changed files between a worktree's current state and its divergence point
 * from the source branch. Does not load file contents - use getWorktreeFileContent for that.
 *
 * This shows only changes unique to this branch by using git merge-base to find where
 * the branch diverged from the source. This means changes merged in from the source
 * branch (e.g., to resolve conflicts) won't appear in the diff.
 *
 * This includes:
 * - Committed changes since diverging from source branch
 * - Staged but uncommitted changes
 * - Unstaged changes in tracked files
 * - Untracked files (new files not yet added to git)
 *
 * @param worktreePath - The path to the worktree
 * @param startCommitHash - Fallback commit hash (used if sourceBranch unavailable)
 * @param sourceBranch - The source branch to compute diff against (optional)
 * @returns The list of changed files with their status
 */
export async function getWorktreeDiff(
  worktreePath: string,
  startCommitHash: string,
  sourceBranch?: string | null,
): Promise<WorktreeDiffResult> {
  dbg.worktree('getWorktreeDiff called %o', {
    worktreePath,
    startCommitHash,
    sourceBranch,
  });

  // Check if the worktree still exists
  if (!(await pathExists(worktreePath))) {
    dbg.worktree('Worktree path does not exist, returning deleted');
    return { files: [], worktreeDeleted: true };
  }

  try {
    const { baseCommit, sourceRef } = await getDiffBaseCommit(
      worktreePath,
      startCommitHash,
      sourceBranch ?? null,
    );
    // Files whose content matches the source branch are merge artifacts
    // (from merging source into this branch) and should be excluded.
    const taskChangedFiles = await getTaskChangedFiles(worktreePath, sourceRef);

    // We need to combine two sources to get all changes:
    // 1. git diff --name-status <commit> - changes from baseCommit to working tree
    // 2. git status --porcelain - shows untracked files that git diff doesn't see
    // Then filter to only include files with actual task changes (not merge artifacts)

    const [diffResult, numstatResult, statusResult] = await Promise.all([
      execAsync(`git diff --name-status ${baseCommit}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
      }),
      execAsync(`git diff --numstat ${baseCommit}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }),
      // Use --untracked-files=all to list individual files in new directories
      // (default mode shows new directories as "folder/" which can't be diffed)
      execAsync('git status --porcelain --untracked-files=all', {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }),
    ]);
    const diffOutput = diffResult.stdout;
    dbg.worktree('git diff output length: %d', diffOutput.length);

    const numstatOutput = numstatResult.stdout;

    const numstatMap = new Map<
      string,
      { additions: number; deletions: number }
    >();
    for (const line of numstatOutput.split('\n')) {
      if (!line.trim()) continue;
      const [adds, dels, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t'); // handle paths with tabs
      numstatMap.set(filePath, {
        additions: adds === '-' ? 0 : parseInt(adds, 10),
        deletions: dels === '-' ? 0 : parseInt(dels, 10),
      });
    }

    // Also get untracked files which git diff doesn't show.
    const statusOutput = statusResult.stdout;
    dbg.worktree('git status output length: %d', statusOutput.length);

    const filesMap = new Map<string, WorktreeDiffFile>();

    // Parse git diff output
    const trimmedDiff = diffOutput.trim();
    if (trimmedDiff) {
      for (const line of trimmedDiff.split('\n')) {
        if (!line) continue;

        // Format: "M\tpath/to/file" or "A\tpath" or "D\tpath"
        // Also handles renames: "R100\told\tnew"
        const parts = line.split('\t');
        const statusCode = parts[0];
        // For renames (R) and copies (C), the new path is the last element
        const filePath =
          statusCode.startsWith('R') || statusCode.startsWith('C')
            ? parts[parts.length - 1]
            : parts.slice(1).join('\t');

        let status: 'added' | 'modified' | 'deleted';
        if (statusCode.startsWith('A')) {
          status = 'added';
        } else if (statusCode.startsWith('D')) {
          status = 'deleted';
        } else if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
          // Renames and copies show as added (the new file)
          status = 'added';
        } else {
          status = 'modified';
        }

        // Skip files whose content matches the source branch (merge artifacts)
        if (taskChangedFiles && !taskChangedFiles.has(filePath)) {
          dbg.worktree('Skipping merge artifact: %s', filePath);
          continue;
        }

        const stats = numstatMap.get(filePath) ?? {
          additions: 0,
          deletions: 0,
        };
        filesMap.set(filePath, {
          path: filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
        });
        dbg.worktree('From git diff: %o', { filePath, status });
      }
    }

    // Parse git status output for untracked files
    const trimmedStatus = statusOutput.trim();
    if (trimmedStatus) {
      for (const line of trimmedStatus.split('\n')) {
        if (!line) continue;

        // Format: "XY filename" where X is staged status, Y is working tree status
        // "??" means untracked, "A " means staged new file, " M" means modified, etc.
        const statusCodes = line.substring(0, 2);
        const filePath = line.substring(3);

        // Only add untracked files (??) that we haven't already captured
        // Other statuses should already be in the diff output
        // Skip directory entries (paths ending with '/') - git status shows untracked
        // directories this way, but we can only diff individual files
        if (
          statusCodes === '??' &&
          !filePath.endsWith('/') &&
          !filesMap.has(filePath)
        ) {
          filesMap.set(filePath, {
            path: filePath,
            status: 'added',
            additions: 0,
            deletions: 0,
          });
          dbg.worktree('From git status (untracked): %o', {
            filePath,
            status: filesMap.get(filePath)?.status,
          });
        }
      }
    }

    const files = Array.from(filesMap.values());
    dbg.worktree('Total files found: %d', files.length);

    return { files };
  } catch (error) {
    dbg.worktree('Error getting diff: %O', error);
    // If we get ENOENT, the worktree was likely deleted between our check and the git command
    if (isEnoent(error)) {
      return { files: [], worktreeDeleted: true };
    }
    throw error;
  }
}

/**
 * Gets the content of a specific file for diff viewing.
 * Loads the old content from the diff base and new content from the working tree.
 *
 * Uses the same merge-base logic as getWorktreeDiff to ensure consistency:
 * if sourceBranch is provided, the "old" content comes from the merge-base,
 * otherwise falls back to startCommitHash.
 *
 * @param worktreePath - The path to the worktree
 * @param startCommitHash - Fallback commit hash (used if sourceBranch unavailable)
 * @param filePath - The relative path of the file within the worktree
 * @param status - The file status (added/modified/deleted)
 * @param sourceBranch - The source branch to compute diff against (optional)
 * @returns The old and new content of the file
 */
export async function getWorktreeFileContent(
  worktreePath: string,
  startCommitHash: string,
  filePath: string,
  status: 'added' | 'modified' | 'deleted',
  sourceBranch?: string | null,
  originalPath?: string,
): Promise<WorktreeFileContent> {
  dbg.worktree('getWorktreeFileContent called %o', {
    worktreePath,
    startCommitHash,
    filePath,
    status,
    sourceBranch,
  });

  // Get the appropriate base commit for diffing
  const { baseCommit } = await getDiffBaseCommit(
    worktreePath,
    startCommitHash,
    sourceBranch ?? null,
  );

  // Spreadsheets are binary: ship raw bytes and let the renderer parse them.
  if (isSpreadsheetPath(filePath)) {
    // Renames arrive here as 'modified' with the *new* path, so the old side
    // must be read from originalPath or git show finds nothing.
    const oldSpreadsheetBase64 =
      status === 'added'
        ? null
        : await readGitFileBase64(
            worktreePath,
            baseCommit,
            originalPath ?? filePath,
          );
    const newResult =
      status === 'deleted'
        ? { base64: null, tooLarge: false }
        : await readSpreadsheetBase64FromDisk(worktreePath, filePath);
    dbg.worktree('Spreadsheet file %s %o', filePath, {
      hasOld: oldSpreadsheetBase64 !== null,
      hasNew: newResult.base64 !== null,
      tooLarge: newResult.tooLarge,
    });
    return {
      oldContent: null,
      newContent: null,
      isBinary: true,
      oldSpreadsheetBase64,
      newSpreadsheetBase64: newResult.base64,
      spreadsheetTooLarge: newResult.tooLarge,
    };
  }

  let oldContent: string | null = null;
  let newContent: string | null = null;
  let isBinary = false;
  let oldImageDataUrl: string | null = null;
  let newImageDataUrl: string | null = null;

  const mimeType = getImageMimeType(filePath);
  const isSvg = isSvgPath(filePath);

  // Get old content from the base commit (unless file was added)
  if (status !== 'added') {
    try {
      if (mimeType && !isSvg) {
        // Read old image as base64 from git
        const { stdout } = await execAsync(
          `git show ${baseCommit}:"${escapeForShell(filePath)}" | base64`,
          {
            cwd: worktreePath,
            encoding: 'utf-8',
            maxBuffer: 15 * 1024 * 1024,
          },
        );
        const base64 = stdout.replace(/\s/g, '');
        oldImageDataUrl = `data:${mimeType};base64,${base64}`;
        dbg.worktree(
          'Got old image data URL, base64 length: %d',
          base64.length,
        );
      } else {
        const { stdout } = await execAsync(
          `git show ${baseCommit}:"${escapeForShell(filePath)}"`,
          {
            cwd: worktreePath,
            encoding: 'utf-8',
            maxBuffer: 5 * 1024 * 1024,
          },
        );
        oldContent = stdout;
        dbg.worktree('Got old content, length: %d', stdout.length);
      }
    } catch (error) {
      // File might be binary or inaccessible
      dbg.worktree('Failed to get old content: %O', error);
      oldContent = null;
    }
  } else {
    dbg.worktree('File is added, no old content to fetch');
  }

  // Get new content from the working tree (unless file was deleted)
  if (status !== 'deleted') {
    const fullPath = path.join(worktreePath, filePath);
    try {
      if (mimeType && !isSvg) {
        // Read new image as base64 from disk
        const buffer = await fs.readFile(fullPath);
        const base64 = buffer.toString('base64');
        newImageDataUrl = `data:${mimeType};base64,${base64}`;
        isBinary = true;
        dbg.worktree(
          'Got new image data URL, base64 length: %d',
          base64.length,
        );
      } else if (await isBinaryFile(fullPath)) {
        dbg.worktree('File is binary');
        isBinary = true;
        newContent = null;
      } else {
        newContent = await fs.readFile(fullPath, 'utf-8');
        dbg.worktree('Got new content, length: %d', newContent.length);
      }
    } catch (error) {
      dbg.worktree('Failed to get new content: %O', error);
      newContent = null;
    }
  } else {
    dbg.worktree('File is deleted, no new content to fetch');
  }

  // Mark as binary for images
  if (mimeType && !isSvg) {
    isBinary = true;
  }

  // Also check if old content indicates binary (null bytes would have caused git show to fail)
  if (
    oldContent === null &&
    newContent === null &&
    status === 'modified' &&
    !mimeType
  ) {
    dbg.worktree('Both contents null for modified file, marking as binary');
    isBinary = true;
  }

  dbg.worktree('Returning: %o', {
    hasOldContent: oldContent !== null,
    hasNewContent: newContent !== null,
    isBinary,
    hasOldImage: oldImageDataUrl !== null,
    hasNewImage: newImageDataUrl !== null,
  });

  return { oldContent, newContent, isBinary, oldImageDataUrl, newImageDataUrl };
}

/**
 * Copies files from the project root to the worktree based on the
 * `worktree.create.copy` config in `.jean-claude/settings.local.json`.
 *
 * Each entry is either a string (same relative path) or a [source, dest] tuple.
 * Missing source files are silently skipped.
 */
async function copyWorktreeFiles(
  projectPath: string,
  worktreePath: string,
  entries: WorktreeFileCopyEntry[],
): Promise<void> {
  for (const entry of entries) {
    const [src, dest] = Array.isArray(entry) ? entry : [entry, entry];
    const srcPath = path.join(projectPath, src);
    const destPath = path.join(worktreePath, dest);

    try {
      // Ensure destination directory exists
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
      dbg.worktree('Copied file: %s → %s', src, dest);
    } catch (error) {
      if (isEnoent(error)) {
        dbg.worktree('Skipping missing file: %s', src);
      } else {
        dbg.worktree('Failed to copy file %s: %O', src, error);
      }
    }
  }
}

/**
 * Creates a git worktree for a task.
 *
 * @param projectPath - The path to the main git repository
 * @param projectId - The project ID
 * @param projectName - The project name (for directory naming)
 * @param prompt - The task prompt (fallback for worktree naming if taskName not provided)
 * @param taskName - Optional task name to use for worktree naming (preferred over prompt)
 * @param sourceBranch - Optional branch to base the worktree on (defaults to current HEAD)
 * @param startPoint - Optional git ref to create the worktree from while preserving sourceBranch metadata
 * @param useExistingBranch - Check out sourceBranch directly instead of creating a task branch
 * @returns The path to the created worktree and the starting commit hash
 */
export async function createWorktree(
  projectPath: string,
  projectId: string,
  projectName: string,
  prompt: string,
  taskName?: string,
  sourceBranch?: string,
  startPoint?: string,
  useExistingBranch = false,
): Promise<CreateWorktreeResult> {
  dbg.worktree('createWorktree called %o', {
    projectPath,
    projectId,
    taskName,
    sourceBranch,
    startPoint,
  });

  // Verify this is a git repository
  if (!(await isGitRepository(projectPath))) {
    throw new Error(`Project path is not a git repository: ${projectPath}`);
  }

  // Get or create the project's worktrees directory
  const projectWorktreesPath = await getOrCreateProjectWorktreesPath(
    projectId,
    projectName,
  );
  dbg.worktree('Using worktrees directory: %s', projectWorktreesPath);

  // Generate worktree name from task name (preferred) or prompt (fallback)
  const worktreeName = taskName
    ? generateWorktreeNameFromTaskName(taskName)
    : generateWorktreeName(prompt);
  const worktreePath = path.join(projectWorktreesPath, worktreeName);

  // Determine the actual source branch (either the provided one or the current branch)
  const actualSourceBranch =
    sourceBranch ?? (await getCurrentBranchName(projectPath));

  const branchName = useExistingBranch
    ? actualSourceBranch
    : `jean-claude/${worktreeName}`;
  dbg.worktree('Creating worktree: %s, branch: %s', worktreePath, branchName);

  // Existing branch mode checks out selected branch directly. New branch mode
  // keeps isolated-task behavior.
  try {
    const startPointArg = startPoint ?? sourceBranch;
    const args = useExistingBranch
      ? ['worktree', 'add', worktreePath, startPointArg ?? branchName]
      : ['worktree', 'add', worktreePath, '-b', branchName];
    if (!useExistingBranch && startPointArg) args.push(startPointArg);
    dbg.worktree('Running: git %s', args.join(' '));
    await execFileAsync('git', args, {
      cwd: projectPath,
      encoding: 'utf-8',
    });
    dbg.worktree('Worktree created successfully');
  } catch (error) {
    dbg.worktree('Failed to create worktree: %O', error);
    throw new Error(formatCreateWorktreeError(error));
  }

  // Build backend-specific permission settings for the worktree
  try {
    await buildWorktreeSettings(projectPath, worktreePath);
  } catch (error) {
    dbg.worktree('Failed to build permission settings for worktree: %O', error);
  }

  // Install MCP servers for this worktree
  try {
    await installMcpForWorktree({
      worktreePath,
      projectId,
      projectName,
      branchName,
      mainRepoPath: projectPath,
    });
  } catch (error) {
    dbg.worktree('Failed to install MCP servers for worktree: %O', error);
    // Don't throw — MCP setup failure shouldn't block worktree creation
  }

  // Copy configured files from project to worktree
  try {
    const settings = await readSettings(projectPath);
    const copyEntries = settings.worktree?.create?.copy;
    if (copyEntries && copyEntries.length > 0) {
      await copyWorktreeFiles(projectPath, worktreePath, copyEntries);
    }
  } catch (error) {
    dbg.worktree('Failed to copy worktree files: %O', error);
    // Don't throw — file copy failure shouldn't block worktree creation
  }

  // Get the commit hash of the worktree HEAD (which is the source branch's HEAD or current HEAD)
  const startCommitHash = await getCurrentCommitHash(worktreePath);
  dbg.worktree('Worktree ready, startCommitHash: %s', startCommitHash);

  return {
    worktreePath,
    startCommitHash,
    branchName,
    sourceBranch: actualSourceBranch,
  };
}

/**
 * Gets the current branch name for a git repository.
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    encoding: 'utf-8',
  });
  return stdout.trim();
}

/**
 * Gets the list of local branches for a git repository.
 */
export async function getProjectBranches(
  projectPath: string,
): Promise<BranchInfo[]> {
  try {
    const [{ stdout }, { stdout: worktreeList }] = await Promise.all([
      execAsync(
      'git branch --sort=-committerdate --format="%(refname:short)\t%(committerdate:iso-strict)"',
      {
        cwd: projectPath,
        encoding: 'utf-8',
      },
      ),
      execAsync('git worktree list --porcelain', {
        cwd: projectPath,
        encoding: 'utf-8',
      }),
    ]);
    const checkedOutBranches = new Set(
      [...worktreeList.matchAll(/^branch refs\/heads\/(.+)$/gm)].map(
        (match) => match[1],
      ),
    );
    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const separatorIndex = line.indexOf('\t');
        if (separatorIndex === -1) {
          return {
            name: line,
            lastCommitDate: '',
            isCheckedOut: checkedOutBranches.has(line),
          };
        }
        return {
          name: line.slice(0, separatorIndex),
          lastCommitDate: line.slice(separatorIndex + 1),
          isCheckedOut: checkedOutBranches.has(line.slice(0, separatorIndex)),
        };
      });
  } catch (error) {
    throw new Error(`Failed to get branches: ${error}`);
  }
}

export interface WorktreeStatus {
  hasUncommittedChanges: boolean;
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUnpushedCommits: boolean;
  currentBranch: string | null;
  worktreeDeleted?: boolean;
}

export async function hasUncommittedWorktreeChanges(
  worktreePath: string,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '--no-optional-locks',
        'status',
        '--porcelain',
        '--untracked-files=normal',
      ],
      { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 },
    );
    return stdout.trim().length > 0;
  } catch (error) {
    if (isEnoent(error) && !(await pathExists(worktreePath))) return false;
    throw error;
  }
}

export async function hasUnpushedWorktreeCommits(
  worktreePath: string,
): Promise<boolean> {
  let branchStatus: string;
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        '--no-optional-locks',
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=no',
      ],
      { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 },
    );
    branchStatus = stdout;
  } catch (error) {
    if (isEnoent(error) && !(await pathExists(worktreePath))) return false;
    throw error;
  }

  const lines = branchStatus.split('\n');
  const hasUpstream = lines.some((line) => line.startsWith('# branch.upstream '));
  if (hasUpstream) {
    const aheadLine = lines.find((line) => line.startsWith('# branch.ab '));
    const aheadCount = aheadLine?.match(/^# branch\.ab \+(\d+) /)?.[1];
    return Number(aheadCount ?? 0) > 0;
  }

  // A branch can be published without tracking configuration.
  const { stdout: containingRemoteRefs } = await execFileAsync(
    'git',
    [
      '--no-optional-locks',
      'for-each-ref',
      '--contains=HEAD',
      '--format=%(refname)',
      'refs/remotes',
    ],
    { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 },
  );
  if (containingRemoteRefs.trim().length > 0) return false;

  // Without an upstream or containing remote ref, local commits need a push.
  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', 'log', '--oneline', '-1'],
    { cwd: worktreePath, encoding: 'utf-8', timeout: 5_000 },
  );
  return stdout.trim().length > 0;
}

/**
 * Checks if a worktree has uncommitted or unpushed changes.
 */
export async function getWorktreeStatus(
  worktreePath: string,
): Promise<WorktreeStatus> {
  try {
    // Check for staged changes
    const { stdout: stagedOutput } = await execAsync(
      'git diff --cached --name-only',
      {
        cwd: worktreePath,
        encoding: 'utf-8',
      },
    );
    const hasStagedChanges = stagedOutput.trim().length > 0;

    // Check for unstaged changes (including untracked files)
    const { stdout: unstagedOutput } = await execAsync(
      'git status --porcelain',
      {
        cwd: worktreePath,
        encoding: 'utf-8',
      },
    );
    const hasUnstagedChanges = unstagedOutput.trim().length > 0;
    const currentBranch = await getCurrentBranch(worktreePath);

    const hasUnpushedCommits =
      await hasUnpushedWorktreeCommits(worktreePath);

    return {
      hasUncommittedChanges: hasStagedChanges || hasUnstagedChanges,
      hasStagedChanges,
      hasUnstagedChanges,
      hasUnpushedCommits,
      currentBranch,
    };
  } catch (error) {
    // If we get ENOENT, the worktree was likely deleted
    if (isEnoent(error)) {
      return {
        hasUncommittedChanges: false,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        hasUnpushedCommits: false,
        currentBranch: null,
        worktreeDeleted: true,
      };
    }
    throw new Error(`Failed to get worktree status: ${error}`);
  }
}

export interface CommitWorktreeParams {
  worktreePath: string;
  projectPath?: string;
  message: string;
  stageAll: boolean;
  noVerify?: boolean;
}

/**
 * Commits changes in a worktree.
 */
export async function commitWorktreeChanges(
  params: CommitWorktreeParams,
): Promise<void> {
  const {
    worktreePath,
    projectPath,
    message,
    stageAll,
    noVerify = false,
  } = params;
  dbg.worktree('commitWorktreeChanges: %o', {
    worktreePath,
    stageAll,
    noVerify,
    messageLength: message.length,
  });

  try {
    if (stageAll) {
      const { ignoredPaths, ignoredStagedPaths } = await getIgnoredCommitPaths({
        worktreePath,
        projectPath,
      });
      // Stage the whole worktree and subtract the commit-ignored paths with
      // exclude pathspecs. Enumerating the included paths explicitly instead
      // makes `git add` hard-fail when any of them is matched by a .gitignore
      // rule but still shows up in `git status` (e.g. a tracked file that was
      // `git rm --cached`-ed while remaining on disk).
      dbg.worktree('Staging worktree, excluding %d paths', ignoredPaths.size);
      await gitAddAllExcept({ worktreePath, excludedPaths: ignoredPaths });
      if (ignoredStagedPaths.size > 0) {
        await runGitPathCommand({
          worktreePath,
          args: ['restore', '--staged'],
          paths: [...ignoredStagedPaths],
        });
      }
      if (!(await hasStagedChanges(worktreePath))) {
        dbg.worktree('No non-ignored staged changes to commit');
        return;
      }
    }

    // Commit with the provided message
    dbg.worktree('Creating commit');
    await gitCommit({ cwd: worktreePath, message, noVerify });
    dbg.worktree('Commit successful');
  } catch (error) {
    dbg.worktree('Commit failed: %O', error);
    throw new Error(`Failed to commit changes: ${error}`);
  }
}

export interface MergeWorktreeParams {
  worktreePath: string;
  projectPath: string;
  targetBranch: string;
  squash?: boolean;
  commitMessage?: string;
  noVerify?: boolean;
}

export interface MergeWorktreeResult {
  success: boolean;
  error?: string;
}

export interface CheckMergeConflictsParams {
  worktreePath: string;
  projectPath: string;
  targetBranch: string;
}

export interface CheckMergeConflictsResult {
  hasConflicts: boolean;
  error?: string;
}

function isMergeConflictError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes('conflict') ||
    normalized.includes('automatic merge failed')
  );
}

function getExecErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const execError = error as Error & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };

  const stdout =
    typeof execError.stdout === 'string'
      ? execError.stdout
      : (execError.stdout?.toString('utf-8') ?? '');
  const stderr =
    typeof execError.stderr === 'string'
      ? execError.stderr
      : (execError.stderr?.toString('utf-8') ?? '');

  return [execError.message, stdout, stderr].filter(Boolean).join('\n');
}

export type WorktreeBranchCleanupBehavior = 'delete' | 'keep';

/**
 * Looks up a worktree in `git worktree list` for the given project.
 * Returns `null` when git no longer tracks that path (e.g. it was pruned and
 * only a stale directory is left on disk).
 */
async function findRegisteredWorktree(params: {
  projectPath: string;
  worktreePath: string;
}): Promise<{ path?: string; branch?: string } | null> {
  const { projectPath, worktreePath } = params;
  const { stdout } = await execAsync('git worktree list --porcelain', {
    cwd: projectPath,
    encoding: 'utf-8',
  });
  const canonicalWorktreePath = path.join(
    await fs.realpath(path.dirname(worktreePath)),
    path.basename(worktreePath),
  );
  return (
    stdout
      .trim()
      .split(/\n\s*\n/)
      .map((block) => {
        const lines = block.split('\n');
        return {
          path: lines.find((line) => line.startsWith('worktree '))?.slice(9),
          branch: lines
            .find((line) => line.startsWith('branch refs/heads/'))
            ?.slice('branch refs/heads/'.length),
        };
      })
      .find((entry) => entry.path === canonicalWorktreePath) ?? null
  );
}

export interface CleanupWorktreeParams {
  worktreePath: string;
  projectPath: string;
  branchName?: string | null;
  skipIfChanges?: boolean;
  branchCleanup?: WorktreeBranchCleanupBehavior;
  force?: boolean;
  onVerified?: () => void | Promise<void>;
}

/**
 * True when `worktreePath` is a leftover directory that git no longer tracks:
 * running git inside it fails AND it is absent from `git worktree list`.
 * Fails closed (returns false) whenever either probe is inconclusive, so a
 * transient git failure can never be mistaken for an orphan.
 */
async function isOrphanedWorktree(params: {
  worktreePath: string;
  projectPath: string;
}): Promise<boolean> {
  const { worktreePath, projectPath } = params;
  try {
    await execAsync('git rev-parse --git-dir', {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    return false;
  } catch {
    // Falls through: git is unusable inside the directory.
  }
  try {
    return (await findRegisteredWorktree({ projectPath, worktreePath })) === null;
  } catch (error) {
    dbg.worktree(
      'Failed to list worktrees while diagnosing %s: %O',
      worktreePath,
      error,
    );
    return false;
  }
}

/**
 * Removes a worktree and deletes its branch.
 */
export async function cleanupWorktree(
  params: CleanupWorktreeParams,
): Promise<void> {
  const {
    worktreePath,
    projectPath,
    branchName,
    skipIfChanges = false,
    branchCleanup = 'delete',
    force = false,
    onVerified,
  } = params;

  if (!(await pathExists(worktreePath))) {
    return;
  }

  // An orphaned worktree — directory still on disk, but git pruned its admin
  // dir — fails every git command run inside it (`fatal: not a git
  // repository`). Detect that up front, otherwise both the uncommitted-changes
  // check and the branch verification below turn a recoverable state into a
  // permanent failure that blocks task completion forever.
  if (await isOrphanedWorktree({ worktreePath, projectPath })) {
    if (skipIfChanges) {
      // Git cannot tell us whether the directory holds uncommitted work, and
      // the caller asked us to preserve it if so. Leave it for the explicit
      // "Unused worktrees" cleanup rather than guessing.
      dbg.worktree(
        'Worktree %s is orphaned; skipping cleanup because unverifiable changes may exist',
        worktreePath,
      );
      return;
    }

    const persisted = branchName?.trim() || null;
    if (branchCleanup === 'delete' && !persisted) {
      throw new Error(
        'Cannot delete worktree branch without persisted branch metadata',
      );
    }

    dbg.worktree(
      'Worktree %s is orphaned (unregistered, missing git admin dir); removing directory directly',
      worktreePath,
    );
    if (branchCleanup === 'delete') await onVerified?.();
    // git will not remove a directory it no longer tracks, so this is a raw
    // delete — gate it on the path actually being a Jean-Claude worktree.
    await assertSafeToRawDelete(worktreePath);
    await fs.rm(worktreePath, { force: true, recursive: true });
    await cleanupMissingWorktree({
      worktreePath,
      projectPath,
      branchName: persisted ?? '',
      allowUnregistered: true,
      // Deleting the branch is best-effort here; the blocking problem (the
      // stale directory) is already resolved and must not be re-reported.
      throwOnError: false,
      skipBranchDelete: branchCleanup !== 'delete',
    });
    return;
  }

  if (skipIfChanges) {
    let statusOutput: string;
    try {
      const { stdout } = await execAsync(
        'git status --porcelain --untracked-files=all',
        {
          cwd: worktreePath,
          encoding: 'utf-8',
        },
      );
      statusOutput = stdout;
    } catch (error) {
      throw new Error(
        `Failed to check worktree for uncommitted changes (worktree: ${worktreePath}): ${getExecErrorMessage(error)}`,
        { cause: error },
      );
    }
    if (statusOutput.trim().length > 0) {
      return;
    }
  }

  let worktreeBranch: string | null = null;
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
    });
    worktreeBranch = stdout.trim();
  } catch (error) {
    if (branchCleanup === 'delete') {
      // Still a registered worktree, so this is genuine corruption rather than
      // an orphan (handled above) — refuse to guess at the branch.
      // Error `cause` is dropped by Electron IPC serialization, so the git
      // output has to be inlined in the message to reach the renderer.
      throw new Error(
        `Failed to verify worktree branch before delete (worktree: ${worktreePath}): ${getExecErrorMessage(error)}`,
        { cause: error },
      );
    }
  }
  const persistedBranch = branchName?.trim() || null;
  if (branchCleanup === 'delete' && !persistedBranch) {
    throw new Error('Cannot delete worktree branch without persisted branch metadata');
  }
  if (
    branchCleanup === 'delete' &&
    persistedBranch &&
    worktreeBranch !== persistedBranch
  ) {
    throw new Error(
      `Worktree branch mismatch: expected ${persistedBranch}, found ${worktreeBranch ?? 'unknown'}`,
    );
  }
  if (branchCleanup === 'delete') await onVerified?.();

  const forceFlag = force ? ' --force' : '';
  await execAsync(
    `git worktree remove ${JSON.stringify(worktreePath)}${forceFlag}`,
    {
      cwd: projectPath,
      encoding: 'utf-8',
    },
  );

  if (branchCleanup === 'delete' && worktreeBranch) {
    await execAsync(`git branch -D ${JSON.stringify(worktreeBranch)}`, {
      cwd: projectPath,
      encoding: 'utf-8',
    });
  }
}

/**
 * Cleans up a worktree whose directory has already been deleted from disk.
 * Runs `git worktree prune` to remove stale worktree references,
 * then deletes the branch if requested.
 */
export async function cleanupMissingWorktree(params: {
  worktreePath?: string;
  projectPath: string;
  branchName: string;
  throwOnError?: boolean;
  allowUnregistered?: boolean;
  /** Prune the stale worktree entry but leave the branch in place. */
  skipBranchDelete?: boolean;
  onVerified?: () => void | Promise<void>;
}): Promise<void> {
  const {
    worktreePath,
    projectPath,
    branchName,
    throwOnError = false,
    allowUnregistered = false,
    skipBranchDelete = false,
    onVerified,
  } = params;

  try {
    if (!worktreePath) {
      throw new Error('Cannot verify missing worktree branch without its path');
    }
    const registered = await findRegisteredWorktree({
      projectPath,
      worktreePath,
    });
    if (
      (registered && registered.branch !== branchName) ||
      (!registered && !allowUnregistered)
    ) {
      throw new Error(
        `Missing worktree branch mismatch: expected ${branchName}, found ${registered?.branch ?? 'unregistered'}`,
      );
    }
    await onVerified?.();
  } catch (error) {
    dbg.worktree('Failed to verify missing worktree branch: %O', error);
    if (throwOnError) throw error;
    return;
  }

  // Prune stale worktree entries (removes references to deleted directories)
  try {
    await execAsync('git worktree prune', {
      cwd: projectPath,
      encoding: 'utf-8',
    });
    dbg.worktree('Pruned stale worktree references in %s', projectPath);
  } catch (error) {
    dbg.worktree('Failed to prune worktrees in %s: %O', projectPath, error);
    if (throwOnError) throw error;
  }

  if (skipBranchDelete) return;

  // Delete the orphaned branch
  try {
    const { stdout } = await execAsync(
      `git branch --list ${JSON.stringify(branchName)}`,
      {
        cwd: projectPath,
        encoding: 'utf-8',
      },
    );
    if (!stdout.trim()) return;

    await execAsync(`git branch -D ${JSON.stringify(branchName)}`, {
      cwd: projectPath,
      encoding: 'utf-8',
    });
    dbg.worktree('Deleted branch %s in %s', branchName, projectPath);
  } catch (error) {
    dbg.worktree(
      'Failed to delete branch %s in %s: %O',
      branchName,
      projectPath,
      error,
    );
    if (throwOnError) throw error;
  }
}

/**
 * Merges a worktree branch into target branch and deletes the worktree.
 * Supports both regular merge and squash merge with custom commit message.
 */
/**
 * Per-repo mutex to serialize merge operations. Prevents concurrent merges
 * from racing on the same target branch ref (both within Jean-Claude and
 * against external git operations, via the CAS check in update-ref).
 *
 * The chain promise always resolves (never rejects) so a failing `fn` can
 * never poison the queue. Callers receive a separate promise that carries
 * the actual result or rejection.
 */
const repoMergeLocks = new Map<string, Promise<void>>();

function withRepoLock<T>(
  projectPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = repoMergeLocks.get(projectPath) ?? Promise.resolve();

  // Caller-facing promise that preserves fn's result/rejection.
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const callerPromise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // Chain promise always resolves — fn errors are forwarded to callerPromise
  // but never propagate through the queue.
  const next = prev.then(async () => {
    try {
      resolve(await fn());
    } catch (err) {
      reject(err);
    }
  });

  repoMergeLocks.set(projectPath, next);

  // Clean up entry when queue drains to avoid unbounded growth
  void next.then(() => {
    if (repoMergeLocks.get(projectPath) === next) {
      repoMergeLocks.delete(projectPath);
    }
  });

  return callerPromise;
}

export function mergeWorktree(
  params: MergeWorktreeParams,
): Promise<MergeWorktreeResult> {
  return withRepoLock(params.projectPath, () => mergeWorktreeInner(params));
}

/**
 * Find the worktree path where a given branch is checked out.
 * Returns the path (may be projectPath itself or a secondary worktree),
 * or null if the branch is not checked out anywhere.
 */
async function findWorktreeForBranch(
  projectPath: string,
  branch: string,
): Promise<string | null> {
  const { stdout } = await execFileAsync(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: projectPath, encoding: 'utf-8' },
  );

  // Parse porcelain output: blocks separated by blank lines.
  // Each block has "worktree <path>", "branch refs/heads/<name>", etc.
  let currentPath: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length);
    } else if (line === '') {
      currentPath = null;
    } else if (
      line.startsWith('branch ') &&
      line === `branch refs/heads/${branch}`
    ) {
      if (currentPath) {
        return currentPath;
      }
    }
  }
  return null;
}

async function mergeWorktreeInner(
  params: MergeWorktreeParams,
): Promise<MergeWorktreeResult> {
  const {
    worktreePath,
    projectPath,
    targetBranch,
    squash = false,
    commitMessage,
    noVerify = false,
  } = params;

  dbg.worktree('mergeWorktree: %o', {
    worktreePath,
    projectPath,
    targetBranch,
    squash,
  });

  // Check if worktree still exists before attempting operations
  if (!(await pathExists(worktreePath))) {
    dbg.worktree('Worktree no longer exists at %s', worktreePath);
    return { success: false, error: 'Worktree no longer exists' };
  }

  try {
    // Get the branch name of the worktree
    const { stdout: branchOutput } = await execAsync(
      'git rev-parse --abbrev-ref HEAD',
      {
        cwd: worktreePath,
        encoding: 'utf-8',
      },
    );
    const worktreeBranch = branchOutput.trim();
    dbg.worktree('Merging branch %s into %s', worktreeBranch, targetBranch);

    // Pre-check for conflicts using merge-tree (read-only, no working tree changes)
    dbg.worktree('Pre-checking for merge conflicts');
    try {
      await execFileAsync(
        'git',
        ['merge-tree', '--write-tree', targetBranch, worktreeBranch],
        { cwd: projectPath, encoding: 'utf-8' },
      );
    } catch (conflictError) {
      const conflictMsg = getExecErrorMessage(conflictError);
      if (isMergeConflictError(conflictMsg)) {
        return {
          success: false,
          error:
            'Merge failed due to conflicts. Resolve manually in your editor.',
        };
      }
      // Non-conflict error from merge-tree — let it fall through to the
      // actual merge which will produce a better error message.
    }

    // Determine where to run the merge. If the target branch is already
    // checked out somewhere (main repo or another worktree), merge there
    // directly. Otherwise checkout the target branch in the main repo first.
    const targetCheckedOutAt = await findWorktreeForBranch(
      projectPath,
      targetBranch,
    );
    const mergeCwd = targetCheckedOutAt ?? projectPath;
    dbg.worktree(
      'Merge cwd: %s (target checked out: %s)',
      mergeCwd,
      targetCheckedOutAt != null,
    );

    if (!targetCheckedOutAt) {
      // Target branch is not checked out anywhere — checkout in main repo
      dbg.worktree('Checking out target branch %s', targetBranch);
      await execAsync(`git checkout ${JSON.stringify(targetBranch)}`, {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    }

    if (squash) {
      // Squash merge: combine all commits into staged changes, then commit with custom message
      dbg.worktree('Performing squash merge');
      await execAsync(`git merge --squash ${JSON.stringify(worktreeBranch)}`, {
        cwd: mergeCwd,
        encoding: 'utf-8',
      });

      // Commit the squashed changes with the provided message
      const message =
        commitMessage || `Squash merge branch '${worktreeBranch}'`;
      await gitCommit({ cwd: mergeCwd, message, noVerify });
    } else {
      // Regular merge
      dbg.worktree('Performing regular merge');
      await execFileAsync(
        'git',
        ['merge', ...(noVerify ? ['--no-verify'] : []), worktreeBranch],
        {
          cwd: mergeCwd,
          encoding: 'utf-8',
        },
      );
    }

    dbg.worktree('Merge successful');

    await cleanupWorktree({
      worktreePath,
      projectPath,
      branchName: worktreeBranch,
      branchCleanup: 'delete',
      force: true,
    });

    dbg.worktree('Merge complete, worktree cleaned up');
    return { success: true };
  } catch (error) {
    const errorMessage = getExecErrorMessage(error);
    dbg.worktree('Merge failed: %s', errorMessage);

    // Check if it's a merge conflict
    if (isMergeConflictError(errorMessage)) {
      return {
        success: false,
        error:
          'Merge failed due to conflicts. Resolve manually in your editor.',
      };
    }

    return { success: false, error: errorMessage };
  }
}

export async function checkMergeConflicts(
  params: CheckMergeConflictsParams,
): Promise<CheckMergeConflictsResult> {
  const { worktreePath, projectPath, targetBranch } = params;

  if (!(await pathExists(worktreePath))) {
    return {
      hasConflicts: false,
      error: 'Worktree no longer exists',
    };
  }

  if (!(await pathExists(projectPath))) {
    return {
      hasConflicts: false,
      error: 'Project path no longer exists',
    };
  }

  try {
    const { stdout: branchOutput } = await execAsync(
      'git rev-parse --abbrev-ref HEAD',
      {
        cwd: worktreePath,
        encoding: 'utf-8',
      },
    );
    const worktreeBranch = branchOutput.trim();

    const { stdout } = await execAsync(
      `git merge-tree --write-tree --messages ${JSON.stringify(targetBranch)} ${JSON.stringify(worktreeBranch)}`,
      {
        cwd: projectPath,
        encoding: 'utf-8',
      },
    );

    if (isMergeConflictError(stdout)) {
      return { hasConflicts: true };
    }

    return { hasConflicts: false };
  } catch (error) {
    const errorMessage = getExecErrorMessage(error);
    if (isMergeConflictError(errorMessage)) {
      return { hasConflicts: true };
    }

    return {
      hasConflicts: false,
      error: `Failed to check merge conflicts: ${errorMessage}`,
    };
  }
}

/**
 * Pushes the current branch to a remote.
 * SSH passphrase/password prompts are routed through the askpass broker and
 * surfaced as a dialog so users can authenticate interactively.
 */
export async function pushBranch(params: {
  worktreePath: string;
  branchName: string;
  remote?: string;
  /** See runGitWithSshPrompt. Pass false when the push is a mid-flow step. */
  offerKeyUnlock?: boolean;
}): Promise<void> {
  const remote = params.remote ?? 'origin';
  dbg.worktree('pushBranch: %s to %s', params.branchName, remote);

  return runGitWithSshPrompt({
    args: ['push', '-u', remote, params.branchName],
    cwd: params.worktreePath,
    label: 'git push',
    offerKeyUnlock: params.offerKeyUnlock,
  });
}

/**
 * Ceiling for git operations that talk to a remote. Generous enough for a
 * large push, short enough that a blackholed connection cannot pin the askpass
 * socket and child process for the lifetime of the app.
 */
const GIT_NETWORK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long a credential dialog stays up before it is withdrawn. Shorter than
 * GIT_NETWORK_TIMEOUT_MS so the user gets a real error rather than the command
 * dying under an open dialog.
 */
const SSH_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Renames the local branch a worktree is checked out on and returns the branch
 * it was previously on.
 *
 * The branch to rename is read from the worktree's actual HEAD rather than
 * taken from the caller: `Task.branchName` can be null on older tasks, and the
 * path-derived fallback is only a naming convention, so trusting it risks
 * renaming an unrelated branch.
 *
 * Refuses to rename a branch that has an upstream. `git branch -m` moves the
 * tracking config to the new name while the remote branch keeps the old one,
 * which silently splits a subsequent push (and any open PR) across two refs.
 */
export async function renameWorktreeBranch(params: {
  worktreePath: string;
  newBranch: string;
}): Promise<{ previousBranch: string }> {
  const { worktreePath, newBranch } = params;

  const currentBranch = await getCurrentBranchName(worktreePath);
  if (!currentBranch || currentBranch === 'HEAD') {
    throw new Error(
      'This worktree is not on a branch (detached HEAD) and cannot be renamed',
    );
  }
  dbg.worktree('renameWorktreeBranch: %s -> %s', currentBranch, newBranch);

  await execFileAsync(
    'git',
    ['check-ref-format', `refs/heads/${newBranch}`],
    { cwd: worktreePath, encoding: 'utf-8' },
  ).catch(() => {
    throw new Error(`"${newBranch}" is not a valid git branch name`);
  });

  const { stdout: existing } = await execFileAsync(
    'git',
    ['branch', '--list', newBranch, '--format=%(refname:short)'],
    { cwd: worktreePath, encoding: 'utf-8' },
  );
  if (existing.trim()) {
    throw new Error(`Branch ${newBranch} already exists`);
  }

  const upstream = await getUpstreamRef({
    worktreePath,
    branchName: currentBranch,
  });
  if (upstream) {
    throw new Error(
      `Branch ${currentBranch} is already pushed to ${upstream.remote}/${upstream.branch}. ` +
        'Renaming it would leave the remote branch (and any open pull request) behind.',
    );
  }

  await execFileAsync('git', ['branch', '-m', currentBranch, newBranch], {
    cwd: worktreePath,
    encoding: 'utf-8',
  });

  return { previousBranch: currentBranch };
}

/**
 * Pulls the latest commits for a branch from a remote into the worktree.
 * Uses the same interactive SSH prompt handling as pushBranch.
 *
 * `remote` is only a fallback: when the branch has an upstream configured, its
 * remote wins.
 */
export async function pullBranch(params: {
  worktreePath: string;
  branchName: string;
  remote?: string;
}): Promise<void> {
  const remote = params.remote ?? 'origin';

  // The local branch name is not always the remote branch name (PR review
  // worktrees create a local `jean-claude/review-...` branch from
  // `origin/<pr-branch>`), so prefer the configured upstream ref.
  const upstream = await getUpstreamRef({
    worktreePath: params.worktreePath,
    branchName: params.branchName,
  });
  const remoteRef = upstream ?? { remote, branch: params.branchName };

  dbg.worktree(
    'pullBranch: local=%s remote=%s/%s (upstream=%s)',
    params.branchName,
    remoteRef.remote,
    remoteRef.branch,
    upstream ? 'yes' : 'no',
  );

  try {
    await runGitWithSshPrompt({
      args: ['pull', '--ff-only', remoteRef.remote, remoteRef.branch],
      cwd: params.worktreePath,
      label: 'git pull',
    });
  } catch (error) {
    throw new Error(
      explainPullFailure({
        message: getExecErrorMessage(error),
        remoteBranch: remoteRef.branch,
      }),
    );
  }
}

/**
 * Resolves the upstream tracking ref of a branch from git config, e.g.
 * `branch.x.remote=origin` + `branch.x.merge=refs/heads/feature/a` ->
 * `{ remote: 'origin', branch: 'feature/a' }`.
 *
 * Reads config instead of parsing `rev-parse --abbrev-ref @{u}` because that
 * output is ambiguous: `feature/a` could mean remote `feature` branch `a`, or a
 * local-tracking branch named `feature/a`. Returns null when the branch has no
 * upstream, or when it tracks a local branch (`branch.x.remote='.'`).
 */
async function getUpstreamRef(params: {
  worktreePath: string;
  branchName: string;
}): Promise<{ remote: string; branch: string } | null> {
  const readConfig = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', key], {
        cwd: params.worktreePath,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  };

  const [remote, merge] = await Promise.all([
    readConfig(`branch.${params.branchName}.remote`),
    readConfig(`branch.${params.branchName}.merge`),
  ]);

  // '.' means the branch tracks another local branch — nothing to pull from.
  if (!remote || !merge || remote === '.') return null;

  const branch = merge.startsWith('refs/heads/')
    ? merge.slice('refs/heads/'.length)
    : merge;
  if (!branch) return null;

  return { remote, branch };
}

/**
 * Turns raw `git pull --ff-only` stderr into actionable guidance.
 */
function explainPullFailure(params: {
  message: string;
  remoteBranch: string;
}): string {
  const { message, remoteBranch } = params;

  if (/couldn['’]t find remote ref|no such ref was fetched/i.test(message)) {
    return `Pull failed because "${remoteBranch}" does not exist on the remote yet. Push the branch first, then pull again.\n\n${message}`;
  }

  if (/would be overwritten by merge|local changes/i.test(message)) {
    return `Pull failed because the worktree has uncommitted changes. Commit or discard them, then pull again.\n\n${message}`;
  }

  if (/Not possible to fast-forward|diverging|non-fast-forward/i.test(message)) {
    return `Pull failed because the local branch has diverged from the remote. Rebase or merge manually, then pull again.\n\n${message}`;
  }

  return message;
}

/** User cancelled the SSH prompt — reported without a raw git stderr dump. */
class SshAuthCancelledError extends Error {
  constructor(label: string) {
    super(`${label} cancelled: SSH authentication was not completed`);
    this.name = 'SshAuthCancelledError';
  }
}

/**
 * Runs a git command that may prompt for SSH credentials, surfacing the prompt
 * to the renderer via the global prompt dialog.
 *
 * ssh reads passphrases from /dev/tty, never from stdin, so a GUI process can
 * only answer through the SSH_ASKPASS protocol — see ssh-askpass-broker.
 * When the user unlocks a passphrase-protected key we offer to hand it to
 * ssh-agent so the rest of the session is prompt-free.
 */
export async function runGitWithSshPrompt(params: {
  args: string[];
  cwd: string;
  label: string;
  /**
   * Whether to offer adding an unlocked key to ssh-agent afterwards. Off for
   * pushes that are one step of a longer flow (PR creation), where the dialog
   * would land after the UI has already moved on.
   */
  offerKeyUnlock?: boolean;
  /** Overrides the default network timeout. */
  timeoutMs?: number;
}): Promise<void> {
  let cancelled = false;
  let unrecognisedPrompt: string | null = null;
  /** Held in memory only, to optionally forward to ssh-add. Never persisted. */
  let unlockedKey: { keyPath: string; passphrase: string } | null = null;

  const handlePrompt = async (
    request: SshPromptRequest,
  ): Promise<string | null> => {
    {
      // ssh offers each candidate identity in turn and retries a key up to
      // three times. Without this, clicking Cancel with two encrypted keys
      // configured pops a fresh dialog for the next key.
      if (cancelled) return null;

      const { sendGlobalPromptToWindow, sendGlobalInputPrompt } = await import(
        './global-prompt-service'
      );

      // An unrecognised prompt must not be answered blindly — we have no idea
      // what ssh is asking for, and a masked box would invite a secret.
      if (request.kind === 'unknown') {
        dbg.ssh('unrecognised prompt, declining: %s', request.prompt.trim());
        cancelled = true;
        unrecognisedPrompt = request.prompt.trim();
        return null;
      }

      if (request.kind === 'confirm') {
        const accepted = await sendGlobalPromptToWindow(
          {
            title: 'Unknown SSH Host',
            message:
              'The server’s identity cannot be verified. Only continue if you recognise this host.',
            details: request.prompt.trim(),
            acceptLabel: 'Continue',
            rejectLabel: 'Cancel',
          },
          { timeoutMs: SSH_PROMPT_TIMEOUT_MS, signal: request.signal },
        );
        if (!accepted) cancelled = true;
        return accepted ? 'yes' : null;
      }

      const keyName = request.keyPath ? path.basename(request.keyPath) : null;
      // A retry only makes sense for a value we asked the user to type; a
      // username is not "incorrect" on the second identity.
      const retry = request.attempt > 1 && request.kind === 'passphrase';

      const response = await sendGlobalInputPrompt({
        title: retry
          ? 'Incorrect passphrase — try again'
          : request.kind === 'passphrase'
            ? `Unlock SSH key${keyName ? ` ${keyName}` : ''}`
            : request.kind === 'username'
              ? 'Sign in to the remote'
              : 'SSH Authentication Required',
        message:
          request.kind === 'passphrase'
            ? `Enter the passphrase for ${request.keyPath ?? 'your SSH key'} to ${params.label === 'git push' ? 'push' : 'continue'}.`
            : request.kind === 'username'
              ? 'Enter your username for the remote repository.'
              : 'Enter your password to continue.',
        details: request.prompt.trim(),
        // A username is not a secret and must stay readable.
        inputType: request.kind === 'username' ? 'text' : 'password',
        inputPlaceholder:
          request.kind === 'passphrase'
            ? 'Key passphrase'
            : request.kind === 'username'
              ? 'Username'
              : 'Password',
        acceptLabel: request.kind === 'passphrase' ? 'Unlock' : 'Continue',
        rejectLabel: 'Cancel',
      }, { timeoutMs: SSH_PROMPT_TIMEOUT_MS, signal: request.signal });

      if (!response.accepted || response.inputValue == null) {
        cancelled = true;
        return null;
      }

      if (request.kind === 'passphrase' && request.keyPath) {
        unlockedKey = {
          keyPath: request.keyPath,
          passphrase: response.inputValue,
        };
      }

      return response.inputValue;
    }
  };

  const result = await runWithSshAskpass({
    command: 'git',
    args: params.args,
    cwd: params.cwd,
    // A push can legitimately take a while on a large repo, but must not pin
    // the broker socket and child process forever if the network blackholes.
    timeoutMs: params.timeoutMs ?? GIT_NETWORK_TIMEOUT_MS,
    handler: async (request) => {
      // A prompt that failed (timed out, window gone, renderer reloaded) was
      // not authorised by anyone, so treat it as a refusal. Without this,
      // `cancelled` stays false and ssh walks on to the next identity, opening
      // a fresh dialog for every remaining key.
      try {
        return await handlePrompt(request);
      } catch (error) {
        dbg.ssh('prompt failed, treating as cancelled: %O', error);
        cancelled = true;
        return null;
      }
    },
  });

  if (result.code === 0) {
    dbg.worktree('%s successful', params.label);
    if (params.offerKeyUnlock !== false) void offerToAddKeyToAgent(unlockedKey);
    return;
  }

  if (unrecognisedPrompt) {
    // Distinct from a user cancellation: we declined, and the prompt text is
    // the only clue to what ssh actually wanted.
    throw new Error(
      `${params.label} failed: Jean-Claude did not recognise an SSH prompt and declined to answer it.\n\nPrompt: ${unrecognisedPrompt}\n\n${result.stderr.trim()}`,
    );
  }

  if (cancelled) throw new SshAuthCancelledError(params.label);

  const errorMessage =
    result.stderr.trim() || result.stdout.trim() || `Exit code ${result.code}`;
  throw new Error(`${params.label} failed: ${explainSshFailure(errorMessage)}`);
}

/**
 * After a successful authentication, offers to load the key into ssh-agent so
 * the user is not asked again for the rest of the session.
 *
 * Fire-and-forget: the push already succeeded, and failing to cache the key
 * must never turn a successful push into an error.
 */
async function offerToAddKeyToAgent(
  unlocked: { keyPath: string; passphrase: string } | null,
): Promise<void> {
  if (!unlocked) return;

  try {
    const status = await getSshAgentStatus();
    if (status.state === 'unavailable') {
      dbg.ssh('skipping ssh-add offer: no ssh-agent available');
      return;
    }
    if (await isKeyLoadedInAgent(unlocked.keyPath)) return;

    const { sendGlobalPromptToWindow } = await import(
      './global-prompt-service'
    );
    const accepted = await sendGlobalPromptToWindow({
      title: 'Remember this SSH key?',
      message: `Add ${path.basename(unlocked.keyPath)} to your ssh-agent so you are not asked for the passphrase again during this session. The passphrase is handed to ssh-agent and never stored by Jean-Claude.`,
      details: unlocked.keyPath,
      acceptLabel: 'Add to ssh-agent',
      rejectLabel: 'Not now',
    });
    if (!accepted) return;

    const outcome = await addKeyToAgent(unlocked);
    if (!outcome.added) {
      dbg.ssh('ssh-add declined by agent: %s', outcome.error);
    }
  } catch (error) {
    dbg.ssh('ssh-add offer failed: %O', error);
  }
}

/** Turns common SSH failures into guidance instead of raw git noise. */
function explainSshFailure(message: string): string {
  if (/Permission denied \(publickey/i.test(message)) {
    return `${message}\n\nNo usable SSH key was offered. Check that your key is added to the remote and, if it has a passphrase, that you unlocked it.`;
  }
  if (/Host key verification failed/i.test(message)) {
    return `${message}\n\nThe host was not trusted, so the connection was refused.`;
  }
  if (/Could not open a connection to your authentication agent/i.test(message)) {
    return `${message}\n\nNo ssh-agent is running.`;
  }
  return message;
}

/**
 * Gets the unified diff content for all changed files in a worktree.
 * This is useful for AI summary generation where we need the actual diff text.
 *
 * @param worktreePath - The path to the worktree
 * @param startCommitHash - Fallback commit hash (used if sourceBranch unavailable)
 * @param sourceBranch - The source branch to compute diff against (optional)
 * @returns The unified diff output as a string
 */
export async function getWorktreeUnifiedDiff(
  worktreePath: string,
  startCommitHash: string,
  sourceBranch?: string | null,
): Promise<string> {
  dbg.worktree('getWorktreeUnifiedDiff called %o', {
    worktreePath,
    startCommitHash,
    sourceBranch,
  });

  // Check if the worktree still exists
  if (!(await pathExists(worktreePath))) {
    dbg.worktree('Worktree path does not exist');
    return '';
  }

  try {
    // Get the appropriate base commit for diffing
    const { baseCommit, sourceRef } = await getDiffBaseCommit(
      worktreePath,
      startCommitHash,
      sourceBranch ?? null,
    );

    // Get task-changed files to filter out merge artifacts
    const taskChangedFiles = await getTaskChangedFiles(
      worktreePath,
      sourceRef,
    );

    if (taskChangedFiles && taskChangedFiles.size > 0) {
      // Generate diff only for task-changed files to exclude merge artifacts
      const fileArgs = [...taskChangedFiles]
        .map((f) => `"${escapeForShell(f)}"`)
        .join(' ');
      const { stdout: diffOutput } = await execAsync(
        `git diff -U3 ${baseCommit} -- ${fileArgs}`,
        {
          cwd: worktreePath,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      dbg.worktree(
        'Got unified diff (filtered), length: %d',
        diffOutput.length,
      );
      return diffOutput;
    } else if (taskChangedFiles && taskChangedFiles.size === 0) {
      // All changes are merge artifacts
      dbg.worktree('No task-changed files, returning empty diff');
      return '';
    }

    // No source branch to filter against — return full diff
    const { stdout: diffOutput } = await execAsync(
      `git diff -U3 ${baseCommit}`,
      {
        cwd: worktreePath,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    dbg.worktree('Got unified diff, length: %d', diffOutput.length);
    return diffOutput;
  } catch (error) {
    dbg.worktree('Error getting unified diff: %O', error);
    return '';
  }
}

/**
 * Returns the git log (one-line format) for commits since startCommitHash.
 */
export async function getWorktreeCommitLog(
  worktreePath: string,
  startCommitHash: string,
): Promise<string> {
  // Validate commit hash to prevent shell injection
  if (!/^[0-9a-f]{7,40}$/i.test(startCommitHash)) {
    dbg.worktree('Invalid commit hash for log: %s', startCommitHash);
    return '';
  }

  try {
    const { stdout } = await execAsync(
      `git log --oneline ${startCommitHash}..HEAD --`,
      { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export interface WorktreeCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string; // ISO 8601
}

export async function getWorktreeCommits(
  worktreePath: string,
  startCommitHash: string,
): Promise<WorktreeCommit[]> {
  if (!/^[0-9a-f]{7,40}$/i.test(startCommitHash)) {
    dbg.worktree('Invalid commit hash for commits: %s', startCommitHash);
    return [];
  }

  try {
    const DELIM = '---COMMIT-DELIM---';
    const { stdout } = await execAsync(
      `git log --format='%H%n%h%n%s%n%an%n%aI%n${DELIM}' ${startCommitHash}..HEAD --`,
      { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );

    if (!stdout.trim()) return [];

    const commits: WorktreeCommit[] = [];
    const blocks = stdout.split(DELIM).filter((b) => b.trim());

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length >= 5) {
        commits.push({
          hash: lines[0]!,
          shortHash: lines[1]!,
          message: lines[2]!,
          author: lines[3]!,
          date: lines[4]!,
        });
      }
    }

    return commits;
  } catch {
    return [];
  }
}

/**
 * Returns the list of files changed in a specific commit.
 */
export async function getWorktreeCommitDiff(
  worktreePath: string,
  commitHash: string,
): Promise<
  {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    additions: number;
    deletions: number;
  }[]
> {
  // Validate commit hash
  if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) {
    dbg.worktree('Invalid commit hash for commit diff: %s', commitHash);
    return [];
  }

  try {
    // Get file list with status
    const { stdout: nameStatus } = await execAsync(
      `git diff --name-status ${commitHash}^..${commitHash}`,
      { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );

    // Get per-file line counts
    const { stdout: numstatOutput } = await execAsync(
      `git diff --numstat ${commitHash}^..${commitHash}`,
      { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );

    const numstatMap = new Map<
      string,
      { additions: number; deletions: number }
    >();
    for (const line of numstatOutput.split('\n')) {
      if (!line.trim()) continue;
      const [adds, dels, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t');
      numstatMap.set(filePath, {
        additions: adds === '-' ? 0 : parseInt(adds!, 10),
        deletions: dels === '-' ? 0 : parseInt(dels!, 10),
      });
    }

    const files: {
      path: string;
      status: 'added' | 'modified' | 'deleted';
      additions: number;
      deletions: number;
    }[] = [];
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue;
      const [statusCode, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t');
      if (!filePath) continue;

      let status: 'added' | 'modified' | 'deleted' = 'modified';
      if (statusCode === 'A') status = 'added';
      else if (statusCode === 'D') status = 'deleted';

      const stats = numstatMap.get(filePath) ?? {
        additions: 0,
        deletions: 0,
      };
      files.push({
        path: filePath,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
      });
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Returns the old and new content of a file for a specific commit.
 */
export async function getWorktreeCommitFileContent(
  worktreePath: string,
  commitHash: string,
  filePath: string,
  status: 'added' | 'modified' | 'deleted',
): Promise<{
  oldContent: string | null;
  newContent: string | null;
  isBinary: boolean;
  oldImageDataUrl?: string | null;
  newImageDataUrl?: string | null;
  oldSpreadsheetBase64?: string | null;
  newSpreadsheetBase64?: string | null;
}> {
  // Validate commit hash
  if (!/^[0-9a-f]{7,40}$/i.test(commitHash)) {
    return { oldContent: null, newContent: null, isBinary: false };
  }

  // Spreadsheets are binary: both sides come straight from git as raw bytes.
  if (isSpreadsheetPath(filePath)) {
    const [oldSpreadsheetBase64, newSpreadsheetBase64] = await Promise.all([
      status === 'added'
        ? Promise.resolve(null)
        : readGitFileBase64(worktreePath, `${commitHash}^`, filePath),
      status === 'deleted'
        ? Promise.resolve(null)
        : readGitFileBase64(worktreePath, commitHash, filePath),
    ]);
    return {
      oldContent: null,
      newContent: null,
      isBinary: true,
      oldSpreadsheetBase64,
      newSpreadsheetBase64,
    };
  }

  try {
    let oldContent: string | null = null;
    let newContent: string | null = null;
    let oldImageDataUrl: string | null = null;
    let newImageDataUrl: string | null = null;
    const mimeType = getImageMimeType(filePath);
    const isSvg = isSvgPath(filePath);

    if (status !== 'added') {
      try {
        if (mimeType && !isSvg) {
          const { stdout } = await execAsync(
            `git show ${commitHash}^:"${escapeForShell(filePath)}" | base64`,
            {
              cwd: worktreePath,
              encoding: 'utf-8',
              maxBuffer: 15 * 1024 * 1024,
            },
          );
          oldImageDataUrl = `data:${mimeType};base64,${stdout.replace(/\s/g, '')}`;
        } else {
          const { stdout } = await execAsync(
            `git show ${commitHash}^:"${escapeForShell(filePath)}"`,
            {
              cwd: worktreePath,
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          oldContent = stdout;
        }
      } catch {
        oldContent = null;
      }
    }

    if (status !== 'deleted') {
      try {
        if (mimeType && !isSvg) {
          const { stdout } = await execAsync(
            `git show ${commitHash}:"${escapeForShell(filePath)}" | base64`,
            {
              cwd: worktreePath,
              encoding: 'utf-8',
              maxBuffer: 15 * 1024 * 1024,
            },
          );
          newImageDataUrl = `data:${mimeType};base64,${stdout.replace(/\s/g, '')}`;
        } else {
          const { stdout } = await execAsync(
            `git show ${commitHash}:"${escapeForShell(filePath)}"`,
            {
              cwd: worktreePath,
              encoding: 'utf-8',
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          newContent = stdout;
        }
      } catch {
        newContent = null;
      }
    }

    // Simple binary detection
    const isBinary =
      (mimeType !== null && !isSvg) ||
      (oldContent !== null && oldContent.includes('\0')) ||
      (newContent !== null && newContent.includes('\0'));

    return {
      oldContent,
      newContent,
      isBinary,
      oldImageDataUrl,
      newImageDataUrl,
    };
  } catch {
    return { oldContent: null, newContent: null, isBinary: false };
  }
}
