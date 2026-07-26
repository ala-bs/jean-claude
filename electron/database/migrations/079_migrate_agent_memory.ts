import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

import type { Kysely } from 'kysely';

import {
  AGENT_MEMORY_MAX_EVENT_TEXT_CHARS,
  AGENT_MEMORY_SCHEMA_VERSION,
  type AgentMemoryEvent,
  agentMemoryExtractionStateSchema,
  normalizeAgentMemoryEvent,
} from '@shared/agent-memory-types';

import {
  assertSafeAgentMemoryTree,
  ensureAgentMemoryProjectsDirectory,
  getAgentMemoryProjectKey,
  getAgentMemoryProjectPaths,
  getAgentMemoryProjectsDir,
  readAgentMemoryJson,
  UnsafeAgentMemoryPathError,
} from '../../services/agent-memory-storage';
import { redactAgentMemoryValue } from '../../services/agent-memory-redaction';

const OLD_REVIEWS_DIRECTORY = 'user-reviews';
const STAGING_PREFIX = '.agent-memory-staging-';
const BACKUP_PREFIX = '.agent-memory-backup-';
const FAILED_ACTIVE_PREFIX = '.agent-memory-failed-active-';
export const AGENT_MESSAGE_LATEST_RESULT_INDEX =
  'agent_messages_step_type_message_index_idx';
const CLEANUP_DIRECTORY_NAME = '.agent-memory-cleanup-076';

interface ProjectRecord {
  id: string;
  name: string | null;
  path: string;
}

const PROJECT_RESIDUE_PREFIXES = [
  STAGING_PREFIX,
  BACKUP_PREFIX,
  FAILED_ACTIVE_PREFIX,
] as const;
const HASHED_PROJECT_KEY_PREFIX = '.hashed-';

/**
 * Entries the OS (or a crashed earlier migration) can leave behind that are not
 * Agent Memory project directories. Failing the migration on these would make
 * the app unlaunchable, so they are ignored instead.
 *
 * IMPORTANT: `getAgentMemoryProjectKey` encodes project ids that are not
 * filename-safe as `.hashed-<32 hex>`, so a leading dot does NOT imply junk.
 * Those are real project directories and must still be migrated.
 */
function isIgnorableProjectsEntry(name: string): boolean {
  if (name === CLEANUP_DIRECTORY_NAME) return true;
  if (isProjectResidueEntry(name)) return true;
  return name.startsWith('.') && !name.startsWith(HASHED_PROJECT_KEY_PREFIX);
}

function isProjectResidueEntry(name: string): boolean {
  return PROJECT_RESIDUE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseRetainedProjectMetadata(
  value: unknown,
  projectDirectory: string,
): ProjectRecord {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'id,name,sourcePath' ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    (value.name !== null && typeof value.name !== 'string') ||
    typeof value.sourcePath !== 'string'
  ) {
    throw new Error(
      `Invalid retained Agent Memory project metadata: ${projectDirectory}`,
    );
  }
  return { id: value.id, name: value.name, path: value.sourcePath };
}

async function discoverRetainedProjects(
  homeDirectory: string,
): Promise<{ residueEntries: string[]; projects: ProjectRecord[] }> {
  const projectsDirectory = getAgentMemoryProjectsDir(homeDirectory);
  const entries = await fs.readdir(projectsDirectory, { withFileTypes: true });
  const projects: ProjectRecord[] = [];
  const residueEntries: string[] = [];
  for (const entry of entries) {
    if (isProjectResidueEntry(entry.name)) {
      residueEntries.push(entry.name);
      continue;
    }
    if (isIgnorableProjectsEntry(entry.name)) {
      continue;
    }
    const projectDirectory = path.join(projectsDirectory, entry.name);
    const stat = await fs.lstat(projectDirectory);
    if (stat.isSymbolicLink()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe retained Agent Memory project directory: ${projectDirectory}`,
      );
    }
    if (!stat.isDirectory()) {
      // Stray file (e.g. editor scratch file) — not a project, safe to ignore.
      continue;
    }
    await assertSafeAgentMemoryTree(projectDirectory);
    let metadata: ProjectRecord;
    try {
      metadata = parseRetainedProjectMetadata(
        await readAgentMemoryJson({
          homeDirectory,
          filePath: path.join(projectDirectory, 'project.json'),
        }),
        projectDirectory,
      );
    } catch (error) {
      if (error instanceof UnsafeAgentMemoryPathError) throw error;
      throw new Error(
        `Invalid retained Agent Memory project metadata: ${projectDirectory}`,
        { cause: error },
      );
    }
    if (getAgentMemoryProjectKey(metadata.id) !== entry.name) {
      throw new Error(
        `Retained Agent Memory project key does not match metadata: ${projectDirectory}`,
      );
    }
    projects.push(metadata);
  }
  return { residueEntries, projects };
}

function combineProjects({
  databaseProjects,
  retainedProjects,
}: {
  databaseProjects: ProjectRecord[];
  retainedProjects: ProjectRecord[];
}): ProjectRecord[] {
  const projects = new Map(
    retainedProjects.map((project) => [project.id, project]),
  );
  for (const project of databaseProjects) projects.set(project.id, project);
  return [...projects.values()];
}

/**
 * `recoverInterruptedMigration` only looks at residue derived from the known
 * project list, so residue belonging to a project that exists neither in the
 * database nor on disk would never be touched. That is disk waste, not
 * corruption, so warn rather than throw — throwing here previously made the
 * app unlaunchable.
 */
function warnAboutOrphanedResidue({
  residueEntries,
  projects,
}: {
  residueEntries: string[];
  projects: ProjectRecord[];
}): void {
  const knownResidue = new Set<string>();
  for (const project of projects) {
    const projectKey = getAgentMemoryProjectKey(project.id);
    for (const prefix of PROJECT_RESIDUE_PREFIXES) {
      knownResidue.add(`${prefix}${projectKey}`);
    }
  }
  const orphaned = residueEntries.filter((entry) => !knownResidue.has(entry));
  if (orphaned.length > 0) {
    console.warn(
      `Leaving orphaned Agent Memory residue in place: ${orphaned.join(', ')}`,
    );
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function deterministicEventId(projectId: string, sourceId: string): string {
  const digest = createHash('sha256')
    .update(`preference-memory-migration\0${projectId}\0${sourceId}`)
    .digest('hex');
  return `migrated-${digest}`;
}

function optionalNonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function convertTaskReviewRecord(
  value: Record<string, unknown>,
  projectId: string,
): AgentMemoryEvent {
  const sourceId = optionalNonemptyString(value.id);
  const rawCreatedAt = optionalNonemptyString(value.createdAt);
  const comment = value.comment;
  if (!sourceId || !rawCreatedAt || !isRecord(comment)) {
    throw new Error('Invalid task-review-comment record');
  }
  const body = typeof comment.body === 'string' ? comment.body : null;
  const timestamp = Date.parse(rawCreatedAt);
  if (body === null || !Number.isFinite(timestamp)) {
    throw new Error(`Invalid task-review-comment record: ${sourceId}`);
  }

  const lineStart =
    typeof comment.lineStart === 'number' &&
    Number.isInteger(comment.lineStart) &&
    comment.lineStart > 0
      ? comment.lineStart
      : null;
  const lineEnd =
    typeof comment.lineEnd === 'number' &&
    Number.isInteger(comment.lineEnd) &&
    comment.lineEnd > 0
      ? comment.lineEnd
      : null;
  const validRange =
    lineStart !== null && lineEnd !== null && lineEnd >= lineStart;
  const unredacted = {
    schemaVersion: AGENT_MEMORY_SCHEMA_VERSION,
    id: deterministicEventId(projectId, sourceId),
    sourceId,
    source: 'task-review' as const,
    projectId,
    ...(optionalNonemptyString(value.taskId)
      ? { taskId: value.taskId as string }
      : {}),
    text: body,
    createdAt: new Date(timestamp).toISOString(),
    context: {
      selectedText:
        typeof comment.selectedText === 'string' ? comment.selectedText : null,
      filePath: typeof comment.filePath === 'string' ? comment.filePath : null,
      lineStart: validRange ? lineStart : null,
      lineEnd: validRange ? lineEnd : null,
      presets: Array.isArray(comment.presets)
        ? comment.presets.filter(
            (preset): preset is string =>
              typeof preset === 'string' && preset.length > 0,
          )
        : [],
    },
    redactions: [],
  };
  const redacted = redactAgentMemoryValue(unredacted);
  const redactedEvent = redacted.value as typeof unredacted;
  return normalizeAgentMemoryEvent({
    ...redactedEvent,
    ...(redactedEvent.text.length > AGENT_MEMORY_MAX_EVENT_TEXT_CHARS
      ? {
          text: redactedEvent.text.slice(0, AGENT_MEMORY_MAX_EVENT_TEXT_CHARS),
          textTruncated: true,
        }
      : {}),
    redactions: redacted.markers,
  });
}

async function readConvertedEvents({
  projectId,
  projectDirectory,
}: {
  projectId: string;
  projectDirectory: string;
}): Promise<AgentMemoryEvent[]> {
  const reviewsDirectory = path.join(projectDirectory, OLD_REVIEWS_DIRECTORY);
  if (!(await pathExists(reviewsDirectory))) return [];
  const stat = await fs.lstat(reviewsDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe Preference Memory reviews directory: ${reviewsDirectory}`);
  }
  const fileNames = (await fs.readdir(reviewsDirectory))
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .sort();
  const events: AgentMemoryEvent[] = [];
  const sourceIds = new Set<string>();
  for (const fileName of fileNames) {
    const filePath = path.join(reviewsDirectory, fileName);
    const fileStat = await fs.lstat(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error(`Unsafe Preference Memory review file: ${filePath}`);
    }
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    // A crash mid-append leaves the final line truncated and the file without a
    // trailing newline. That is expected residue, not corruption, and must not
    // abort the whole migration — an interior bad line still does.
    const tornTailIndex =
      content.length > 0 && !content.endsWith('\n') ? lines.length - 1 : -1;
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        if (lineIndex === tornTailIndex) {
          console.warn(
            `Skipping truncated trailing Preference Memory JSONL line: ${filePath}`,
          );
          continue;
        }
        throw new Error(`Invalid Preference Memory JSONL: ${filePath}`);
      }
      if (!isRecord(value) || value.source !== 'task-review-comment') continue;
      const event = convertTaskReviewRecord(value, projectId);
      if (sourceIds.has(event.sourceId)) {
        throw new Error(`Duplicate Agent Memory source ID: ${event.sourceId}`);
      }
      sourceIds.add(event.sourceId);
      events.push(event);
    }
  }
  return events;
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function groupEventsByDate(
  events: AgentMemoryEvent[],
): Array<[string, AgentMemoryEvent[]]> {
  const byDate = new Map<string, AgentMemoryEvent[]>();
  for (const event of events) {
    const date = event.createdAt.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), event]);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function canonicalProjectContents({
  project,
  events,
}: {
  project: ProjectRecord;
  events: AgentMemoryEvent[];
}): Array<[string, string]> {
  return [
    [
      'project.json',
      jsonContent({
        id: project.id,
        name: project.name,
        sourcePath: project.path,
      }),
    ],
    [
      'memory-items.json',
      jsonContent({ schemaVersion: AGENT_MEMORY_SCHEMA_VERSION, items: [] }),
    ],
    ['project-memory.md', ''],
    [
      'extraction-state.json',
      jsonContent({
        schemaVersion: AGENT_MEMORY_SCHEMA_VERSION,
        files: {},
        lastExtractedAt: null,
        projectionPending: false,
      }),
    ],
    ...groupEventsByDate(events).map(
      ([date, dayEvents]): [string, string] => [
        path.join('events', `${date}.jsonl`),
        `${dayEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
      ],
    ),
  ];
}

function digestCanonicalContents(
  contents: Array<[string, string | Buffer]>,
): string {
  const hash = createHash('sha256');
  for (const [relativePath, content] of contents) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    hash.update(
      `${JSON.stringify([
        relativePath,
        buffer.byteLength,
        createHash('sha256').update(buffer).digest('hex'),
      ])}\n`,
    );
  }
  return hash.digest('hex');
}

async function writeStagedProject({
  project,
  stagingPath,
  events,
}: {
  project: ProjectRecord;
  stagingPath: string;
  events: AgentMemoryEvent[];
}): Promise<string> {
  await fs.mkdir(path.join(stagingPath, 'events'), {
    recursive: true,
    mode: 0o700,
  });
  await fs.mkdir(path.join(stagingPath, 'runs'), { mode: 0o700 });
  const contents = canonicalProjectContents({ project, events });
  for (const [relativePath, content] of contents) {
    await fs.writeFile(path.join(stagingPath, relativePath), content, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
  return digestCanonicalContents(contents);
}

async function canonicalDigest(projectDirectory: string): Promise<string> {
  const canonicalFiles = [
    'project.json',
    'memory-items.json',
    'project-memory.md',
    'extraction-state.json',
  ];
  const eventFiles = (await fs.readdir(path.join(projectDirectory, 'events')))
    .filter((fileName) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName))
    .sort()
    .map((fileName) => path.join('events', fileName));
  const contents = await Promise.all(
    [...canonicalFiles, ...eventFiles].map(
      async (relativePath): Promise<[string, Buffer]> => [
        relativePath,
        await fs.readFile(path.join(projectDirectory, relativePath)),
      ],
    ),
  );
  return digestCanonicalContents(contents);
}

async function verifyProject({
  projectDirectory,
  expectedCount,
  expectedDigest,
}: {
  projectDirectory: string;
  expectedCount?: number;
  expectedDigest?: string;
}): Promise<string> {
  await assertSafeAgentMemoryTree(projectDirectory);
  const expectedRootEntries = [
    'events',
    'extraction-state.json',
    'memory-items.json',
    'project-memory.md',
    'project.json',
    'runs',
  ];
  const rootEntries = (await fs.readdir(projectDirectory)).sort();
  if (
    rootEntries.length !== expectedRootEntries.length ||
    rootEntries.some((entry, index) => entry !== expectedRootEntries[index])
  ) {
    throw new Error('Invalid staged Agent Memory layout');
  }
  const paths = {
    items: path.join(projectDirectory, 'memory-items.json'),
    state: path.join(projectDirectory, 'extraction-state.json'),
    events: path.join(projectDirectory, 'events'),
    runs: path.join(projectDirectory, 'runs'),
  };
  const metadata = JSON.parse(
    await fs.readFile(path.join(projectDirectory, 'project.json'), 'utf-8'),
  ) as unknown;
  if (
    !isRecord(metadata) ||
    Object.keys(metadata).sort().join(',') !== 'id,name,sourcePath' ||
    typeof metadata.id !== 'string' ||
    metadata.id.length === 0 ||
    (metadata.name !== null && typeof metadata.name !== 'string') ||
    (metadata.sourcePath !== null && typeof metadata.sourcePath !== 'string')
  ) {
    throw new Error('Invalid staged Agent Memory project metadata');
  }
  const items = JSON.parse(await fs.readFile(paths.items, 'utf-8')) as unknown;
  if (
    !isRecord(items) ||
    items.schemaVersion !== AGENT_MEMORY_SCHEMA_VERSION ||
    !Array.isArray(items.items) ||
    items.items.length !== 0
  ) {
    throw new Error('Invalid staged Agent Memory items');
  }
  agentMemoryExtractionStateSchema.parse(
    JSON.parse(await fs.readFile(paths.state, 'utf-8')),
  );
  const runsStat = await fs.lstat(paths.runs);
  if (!runsStat.isDirectory() || (await fs.readdir(paths.runs)).length !== 0) {
    throw new Error('Invalid staged Agent Memory runs');
  }

  let count = 0;
  const sourceIds = new Set<string>();
  for (const fileName of (await fs.readdir(paths.events)).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fileName)) {
      throw new Error(`Invalid staged Agent Memory event file: ${fileName}`);
    }
    const content = await fs.readFile(path.join(paths.events, fileName), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const event = normalizeAgentMemoryEvent(JSON.parse(line));
      if (event.createdAt.slice(0, 10) !== fileName.slice(0, 10)) {
        throw new Error('Agent Memory event stored under wrong UTC date');
      }
      if (sourceIds.has(event.sourceId)) {
        throw new Error(`Duplicate Agent Memory source ID: ${event.sourceId}`);
      }
      sourceIds.add(event.sourceId);
      count += 1;
    }
  }
  if (expectedCount !== undefined && count !== expectedCount) {
    throw new Error(
      `Agent Memory converted count mismatch: expected ${expectedCount}, found ${count}`,
    );
  }
  const digest = await canonicalDigest(projectDirectory);
  if (expectedDigest && digest !== expectedDigest) {
    throw new Error('Agent Memory canonical digest mismatch');
  }
  return digest;
}

async function recoverSwap({
  projectDirectory,
  stagingPath,
  backupPath,
}: {
  projectDirectory: string;
  stagingPath: string;
  backupPath: string;
}): Promise<void> {
  await fs.rm(stagingPath, { recursive: true, force: true });
  if (!(await pathExists(backupPath))) return;
  await assertSafeAgentMemoryTree(backupPath);
  if (await pathExists(projectDirectory)) {
    await fs.rm(projectDirectory, { recursive: true, force: true });
  }
  await fs.rename(backupPath, projectDirectory);
}

async function isActivatedAgentMemoryProject(
  projectDirectory: string,
): Promise<boolean> {
  const legacyPaths = [
    OLD_REVIEWS_DIRECTORY,
    'user-reviews-state.json',
    'user-preferences.md',
    'user-preferences-history',
  ];
  if (
    (await Promise.all(
      legacyPaths.map((relativePath) =>
        pathExists(path.join(projectDirectory, relativePath)),
      ),
    )).some(Boolean)
  ) {
    return false;
  }
  const canonicalPaths = [
    'events',
    'runs',
    'project.json',
    'memory-items.json',
    'project-memory.md',
    'extraction-state.json',
  ];
  return (
    await Promise.all(
      canonicalPaths.map((relativePath) =>
        pathExists(path.join(projectDirectory, relativePath)),
      ),
    )
  ).every(Boolean);
}

interface PreparedProject {
  projectDirectory: string;
  stagingPath: string;
  backupPath: string;
  expectedCount: number;
  expectedDigest: string;
}

function cleanupDirectoryForPlans(plans: PreparedProject[]): string {
  return path.join(
    path.dirname(plans[0].projectDirectory),
    CLEANUP_DIRECTORY_NAME,
  );
}

function failedActivePath(plan: { projectDirectory: string }): string {
  return path.join(
    path.dirname(plan.projectDirectory),
    `${FAILED_ACTIVE_PREFIX}${path.basename(plan.projectDirectory)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrationFailure({
  context,
  cause,
  rollbackErrors,
}: {
  context: string;
  cause: unknown;
  rollbackErrors: unknown[];
}): AggregateError {
  return new AggregateError(
    [cause, ...rollbackErrors],
    `${context}: ${errorMessage(cause)}`,
    { cause },
  );
}

async function backupPathForRestore({
  plan,
  cleanupDirectory,
}: {
  plan: PreparedProject;
  cleanupDirectory?: string;
}): Promise<string | null> {
  const candidates = [
    ...(cleanupDirectory
      ? [path.join(cleanupDirectory, path.basename(plan.backupPath))]
      : []),
    plan.backupPath,
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function ensureVerifiedNewActive(
  plans: PreparedProject[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const plan of plans) {
    try {
      if (!(await pathExists(plan.projectDirectory))) {
        const preservedPath = failedActivePath(plan);
        const sourcePath = (await pathExists(preservedPath))
          ? preservedPath
          : plan.stagingPath;
        if (!(await pathExists(sourcePath))) {
          throw new Error(
            `Missing verified new Agent Memory tree for ${plan.projectDirectory}`,
          );
        }
        await fs.rename(sourcePath, plan.projectDirectory);
      }
      await verifyProject({
        projectDirectory: plan.projectDirectory,
        expectedCount: plan.expectedCount,
        expectedDigest: plan.expectedDigest,
      });
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function restoreProjectsConvergently({
  plans,
  cleanupDirectory,
}: {
  plans: PreparedProject[];
  cleanupDirectory?: string;
}): Promise<{ errors: unknown[]; outcome: 'legacy' | 'new' }> {
  const errors: unknown[] = [];
  const backups: Array<{ plan: PreparedProject; backupPath: string }> = [];
  for (const plan of plans) {
    try {
      const backupPath = await backupPathForRestore({
        plan,
        cleanupDirectory,
      });
      if (!backupPath) {
        throw new Error(
          `Missing Agent Memory rollback backup for ${plan.projectDirectory}`,
        );
      }
      await assertSafeAgentMemoryTree(backupPath);
      backups.push({ plan, backupPath });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    errors.push(...(await ensureVerifiedNewActive(plans)));
    return { errors, outcome: 'new' };
  }

  const displaced: Array<{ plan: PreparedProject; sourcePath: string }> = [];
  for (const { plan } of backups) {
    try {
      const displacedPath = failedActivePath(plan);
      if (await pathExists(displacedPath)) {
        throw new Error(
          `Unexpected displaced Agent Memory tree: ${displacedPath}`,
        );
      }
      const hasActiveProject = await pathExists(plan.projectDirectory);
      const sourcePath = hasActiveProject
        ? plan.projectDirectory
        : plan.stagingPath;
      if (hasActiveProject) {
        await assertSafeAgentMemoryTree(sourcePath);
      } else {
        await verifyProject({
          projectDirectory: sourcePath,
          expectedCount: plan.expectedCount,
          expectedDigest: plan.expectedDigest,
        });
      }
      await fs.rename(sourcePath, displacedPath);
      displaced.push({ plan, sourcePath });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    for (const { plan, sourcePath } of displaced.reverse()) {
      try {
        await fs.rename(failedActivePath(plan), sourcePath);
      } catch (error) {
        errors.push(error);
      }
    }
    errors.push(...(await ensureVerifiedNewActive(plans)));
    return { errors, outcome: 'new' };
  }

  const restored: Array<{ plan: PreparedProject; backupPath: string }> = [];
  for (const entry of backups) {
    try {
      await fs.rename(entry.backupPath, entry.plan.projectDirectory);
      restored.push(entry);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    for (const { plan, backupPath } of restored.reverse()) {
      try {
        await fs.rename(plan.projectDirectory, backupPath);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const { plan } of displaced.reverse()) {
      try {
        if (await pathExists(plan.projectDirectory)) {
          throw new Error(
            `Cannot restore active Agent Memory tree because destination exists: ${plan.projectDirectory}`,
          );
        }
        await fs.rename(failedActivePath(plan), plan.projectDirectory);
      } catch (error) {
        errors.push(error);
      }
    }
    errors.push(...(await ensureVerifiedNewActive(plans)));
    return { errors, outcome: 'new' };
  }

  const cleanupResults = await Promise.allSettled(
    displaced.map(({ plan }) =>
      fs.rm(failedActivePath(plan), { recursive: true, force: true }),
    ),
  );
  errors.push(
    ...cleanupResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ),
  );
  return { errors, outcome: 'legacy' };
}

async function activateRemainingProjects(
  plans: PreparedProject[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const plan of plans) {
    try {
      if (!(await pathExists(plan.backupPath))) {
        await assertSafeAgentMemoryTree(plan.projectDirectory);
        await fs.rename(plan.projectDirectory, plan.backupPath);
      }
      if (!(await pathExists(plan.projectDirectory))) {
        await fs.rename(plan.stagingPath, plan.projectDirectory);
      }
      await verifyProject({
        projectDirectory: plan.projectDirectory,
        expectedCount: plan.expectedCount,
        expectedDigest: plan.expectedDigest,
      });
    } catch (error) {
      errors.push(error);
      if (
        !(await pathExists(plan.projectDirectory)) &&
        (await pathExists(plan.backupPath))
      ) {
        try {
          await fs.rename(plan.backupPath, plan.projectDirectory);
        } catch (legacyRestoreError) {
          errors.push(legacyRestoreError);
        }
      }
    }
  }
  return errors;
}

async function removeStagingTrees(plans: PreparedProject[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    plans.map((plan) =>
      fs.rm(plan.stagingPath, { recursive: true, force: true }),
    ),
  );
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
}

async function removeFailedActiveTrees(
  plans: PreparedProject[],
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    plans.map((plan) =>
      fs.rm(failedActivePath(plan), { recursive: true, force: true }),
    ),
  );
  return results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
}

async function cleanupLegacyBackups({
  plans,
  cleanupDirectory,
}: {
  plans: PreparedProject[];
  cleanupDirectory: string;
}): Promise<void> {
  await fs.mkdir(cleanupDirectory, { mode: 0o700 });
  for (const plan of plans) {
    await fs.rename(
      plan.backupPath,
      path.join(cleanupDirectory, path.basename(plan.backupPath)),
    );
  }
  await fs.rm(cleanupDirectory, { recursive: true });
}

interface StartupRecoveryProject {
  projectId: string;
  projectDirectory: string;
  stagingPath: string;
  backupPath: string;
  failedActivePath: string;
  cleanupBackupPath: string;
}

function startupRecoveryProject({
  projectId,
  homeDirectory,
  cleanupDirectory,
}: {
  projectId: string;
  homeDirectory: string;
  cleanupDirectory: string;
}): StartupRecoveryProject {
  const projectDirectory = getAgentMemoryProjectPaths(
    projectId,
    homeDirectory,
  ).directory;
  const projectKey = getAgentMemoryProjectKey(projectId);
  const backupPath = path.join(
    path.dirname(projectDirectory),
    `${BACKUP_PREFIX}${projectKey}`,
  );
  return {
    projectId,
    projectDirectory,
    stagingPath: path.join(
      path.dirname(projectDirectory),
      `${STAGING_PREFIX}${projectKey}`,
    ),
    backupPath,
    failedActivePath: failedActivePath({ projectDirectory }),
    cleanupBackupPath: path.join(
      cleanupDirectory,
      path.basename(backupPath),
    ),
  };
}

type StartupActiveState = 'new' | 'legacy' | 'missing';
type StartupResidueState =
  | { state: 'absent' }
  | { state: 'invalid-regular' }
  | { state: 'unsafe'; error: unknown }
  | { state: 'verified'; digest?: string };
type StartupResidueRole =
  | 'staging'
  | 'failedActive'
  | 'backup'
  | 'cleanupBackup';
type StartupResidues = Record<StartupResidueRole, StartupResidueState>;

async function verifyLegacyProject({
  project,
  projectDirectory,
}: {
  project: StartupRecoveryProject;
  projectDirectory: string;
}): Promise<void> {
  await assertSafeAgentMemoryTree(projectDirectory);
  const legacyPaths = [
    OLD_REVIEWS_DIRECTORY,
    'user-reviews-state.json',
    'user-preferences.md',
    'user-preferences-history',
  ];
  if (
    !(
      await Promise.all(
        legacyPaths.map((relativePath) =>
          pathExists(path.join(projectDirectory, relativePath)),
        ),
      )
    ).some(Boolean)
  ) {
    throw new Error(`Invalid Agent Memory recovery tree: ${projectDirectory}`);
  }
  await readConvertedEvents({
    projectId: project.projectId,
    projectDirectory,
  });
}

async function classifyStartupActive(
  project: StartupRecoveryProject,
): Promise<StartupActiveState> {
  if (!(await pathExists(project.projectDirectory))) return 'missing';
  await assertSafeAgentMemoryTree(project.projectDirectory);
  try {
    await verifyProject({ projectDirectory: project.projectDirectory });
    return 'new';
  } catch {
    await verifyLegacyProject({
      project,
      projectDirectory: project.projectDirectory,
    });
    return 'legacy';
  }
}

async function classifyStartupResidue({
  residuePath,
  verify,
}: {
  residuePath: string;
  verify: () => Promise<string | void>;
}): Promise<StartupResidueState> {
  if (!(await pathExists(residuePath))) return { state: 'absent' };
  try {
    await assertSafeAgentMemoryTree(residuePath);
  } catch (error) {
    return { state: 'unsafe', error };
  }
  try {
    const digest = await verify();
    return digest === undefined
      ? { state: 'verified' }
      : { state: 'verified', digest };
  } catch (error) {
    if (error instanceof UnsafeAgentMemoryPathError) {
      return { state: 'unsafe', error };
    }
    // Recheck after content validation so path replacement cannot turn an
    // invalid regular residue into automatically discarded unsafe data.
    try {
      await assertSafeAgentMemoryTree(residuePath);
    } catch (unsafeError) {
      return { state: 'unsafe', error: unsafeError };
    }
    return { state: 'invalid-regular' };
  }
}

function residuePath(
  project: StartupRecoveryProject,
  role: StartupResidueRole,
): string {
  switch (role) {
    case 'staging':
      return project.stagingPath;
    case 'failedActive':
      return project.failedActivePath;
    case 'backup':
      return project.backupPath;
    case 'cleanupBackup':
      return project.cleanupBackupPath;
  }
}

async function finishUniformNewRecovery({
  projects,
  cleanupDirectory,
}: {
  projects: StartupRecoveryProject[];
  cleanupDirectory: string;
}): Promise<void> {
  const errors: unknown[] = [];
  const verificationResults = await Promise.allSettled(
    projects.map((project) =>
      verifyProject({ projectDirectory: project.projectDirectory }),
    ),
  );
  errors.push(
    ...verificationResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ),
  );
  if (errors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory startup convergence verification failed',
      cause: errors[0],
      rollbackErrors: errors.slice(1),
    });
  }

  const candidateCleanupResults = await Promise.allSettled(
    projects.flatMap((project) =>
      [project.failedActivePath, project.stagingPath].map((candidatePath) =>
        fs.rm(candidatePath, { recursive: true, force: true }),
      ),
    ),
  );
  errors.push(
    ...candidateCleanupResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ),
  );
  if (errors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory startup candidate cleanup failed',
      cause: errors[0],
      rollbackErrors: errors.slice(1),
    });
  }

  if (!(await pathExists(cleanupDirectory))) {
    await fs.mkdir(cleanupDirectory, { mode: 0o700 });
  }
  const backupMoveResults = await Promise.allSettled(
    projects.map(async (project) => {
      if (!(await pathExists(project.backupPath))) return;
      await fs.rename(project.backupPath, project.cleanupBackupPath);
    }),
  );
  errors.push(
    ...backupMoveResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ),
  );
  if (errors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory startup quarantine failed',
      cause: errors[0],
      rollbackErrors: errors.slice(1),
    });
  }
  await fs.rm(cleanupDirectory, { recursive: true });
}

async function recoverInterruptedMigration({
  projects,
  homeDirectory,
}: {
  projects: ProjectRecord[];
  homeDirectory: string;
}): Promise<void> {
  const projectsDirectory = getAgentMemoryProjectsDir(homeDirectory);
  const cleanupDirectory = path.join(
    projectsDirectory,
    CLEANUP_DIRECTORY_NAME,
  );
  const recoveryProjects = projects.map((project) =>
    startupRecoveryProject({
      projectId: project.id,
      homeDirectory,
      cleanupDirectory,
    }),
  );
  const cleanupExists = await pathExists(cleanupDirectory);
  const residueChecks = await Promise.all(
    recoveryProjects.flatMap((project) => [
      pathExists(project.stagingPath),
      pathExists(project.backupPath),
      pathExists(project.failedActivePath),
    ]),
  );
  if (!cleanupExists && !residueChecks.some(Boolean)) return;

  if (cleanupExists) {
    const cleanupStat = await fs.lstat(cleanupDirectory);
    if (cleanupStat.isSymbolicLink() || !cleanupStat.isDirectory()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe agent memory path: ${cleanupDirectory}`,
      );
    }
  }
  const allowedCleanupEntries = new Set(
    recoveryProjects.map((project) => path.basename(project.backupPath)),
  );
  const cleanupEntries = cleanupExists ? await fs.readdir(cleanupDirectory) : [];
  const unknownCleanupEntries = cleanupEntries.filter(
    (entry) => !allowedCleanupEntries.has(entry),
  );
  if (unknownCleanupEntries.length > 0) {
    throw new Error(
      `Unsafe Agent Memory cleanup entries: ${unknownCleanupEntries.join(', ')}`,
    );
  }

  const relevantProjects: StartupRecoveryProject[] = [];
  for (const project of recoveryProjects) {
    if (
      (
        await Promise.all([
          pathExists(project.projectDirectory),
          pathExists(project.stagingPath),
          pathExists(project.backupPath),
          pathExists(project.failedActivePath),
          pathExists(project.cleanupBackupPath),
        ])
      ).some(Boolean)
    ) {
      relevantProjects.push(project);
    }
  }

  const recoveryErrors: unknown[] = [];
  const activeStates = new Map<StartupRecoveryProject, StartupActiveState>();
  const residueStates = new Map<StartupRecoveryProject, StartupResidues>();
  for (const project of relevantProjects) {
    try {
      activeStates.set(project, await classifyStartupActive(project));
    } catch (error) {
      recoveryErrors.push(error);
    }
    const residues: StartupResidues = {
      staging: await classifyStartupResidue({
        residuePath: project.stagingPath,
        verify: () =>
          verifyProject({ projectDirectory: project.stagingPath }),
      }),
      failedActive: await classifyStartupResidue({
        residuePath: project.failedActivePath,
        verify: () =>
          verifyProject({ projectDirectory: project.failedActivePath }),
      }),
      backup: await classifyStartupResidue({
        residuePath: project.backupPath,
        verify: () =>
          verifyLegacyProject({
            project,
            projectDirectory: project.backupPath,
          }),
      }),
      cleanupBackup: await classifyStartupResidue({
        residuePath: project.cleanupBackupPath,
        verify: () =>
          verifyLegacyProject({
            project,
            projectDirectory: project.cleanupBackupPath,
          }),
      }),
    };
    residueStates.set(project, residues);
    for (const residue of Object.values(residues)) {
      if (residue.state === 'unsafe') recoveryErrors.push(residue.error);
    }
    if (
      residues.staging.state === 'verified' &&
      residues.failedActive.state === 'verified' &&
      residues.staging.digest !== residues.failedActive.digest
    ) {
      recoveryErrors.push(
        new Error(
          `Conflicting verified Agent Memory recovery candidates for ${project.projectDirectory}`,
        ),
      );
    }
    if (
      residues.backup.state === 'verified' &&
      residues.cleanupBackup.state === 'verified'
    ) {
      recoveryErrors.push(
        new Error(
          `Conflicting Agent Memory rollback backups for ${project.projectDirectory}`,
        ),
      );
    }
    if (
      activeStates.get(project) === 'missing' &&
      Object.values(residues).some(
        (residue) => residue.state === 'invalid-regular',
      )
    ) {
      recoveryErrors.push(
        new Error(
          `Invalid regular Agent Memory residue requires a verified active tree: ${project.projectDirectory}`,
        ),
      );
    }
  }

  if (recoveryErrors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory startup recovery preflight failed',
      cause: recoveryErrors[0],
      rollbackErrors: recoveryErrors.slice(1),
    });
  }

  const invalidResiduePaths = relevantProjects.flatMap((project) => {
    const residues = residueStates.get(project);
    if (!residues) return [];
    return (Object.entries(residues) as Array<
      [StartupResidueRole, StartupResidueState]
    >).flatMap(([role, residue]) =>
      residue.state === 'invalid-regular' ? [residuePath(project, role)] : [],
    );
  });
  const invalidCleanupResults = await Promise.allSettled(
    invalidResiduePaths.map((invalidPath) =>
      fs.rm(invalidPath, { recursive: true }),
    ),
  );
  const invalidCleanupErrors = invalidCleanupResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (invalidCleanupErrors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory invalid residue cleanup failed',
      cause: invalidCleanupErrors[0],
      rollbackErrors: invalidCleanupErrors.slice(1),
    });
  }

  const candidates = new Map<StartupRecoveryProject, string | null>();
  for (const project of relevantProjects) {
    const residues = residueStates.get(project);
    candidates.set(
      project,
      residues?.failedActive.state === 'verified'
        ? project.failedActivePath
        : residues?.staging.state === 'verified'
          ? project.stagingPath
          : null,
    );
  }

  for (const project of relevantProjects) {
    if (activeStates.get(project) !== 'missing' || candidates.get(project)) {
      continue;
    }
    const residues = residueStates.get(project);
    const backupRole =
      residues?.cleanupBackup.state === 'verified'
        ? 'cleanupBackup'
        : residues?.backup.state === 'verified'
          ? 'backup'
          : null;
    if (!backupRole) {
      recoveryErrors.push(
        new Error(
          `Missing active and recoverable Agent Memory tree: ${project.projectDirectory}`,
        ),
      );
    }
  }
  if (recoveryErrors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory startup recovery source preflight failed',
      cause: recoveryErrors[0],
      rollbackErrors: recoveryErrors.slice(1),
    });
  }
  for (const project of relevantProjects) {
    if (activeStates.get(project) !== 'missing' || candidates.get(project)) {
      continue;
    }
    const residues = residueStates.get(project);
    const backupRole: StartupResidueRole =
      residues?.cleanupBackup.state === 'verified'
        ? 'cleanupBackup'
        : 'backup';
    await fs.rename(residuePath(project, backupRole), project.projectDirectory);
    activeStates.set(project, 'legacy');
    if (residues) residues[backupRole] = { state: 'absent' };
  }

  const hasNewActive = [...activeStates.values()].includes('new');
  const hasMissingActive = [...activeStates.values()].includes('missing');
  const allActiveLegacy = [...activeStates.values()].every(
    (state) => state === 'legacy',
  );
  const hasRollbackResidue = relevantProjects.some((project) => {
    const residues = residueStates.get(project);
    return (
      residues?.failedActive.state === 'verified' ||
      residues?.backup.state === 'verified' ||
      residues?.cleanupBackup.state === 'verified'
    );
  });
  if (!hasMissingActive && !hasRollbackResidue) {
    if (cleanupExists) await fs.rm(cleanupDirectory, { recursive: true });
    return;
  }
  if (!hasNewActive && !hasMissingActive) {
    if (!allActiveLegacy) {
      throw new Error(
        'Agent Memory startup recovery cannot determine a uniform safe state',
      );
    }
    if (
      relevantProjects.some(
        (project) =>
          residueStates.get(project)?.cleanupBackup.state === 'verified',
      )
    ) {
      throw new Error(
        'Agent Memory startup recovery found quarantined backups before activation',
      );
    }
    if (cleanupExists) await fs.rm(cleanupDirectory, { recursive: true });
    return;
  }

  for (const project of relevantProjects) {
    const state = activeStates.get(project);
    if (state !== 'new' && !candidates.get(project)) {
      recoveryErrors.push(
        new Error(
          `Missing verified new recovery candidate for ${project.projectDirectory}`,
        ),
      );
    }
    if (
      state === 'legacy' &&
      (residueStates.get(project)?.backup.state === 'verified' ||
        residueStates.get(project)?.cleanupBackup.state === 'verified')
    ) {
      recoveryErrors.push(
        new Error(
          `Cannot preserve duplicate legacy active tree for ${project.projectDirectory}`,
        ),
      );
    }
  }
  if (recoveryErrors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory startup convergence preflight failed',
      cause: recoveryErrors[0],
      rollbackErrors: recoveryErrors.slice(1),
    });
  }

  const convergenceResults = await Promise.allSettled(
    relevantProjects.map(async (project) => {
      const state = activeStates.get(project);
      if (state === 'new') return;
      if (state === 'legacy') {
        await fs.rename(project.projectDirectory, project.backupPath);
      }
      const candidate = candidates.get(project);
      if (!candidate) {
        throw new Error(
          `Missing verified new recovery candidate for ${project.projectDirectory}`,
        );
      }
      await fs.rename(candidate, project.projectDirectory);
      await verifyProject({ projectDirectory: project.projectDirectory });
    }),
  );
  recoveryErrors.push(
    ...convergenceResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ),
  );
  if (recoveryErrors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory startup convergence failed',
      cause: recoveryErrors[0],
      rollbackErrors: recoveryErrors.slice(1),
    });
  }
  await finishUniformNewRecovery({
    projects: relevantProjects,
    cleanupDirectory,
  });
}

async function prepareProject(
  project: ProjectRecord,
  homeDirectory: string,
): Promise<PreparedProject | null> {
  const projectDirectory = getAgentMemoryProjectPaths(
    project.id,
    homeDirectory,
  ).directory;
  const projectKey = getAgentMemoryProjectKey(project.id);
  const parentDirectory = path.dirname(projectDirectory);
  const stagingPath = path.join(parentDirectory, `${STAGING_PREFIX}${projectKey}`);
  const backupPath = path.join(parentDirectory, `${BACKUP_PREFIX}${projectKey}`);

  if (await pathExists(backupPath)) {
    await recoverSwap({ projectDirectory, stagingPath, backupPath });
  } else {
    await fs.rm(stagingPath, { recursive: true, force: true });
  }
  if (!(await pathExists(projectDirectory))) return null;
  await assertSafeAgentMemoryTree(projectDirectory);
  if (await isActivatedAgentMemoryProject(projectDirectory)) return null;

  try {
    const events = await readConvertedEvents({
      projectId: project.id,
      projectDirectory,
    });
    const expectedDigest = await writeStagedProject({
      project,
      stagingPath,
      events,
    });
    await verifyProject({
      projectDirectory: stagingPath,
      expectedCount: events.length,
      expectedDigest,
    });
    return {
      projectDirectory,
      stagingPath,
      backupPath,
      expectedCount: events.length,
      expectedDigest,
    };
  } catch (error) {
    await fs.rm(stagingPath, { recursive: true, force: true });
    throw error;
  }
}

async function activateProjects(plans: PreparedProject[]): Promise<void> {
  if (plans.length === 0) return;
  const backedUp: PreparedProject[] = [];
  try {
    for (const plan of plans) {
      await fs.rename(plan.projectDirectory, plan.backupPath);
      backedUp.push(plan);
      await fs.rename(plan.stagingPath, plan.projectDirectory);
      await verifyProject({
        projectDirectory: plan.projectDirectory,
        expectedCount: plan.expectedCount,
        expectedDigest: plan.expectedDigest,
      });
    }
  } catch (error) {
    const rollback = await restoreProjectsConvergently({
      plans: backedUp,
    });
    const rollbackErrors = [...rollback.errors];
    if (rollback.outcome === 'new') {
      rollbackErrors.push(
        ...(await activateRemainingProjects(
          plans.filter((plan) => !backedUp.includes(plan)),
        )),
      );
    }
    rollbackErrors.push(...(await removeStagingTrees(plans)));
    throw migrationFailure({
      context: 'Agent Memory activation failed',
      cause: error,
      rollbackErrors,
    });
  }

  const stagingErrors = await removeStagingTrees(plans);
  if (stagingErrors.length > 0) {
    const rollback = await restoreProjectsConvergently({ plans });
    throw migrationFailure({
      context: 'Agent Memory staging cleanup failed',
      cause: stagingErrors[0],
      rollbackErrors: [...stagingErrors.slice(1), ...rollback.errors],
    });
  }

  const failedActiveErrors = await removeFailedActiveTrees(plans);
  if (failedActiveErrors.length > 0) {
    throw migrationFailure({
      context: 'Agent Memory recovery candidate cleanup failed',
      cause: failedActiveErrors[0],
      rollbackErrors: failedActiveErrors.slice(1),
    });
  }

  const cleanupDirectory = cleanupDirectoryForPlans(plans);
  try {
    await cleanupLegacyBackups({ plans, cleanupDirectory });
  } catch (error) {
    const rollback = await restoreProjectsConvergently({
      plans,
      cleanupDirectory,
    });
    const rollbackErrors = rollback.errors;
    if (rollbackErrors.length === 0) {
      try {
        await fs.rm(cleanupDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        rollbackErrors.push(cleanupError);
      }
    }
    throw migrationFailure({
      context: 'Agent Memory legacy cleanup failed',
      cause: error,
      rollbackErrors,
    });
  }
}

export async function up(
  db: Kysely<unknown>,
  homeDirectory = os.homedir(),
): Promise<void> {
  await db.schema
    .createIndex(AGENT_MESSAGE_LATEST_RESULT_INDEX)
    .ifNotExists()
    .on('agent_messages')
    .columns(['stepId', 'type', 'messageIndex desc'])
    .execute();
  const databaseProjects = await (
    db as Kysely<{ projects: ProjectRecord }>
  )
    .selectFrom('projects')
    .select(['id', 'name', 'path'])
    .execute();
  await ensureAgentMemoryProjectsDirectory(homeDirectory);
  const retained = await discoverRetainedProjects(homeDirectory);
  const projects = combineProjects({
    databaseProjects,
    retainedProjects: retained.projects,
  });
  warnAboutOrphanedResidue({
    residueEntries: retained.residueEntries,
    projects,
  });
  await recoverInterruptedMigration({ projects, homeDirectory });
  const plans: PreparedProject[] = [];
  try {
    for (const project of projects) {
      const plan = await prepareProject(project, homeDirectory);
      if (plan) plans.push(plan);
    }
  } catch (error) {
    await Promise.all(
      plans.map((plan) =>
        fs.rm(plan.stagingPath, { recursive: true, force: true }),
      ),
    );
    throw error;
  }
  await activateProjects(plans);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // File migration cannot be reversed without restoring discarded legacy data.
  await db.schema
    .dropIndex(AGENT_MESSAGE_LATEST_RESULT_INDEX)
    .ifExists()
    .execute();
}
