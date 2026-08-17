import * as fs from 'fs/promises';
import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

import {
  AGENT_MEMORY_MAX_EVENT_TEXT_CHARS,
  AGENT_MEMORY_SCHEMA_VERSION,
  type AgentMemoryEvent,
  type AgentMemoryEventRange,
  type AgentMemoryExtractionRun,
  agentMemoryExtractionRunSchema,
  type AgentMemoryExtractionState,
  type AgentMemoryPage,
  normalizeAgentMemoryEvent,
} from '@shared/agent-memory-types';

import { redactAgentMemoryValue } from './agent-memory-redaction';

const DIRECT_PROJECT_ID_PATTERN = /^[a-z0-9_-]{1,128}$/;
const RESERVED_FILE_NAME_PATTERN = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/;
const EVENT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const RUN_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/;
const RUN_INDEX_FILE_NAME = 'index.v1';
const RUN_INDEX_SCHEMA_VERSION = 3 as const;
const RUN_INDEX_REBUILD_CONCURRENCY = 8;
// Derived indexes are disposable and always rebuild from canonical event JSONL.
const EVENT_INDEX_SCHEMA_VERSION = 2 as const;
const projectOperationTails = new Map<string, Promise<void>>();
const projectExtractionTails = new Map<string, Promise<void>>();
const runIndexOperationTails = new Map<string, Promise<void>>();
let globalOperationTail: Promise<void> = Promise.resolve();

interface EventIndexRecord {
  offset: number;
  length: number;
  sourceHash: string | null;
  id: string | null;
  createdAt: string | null;
  supported: boolean;
}

interface EventDayIndex {
  schemaVersion: typeof EVENT_INDEX_SCHEMA_VERSION;
  fileName: string;
  fileSize: number;
  records: EventIndexRecord[];
}

interface EventIndexManifest {
  schemaVersion: typeof EVENT_INDEX_SCHEMA_VERSION;
  files: Record<
    string,
    {
      size: number;
      mtimeMs: number;
      supportedCount: number;
      sourceShards: string[];
      object: string;
      digest: string;
    }
  >;
  sourceShards: Record<string, { object: string; digest: string }>;
}

interface EventSourceIndex {
  schemaVersion: typeof EVENT_INDEX_SCHEMA_VERSION;
  shard: string;
  entries: Record<string, string[]>;
}

export type AgentMemoryRunIndexEntry = {
  fileName: string;
  id: string;
  sequence: number;
  scope: 'project' | 'global';
  projectId?: string;
  status: AgentMemoryExtractionRun['status'];
  startedAt: string;
  completedAt: string | null;
};

interface AgentMemoryRunIndex {
  schemaVersion: typeof RUN_INDEX_SCHEMA_VERSION;
  legacyMigrationComplete: true;
  recordCount: number;
  nextSequence: number;
  recordsFingerprint: {
    mtimeNs: string;
    ctimeNs: string;
    size: string;
  };
  entries: AgentMemoryRunIndexEntry[];
}

export class UnsafeAgentMemoryPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeAgentMemoryPathError';
  }
}

export function isUnsafeAgentMemoryPathError(
  error: unknown,
): error is UnsafeAgentMemoryPathError {
  return error instanceof UnsafeAgentMemoryPathError;
}

export function getAgentMemoryProjectKey(projectId: string): string {
  if (
    DIRECT_PROJECT_ID_PATTERN.test(projectId) &&
    !RESERVED_FILE_NAME_PATTERN.test(projectId)
  ) {
    return projectId;
  }
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 32);
  return `.hashed-${hash}`;
}

export function getAgentMemoryRootDir(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.jean-claude', 'memory');
}

export function getAgentMemoryProjectsDir(homeDirectory = os.homedir()): string {
  return path.join(getAgentMemoryRootDir(homeDirectory), 'projects');
}

export function getProjectAgentMemoryDir(
  projectId: string,
  homeDirectory = os.homedir(),
): string {
  return path.join(
    getAgentMemoryProjectsDir(homeDirectory),
    getAgentMemoryProjectKey(projectId),
  );
}

export function getAgentMemoryGlobalPaths(homeDirectory = os.homedir()): {
  directory: string;
  profileJson: string;
  profileMarkdown: string;
  runsDirectory: string;
} {
  const directory = path.join(getAgentMemoryRootDir(homeDirectory), 'global');
  return {
    directory,
    profileJson: path.join(directory, 'profile.json'),
    profileMarkdown: path.join(directory, 'profile.md'),
    runsDirectory: path.join(directory, 'runs'),
  };
}

export function getAgentMemoryProjectPaths(
  projectId: string,
  homeDirectory = os.homedir(),
): {
  directory: string;
  metadataJson: string;
  eventsDirectory: string;
  itemsJson: string;
  memoryMarkdown: string;
    extractionStateJson: string;
    publicationJournalJson: string;
    runsDirectory: string;
} {
  const directory = getProjectAgentMemoryDir(projectId, homeDirectory);
  return {
    directory,
    metadataJson: path.join(directory, 'project.json'),
    eventsDirectory: path.join(directory, 'events'),
    itemsJson: path.join(directory, 'memory-items.json'),
    memoryMarkdown: path.join(directory, 'project-memory.md'),
    extractionStateJson: path.join(directory, 'extraction-state.json'),
    publicationJournalJson: path.join(directory, 'publication-journal.json'),
    runsDirectory: path.join(directory, 'runs'),
  };
}

async function ensureRealDirectory(directoryPath: string): Promise<void> {
  try {
    await fs.mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeAgentMemoryPathError(
      `Unsafe agent memory directory: ${directoryPath}`,
    );
  }
  if ((stat.mode & 0o777) !== 0o700) await fs.chmod(directoryPath, 0o700);
}

async function assertRealDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe agent memory directory: ${directoryPath}`,
      );
    }
    if ((stat.mode & 0o777) !== 0o700) await fs.chmod(directoryPath, 0o700);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertRealFileIfPresent(filePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe agent memory file: ${filePath}`,
      );
    }
    if ((stat.mode & 0o777) !== 0o600) await fs.chmod(filePath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function assertContainedPath(rootDirectory: string, filePath: string): void {
  const relative = path.relative(path.resolve(rootDirectory), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new UnsafeAgentMemoryPathError(
      `Unsafe agent memory destination: ${filePath}`,
    );
  }
}

export async function assertSafeAgentMemoryPath({
  homeDirectory = os.homedir(),
  targetPath,
  type,
}: {
  homeDirectory?: string;
  targetPath: string;
  type: 'directory' | 'file';
}): Promise<void> {
  const resolvedHome = path.resolve(homeDirectory);
  const resolvedTarget = path.resolve(targetPath);
  const managedRoot = path.resolve(getAgentMemoryRootDir(homeDirectory));
  const relativeToRoot = path.relative(managedRoot, resolvedTarget);
  if (
    relativeToRoot.startsWith('..') ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new UnsafeAgentMemoryPathError(
      `Unsafe agent memory path: ${targetPath}`,
    );
  }
  const relative = path.relative(resolvedHome, resolvedTarget);
  const segments = relative.split(path.sep).filter(Boolean);
  let current = resolvedHome;
  const paths = [resolvedHome, ...segments.map((segment) => {
    current = path.join(current, segment);
    return current;
  })];
  for (const [index, candidate] of paths.entries()) {
    const stat = await fs.lstat(candidate);
    const isLeaf = index === paths.length - 1;
    if (stat.isSymbolicLink()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe symlink in agent memory: ${candidate}`,
      );
    }
    if (
      (isLeaf && type === 'file' && !stat.isFile()) ||
      ((!isLeaf || type === 'directory') && !stat.isDirectory())
    ) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe agent memory path: ${candidate}`,
      );
    }
  }
}

export async function readAgentMemoryJson({
  homeDirectory = os.homedir(),
  filePath,
}: {
  homeDirectory?: string;
  filePath: string;
}): Promise<unknown> {
  await assertSafeAgentMemoryPath({
    homeDirectory,
    targetPath: filePath,
    type: 'file',
  });
  const content = await readFileNoFollow(filePath, 'utf-8');
  return JSON.parse(content as string) as unknown;
}

async function openFileNoFollow(filePath: string) {
  const noFollow = nodeFs.constants.O_NOFOLLOW ?? 0;
  return fs.open(filePath, nodeFs.constants.O_RDONLY | noFollow);
}

async function readFileNoFollow(
  filePath: string,
  encoding?: BufferEncoding,
): Promise<string | Buffer> {
  const handle = await openFileNoFollow(filePath);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe agent memory file: ${filePath}`,
      );
    }
    return encoding ? handle.readFile(encoding) : handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readAgentMemoryDirectoryNames({
  homeDirectory = os.homedir(),
  directoryPath,
}: {
  homeDirectory?: string;
  directoryPath: string;
}): Promise<string[]> {
  await assertSafeAgentMemoryPath({
    homeDirectory,
    targetPath: directoryPath,
    type: 'directory',
  });
  return fs.readdir(directoryPath);
}

function runIndexEntry({
  fileName,
  run,
}: {
  fileName: string;
  run: AgentMemoryExtractionRun;
}): AgentMemoryRunIndexEntry {
  if (run.sequence === undefined) {
    throw new Error(`Agent Memory run is missing sequence: ${run.id}`);
  }
  return {
    fileName,
    id: run.id,
    sequence: run.sequence,
    scope: run.scope,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function sortRunIndexEntries(
  entries: AgentMemoryRunIndexEntry[],
): AgentMemoryRunIndexEntry[] {
  return entries.sort(
    (left, right) =>
      right.sequence - left.sequence ||
      right.id.localeCompare(left.id),
  );
}

function isRunIndexEntry(value: unknown): value is AgentMemoryRunIndexEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.fileName === 'string' &&
    RUN_FILE_PATTERN.test(entry.fileName) &&
    typeof entry.id === 'string' &&
    typeof entry.sequence === 'number' &&
    Number.isSafeInteger(entry.sequence) &&
    entry.sequence > 0 &&
    (entry.scope === 'project' || entry.scope === 'global') &&
    (entry.projectId === undefined || typeof entry.projectId === 'string') &&
    (entry.status === 'running' ||
      entry.status === 'succeeded' ||
      entry.status === 'failed') &&
    typeof entry.startedAt === 'string' &&
    (entry.completedAt === null || typeof entry.completedAt === 'string')
  );
}

function parseRunIndex(value: unknown): AgentMemoryRunIndex | null {
  if (!value || typeof value !== 'object') return null;
  const index = value as Record<string, unknown>;
  if (
    index.schemaVersion !== RUN_INDEX_SCHEMA_VERSION ||
    index.legacyMigrationComplete !== true ||
    typeof index.recordCount !== 'number' ||
    !Number.isSafeInteger(index.recordCount) ||
    index.recordCount < 0 ||
    typeof index.nextSequence !== 'number' ||
    !Number.isSafeInteger(index.nextSequence) ||
    index.nextSequence < 1 ||
    !index.recordsFingerprint ||
    typeof index.recordsFingerprint !== 'object' ||
    typeof (index.recordsFingerprint as Record<string, unknown>).mtimeNs !==
      'string' ||
    typeof (index.recordsFingerprint as Record<string, unknown>).ctimeNs !==
      'string' ||
    typeof (index.recordsFingerprint as Record<string, unknown>).size !==
      'string' ||
    !Array.isArray(index.entries) ||
    !index.entries.every(isRunIndexEntry) ||
    new Set(index.entries.map((entry) => entry.fileName)).size !==
      index.entries.length ||
    new Set(index.entries.map((entry) => entry.sequence)).size !==
      index.entries.length ||
    index.entries.some(
      (entry) => entry.sequence >= (index.nextSequence as number),
    ) ||
    index.entries.length > index.recordCount
  ) {
    return null;
  }
  return {
    schemaVersion: RUN_INDEX_SCHEMA_VERSION,
    legacyMigrationComplete: true,
    recordCount: index.recordCount,
    nextSequence: index.nextSequence,
    recordsFingerprint: index.recordsFingerprint as AgentMemoryRunIndex['recordsFingerprint'],
    entries: sortRunIndexEntries([...index.entries]),
  };
}

function getRunStore({
  scope,
  projectId,
  homeDirectory,
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory: string;
}) {
  if (scope === 'project') {
    if (!projectId) throw new Error('Project run index requires project ID');
    const paths = getAgentMemoryProjectPaths(projectId, homeDirectory);
    return {
      rootDirectory: paths.directory,
      runsDirectory: paths.runsDirectory,
      recordsDirectory: path.join(paths.runsDirectory, 'records'),
      indexFile: path.join(paths.runsDirectory, RUN_INDEX_FILE_NAME),
    };
  }
  const paths = getAgentMemoryGlobalPaths(homeDirectory);
  return {
    rootDirectory: paths.directory,
    runsDirectory: paths.runsDirectory,
    recordsDirectory: path.join(paths.runsDirectory, 'records'),
    indexFile: path.join(paths.runsDirectory, RUN_INDEX_FILE_NAME),
  };
}

function runIndexKey({
  scope,
  projectId,
  homeDirectory,
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory: string;
}): string {
  return `${path.resolve(homeDirectory)}:${scope}:${projectId ?? ''}`;
}

function withRunIndexLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = runIndexOperationTails.get(key) ?? Promise.resolve();
  let currentTail: Promise<void>;
  return withQueuedLock({
    previous,
    setTail: (tail) => {
      currentTail = tail;
      runIndexOperationTails.set(key, tail);
      void tail.finally(() => {
        if (runIndexOperationTails.get(key) === currentTail) {
          runIndexOperationTails.delete(key);
        }
      });
    },
    operation,
  });
}

async function recordsFingerprint(
  recordsDirectory: string,
): Promise<AgentMemoryRunIndex['recordsFingerprint']> {
  const stat = await fs.stat(recordsDirectory, { bigint: true });
  return {
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    size: stat.size.toString(),
  };
}

function sameRecordsFingerprint(
  left: AgentMemoryRunIndex['recordsFingerprint'],
  right: AgentMemoryRunIndex['recordsFingerprint'],
): boolean {
  return (
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.size === right.size
  );
}

async function ensureRunRecordsDirectory(
  store: ReturnType<typeof getRunStore>,
  homeDirectory: string,
): Promise<boolean> {
  try {
    await assertSafeAgentMemoryPath({
      homeDirectory,
      targetPath: store.runsDirectory,
      type: 'directory',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await ensureRealDirectory(store.recordsDirectory);
  return true;
}

async function migrateLegacyRunFiles({
  store,
  homeDirectory,
}: {
  store: ReturnType<typeof getRunStore>;
  homeDirectory: string;
}): Promise<void> {
  const legacyNames = (
    await readAgentMemoryDirectoryNames({
      homeDirectory,
      directoryPath: store.runsDirectory,
    })
  )
    .filter((fileName) => RUN_FILE_PATTERN.test(fileName))
    .sort();
  for (const fileName of legacyNames) {
    const sourcePath = path.join(store.runsDirectory, fileName);
    const destinationPath = path.join(store.recordsDirectory, fileName);
    await assertRealFileIfPresent(sourcePath);
    try {
      await fs.lstat(destinationPath);
      throw new Error(`Conflicting Agent Memory run record: ${fileName}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(sourcePath, destinationPath);
  }
}

async function readRunRecord({
  homeDirectory,
  filePath,
}: {
  homeDirectory: string;
  filePath: string;
}): Promise<{
  value: Record<string, unknown>;
  run: AgentMemoryExtractionRun;
} | null> {
  try {
    const value = await readAgentMemoryJson({ homeDirectory, filePath });
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('run' in value)) {
      return null;
    }
    const parsed = agentMemoryExtractionRunSchema.safeParse(
      (value as { run: unknown }).run,
    );
    return parsed.success
      ? { value: value as Record<string, unknown>, run: parsed.data }
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function rebuildRunIndex({
  scope,
  projectId,
  homeDirectory,
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory: string;
}): Promise<AgentMemoryRunIndex> {
  const store = getRunStore({ scope, projectId, homeDirectory });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await recordsFingerprint(store.recordsDirectory);
    const fileNames = (
      await readAgentMemoryDirectoryNames({
        homeDirectory,
        directoryPath: store.recordsDirectory,
      })
    )
      .filter((fileName) => RUN_FILE_PATTERN.test(fileName))
      .sort();
    const records: Array<{
      fileName: string;
      record: Awaited<ReturnType<typeof readRunRecord>>;
    }> = new Array(fileNames.length);
    let nextIndex = 0;
    async function worker(): Promise<void> {
      while (nextIndex < fileNames.length) {
        const index = nextIndex;
        nextIndex += 1;
        const fileName = fileNames[index];
        records[index] = {
          fileName,
          record: await readRunRecord({
            homeDirectory,
            filePath: path.join(store.recordsDirectory, fileName),
          }),
        };
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(RUN_INDEX_REBUILD_CONCURRENCY, fileNames.length) },
        () => worker(),
      ),
    );
    const after = await recordsFingerprint(store.recordsDirectory);
    if (!sameRecordsFingerprint(before, after)) continue;
    const validRecords = records.flatMap(({ fileName, record }) =>
      record ? [{ fileName, ...record }] : [],
    );
    const assignedSequences = validRecords.flatMap(({ run }) =>
      run.sequence === undefined ? [] : [run.sequence],
    );
    if (new Set(assignedSequences).size !== assignedSequences.length) {
      throw new Error('Agent Memory run records contain duplicate sequences');
    }
    let nextSequence = Math.max(0, ...assignedSequences) + 1;
    const legacyRecords = validRecords
      .filter(({ run }) => run.sequence === undefined)
      .sort(
        (left, right) =>
          left.run.startedAt.localeCompare(right.run.startedAt) ||
          left.run.id.localeCompare(right.run.id) ||
          left.fileName.localeCompare(right.fileName),
      );
    for (const legacy of legacyRecords) {
      const run = agentMemoryExtractionRunSchema.parse({
        ...legacy.run,
        sequence: nextSequence,
      });
      nextSequence += 1;
      legacy.run = run;
      legacy.value = { ...legacy.value, run };
      await atomicWriteAgentMemoryJson({
        rootDirectory: store.rootDirectory,
        filePath: path.join(store.recordsDirectory, legacy.fileName),
        value: legacy.value,
      });
    }
    const finalFingerprint = await recordsFingerprint(store.recordsDirectory);
    const index: AgentMemoryRunIndex = {
      schemaVersion: RUN_INDEX_SCHEMA_VERSION,
      legacyMigrationComplete: true,
      recordCount: fileNames.length,
      nextSequence,
      recordsFingerprint: finalFingerprint,
      entries: sortRunIndexEntries(
        validRecords.map(({ fileName, run }) => runIndexEntry({ fileName, run })),
      ),
    };
    await atomicWriteAgentMemoryJson({
      rootDirectory: store.rootDirectory,
      filePath: store.indexFile,
      value: index,
    });
    return index;
  }
  throw new Error('Agent Memory run records changed during index rebuild');
}

async function readStoredRunIndex({
  store,
  homeDirectory,
}: {
  store: ReturnType<typeof getRunStore>;
  homeDirectory: string;
}): Promise<AgentMemoryRunIndex | null> {
  try {
    return parseRunIndex(
      await readAgentMemoryJson({
        homeDirectory,
        filePath: store.indexFile,
      }),
    );
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

async function currentRunIndexUnlocked({
  scope,
  projectId,
  homeDirectory,
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory: string;
}): Promise<AgentMemoryRunIndex | null> {
  const store = getRunStore({ scope, projectId, homeDirectory });
  if (!(await ensureRunRecordsDirectory(store, homeDirectory))) return null;
  const index = await readStoredRunIndex({ store, homeDirectory });
  if (
    index &&
    sameRecordsFingerprint(
      index.recordsFingerprint,
      await recordsFingerprint(store.recordsDirectory),
    )
  ) {
    return index;
  }
  if (!index?.legacyMigrationComplete) {
    await migrateLegacyRunFiles({ store, homeDirectory });
  }
  return rebuildRunIndex({ scope, projectId, homeDirectory });
}

export async function readAgentMemoryRunIndex({
  scope,
  projectId,
  homeDirectory = os.homedir(),
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory?: string;
}): Promise<AgentMemoryRunIndexEntry[]> {
  return withRunIndexLock(
    runIndexKey({ scope, projectId, homeDirectory }),
    async () =>
      (
        await currentRunIndexUnlocked({ scope, projectId, homeDirectory })
      )?.entries ?? [],
  );
}

export async function writeAgentMemoryRunRecord({
  fileName,
  record,
  homeDirectory = os.homedir(),
}: {
  fileName: string;
  record: unknown;
  homeDirectory?: string;
}): Promise<void> {
  if (!RUN_FILE_PATTERN.test(fileName)) {
    throw new Error(`Invalid Agent Memory run filename: ${fileName}`);
  }
  if (!record || typeof record !== 'object' || !('run' in record)) {
    throw new Error('Invalid Agent Memory run record');
  }
  const run = agentMemoryExtractionRunSchema.parse(
    (record as { run: unknown }).run,
  );
  await withRunIndexLock(
    runIndexKey({
      scope: run.scope,
      projectId: run.projectId,
      homeDirectory,
    }),
    async () => {
      const store = getRunStore({
        scope: run.scope,
        projectId: run.projectId,
        homeDirectory,
      });
      const index = await currentRunIndexUnlocked({
        scope: run.scope,
        projectId: run.projectId,
        homeDirectory,
      });
      if (!index) throw new Error('Agent Memory run storage is missing');
      const filePath = path.join(store.recordsDirectory, fileName);
      let recordExists = false;
      try {
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new UnsafeAgentMemoryPathError(
            `Unsafe agent memory file: ${filePath}`,
          );
        }
        recordExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const existingEntry = index.entries.find((entry) => entry.fileName === fileName);
      const sequencedRun = agentMemoryExtractionRunSchema.parse({
        ...run,
        sequence: existingEntry?.sequence ?? index.nextSequence,
      });
      await atomicWriteAgentMemoryJson({
        rootDirectory: store.rootDirectory,
        filePath,
        value: { ...(record as Record<string, unknown>), run: sequencedRun },
      });
      const nextIndex: AgentMemoryRunIndex = {
        schemaVersion: RUN_INDEX_SCHEMA_VERSION,
        legacyMigrationComplete: true,
        recordCount: index.recordCount + (recordExists ? 0 : 1),
        nextSequence: existingEntry ? index.nextSequence : index.nextSequence + 1,
        recordsFingerprint: await recordsFingerprint(store.recordsDirectory),
        entries: sortRunIndexEntries([
          ...index.entries.filter((entry) => entry.fileName !== fileName),
          runIndexEntry({ fileName, run: sequencedRun }),
        ]),
      };
      await atomicWriteAgentMemoryJson({
        rootDirectory: store.rootDirectory,
        filePath: store.indexFile,
        value: nextIndex,
      });
    },
  );
}

export async function readAgentMemoryRunTiming({
  scope,
  projectId,
  homeDirectory = os.homedir(),
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory?: string;
}): Promise<{
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
}> {
  const entries = await readAgentMemoryRunIndex({
    scope,
    projectId,
    homeDirectory,
  });
  const succeeded = entries.find((entry) => entry.status === 'succeeded');
  const stored = await readRecordedRunTiming({ scope, projectId, homeDirectory });
  const latestAttempt = [entries[0]?.startedAt, stored.lastAttemptAt]
    .filter((value): value is string => !!value)
    .sort()
    .at(-1) ?? null;
  const latestSuccess = [
    succeeded?.completedAt ?? succeeded?.startedAt,
    stored.lastSuccessAt,
  ]
    .filter((value): value is string => !!value)
    .sort()
    .at(-1) ?? null;
  return { lastAttemptAt: latestAttempt, lastSuccessAt: latestSuccess };
}

function runTimingStore({
  scope,
  projectId,
  homeDirectory,
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory: string;
}) {
  if (scope === 'project') {
    if (!projectId) throw new Error('Project run timing requires project ID');
    const paths = getAgentMemoryProjectPaths(projectId, homeDirectory);
    return {
      rootDirectory: paths.directory,
      filePath: path.join(paths.directory, 'scheduler-timing.json'),
    };
  }
  const paths = getAgentMemoryGlobalPaths(homeDirectory);
  return {
    rootDirectory: paths.directory,
    filePath: path.join(paths.directory, 'scheduler-timing.json'),
  };
}

async function readRecordedRunTiming({
  scope,
  projectId,
  homeDirectory,
}: {
  scope: 'project' | 'global';
  projectId?: string;
  homeDirectory: string;
}): Promise<{ lastAttemptAt: string | null; lastSuccessAt: string | null }> {
  const store = runTimingStore({ scope, projectId, homeDirectory });
  try {
    const value = await readAgentMemoryJson({
      homeDirectory,
      filePath: store.filePath,
    });
    if (!value || typeof value !== 'object') throw new Error('Invalid run timing');
    const record = value as Record<string, unknown>;
    return {
      lastAttemptAt:
        typeof record.lastAttemptAt === 'string' ? record.lastAttemptAt : null,
      lastSuccessAt:
        typeof record.lastSuccessAt === 'string' ? record.lastSuccessAt : null,
    };
  } catch (error) {
    // Timing is a scheduling hint, not canonical data. A missing, truncated, or
    // otherwise unparseable file must degrade to "never ran" rather than
    // permanently wedging the scheduler on every tick.
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error instanceof SyntaxError ||
      (error instanceof Error && error.message === 'Invalid run timing')
    ) {
      return { lastAttemptAt: null, lastSuccessAt: null };
    }
    throw error;
  }
}

export async function recordAgentMemoryRunTiming({
  scope,
  projectId,
  attemptedAt,
  succeeded,
  homeDirectory = os.homedir(),
}: {
  scope: 'project' | 'global';
  projectId?: string;
  attemptedAt: string;
  succeeded: boolean;
  homeDirectory?: string;
}): Promise<void> {
  const write = async () => {
    if (scope === 'project') {
      if (!projectId) throw new Error('Project run timing requires project ID');
      await ensureProjectAgentMemoryStorage({ projectId, homeDirectory });
    } else {
      await ensureAgentMemoryGlobalStorage({ homeDirectory });
    }
    const store = runTimingStore({ scope, projectId, homeDirectory });
    const current = await readRecordedRunTiming({ scope, projectId, homeDirectory });
    await atomicWriteAgentMemoryJson({
      rootDirectory: store.rootDirectory,
      filePath: store.filePath,
      value: {
        schemaVersion: AGENT_MEMORY_SCHEMA_VERSION,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: succeeded ? attemptedAt : current.lastSuccessAt,
      },
    });
  };
  if (scope === 'project') {
    await withProjectAgentMemoryLock(projectId!, write);
  } else {
    await withGlobalAgentMemoryLock(write);
  }
}

async function ensureAgentMemoryRoot(homeDirectory: string): Promise<void> {
  const homeStat = await fs.lstat(homeDirectory);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    throw new UnsafeAgentMemoryPathError(
      `Unsafe agent memory directory: ${homeDirectory}`,
    );
  }
  await ensureRealDirectory(path.join(homeDirectory, '.jean-claude'));
  await ensureRealDirectory(getAgentMemoryRootDir(homeDirectory));
}

export async function ensureAgentMemoryProjectsDirectory(
  homeDirectory = os.homedir(),
): Promise<void> {
  await ensureAgentMemoryRoot(homeDirectory);
  await ensureRealDirectory(getAgentMemoryProjectsDir(homeDirectory));
}

export async function ensureProjectAgentMemoryDirectory({
  projectId,
  homeDirectory = os.homedir(),
  projectMemoryDir = getProjectAgentMemoryDir(projectId, homeDirectory),
}: {
  projectId: string;
  homeDirectory?: string;
  projectMemoryDir?: string;
}): Promise<void> {
  await ensureAgentMemoryProjectsDirectory(homeDirectory);
  if (
    path.dirname(path.resolve(projectMemoryDir)) !==
    path.resolve(getAgentMemoryProjectsDir(homeDirectory))
  ) {
    throw new UnsafeAgentMemoryPathError(
      `Unsafe agent memory project directory: ${projectMemoryDir}`,
    );
  }
  await ensureRealDirectory(projectMemoryDir);
}

export async function assertSafeAgentMemoryTree(
  rootDirectory: string,
): Promise<void> {
  const stat = await fs.lstat(rootDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new UnsafeAgentMemoryPathError(
      `Unsafe agent memory path: ${rootDirectory}`,
    );
  }
  if ((stat.mode & 0o777) !== 0o700) await fs.chmod(rootDirectory, 0o700);
  const entries = await fs.readdir(rootDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDirectory, entry.name);
    const entryStat = await fs.lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe symlink in agent memory: ${entryPath}`,
      );
    }
    if (entryStat.isDirectory()) {
      await assertSafeAgentMemoryTree(entryPath);
    } else if (!entryStat.isFile()) {
      throw new UnsafeAgentMemoryPathError(
        `Unsafe file type in agent memory: ${entryPath}`,
      );
    } else {
      if ((entryStat.mode & 0o777) !== 0o600) {
        await fs.chmod(entryPath, 0o600);
      }
    }
  }
}

async function assertSafeAgentMemoryDestination({
  rootDirectory,
  filePath,
}: {
  rootDirectory: string;
  filePath: string;
}): Promise<void> {
  assertContainedPath(rootDirectory, filePath);
  if (!(await assertRealDirectory(rootDirectory))) {
    throw new UnsafeAgentMemoryPathError(
      `Missing agent memory directory: ${rootDirectory}`,
    );
  }
  const relativeParent = path.relative(
    path.resolve(rootDirectory),
    path.resolve(path.dirname(filePath)),
  );
  let currentDirectory = path.resolve(rootDirectory);
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    currentDirectory = path.join(currentDirectory, segment);
    if (!(await assertRealDirectory(currentDirectory))) {
      throw new UnsafeAgentMemoryPathError(
        `Missing agent memory directory: ${currentDirectory}`,
      );
    }
  }
  await assertRealFileIfPresent(filePath);
}

async function atomicWrite({
  rootDirectory,
  filePath,
  content,
}: {
  rootDirectory: string;
  filePath: string;
  content: string;
}): Promise<void> {
  await assertSafeAgentMemoryDestination({ rootDirectory, filePath });
  const parentDirectory = path.dirname(filePath);
  const temporaryPath = path.join(
    parentDirectory,
    `.${path.basename(filePath)}-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporaryPath, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function atomicWriteAgentMemoryJson({
  rootDirectory,
  filePath,
  value,
}: {
  rootDirectory: string;
  filePath: string;
  value: unknown;
}): Promise<void> {
  const redacted = redactAgentMemoryValue(value).value;
  await atomicWrite({
    rootDirectory,
    filePath,
    content: `${JSON.stringify(redacted, null, 2)}\n`,
  });
}

export async function atomicWriteAgentMemoryMarkdown({
  rootDirectory,
  filePath,
  content,
}: {
  rootDirectory: string;
  filePath: string;
  content: string;
}): Promise<void> {
  await atomicWrite({
    rootDirectory,
    filePath,
    content: redactAgentMemoryValue(content).value,
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeInitialJson({
  rootDirectory,
  filePath,
  value,
}: {
  rootDirectory: string;
  filePath: string;
  value: unknown;
}): Promise<void> {
  if (!(await pathExists(filePath))) {
    await atomicWriteAgentMemoryJson({ rootDirectory, filePath, value });
  }
}

async function writeInitialMarkdown({
  rootDirectory,
  filePath,
}: {
  rootDirectory: string;
  filePath: string;
}): Promise<void> {
  if (!(await pathExists(filePath))) {
    await atomicWriteAgentMemoryMarkdown({
      rootDirectory,
      filePath,
      content: '',
    });
  }
}

export async function ensureAgentMemoryGlobalStorage({
  homeDirectory = os.homedir(),
}: {
  homeDirectory?: string;
} = {}): Promise<void> {
  await ensureAgentMemoryRoot(homeDirectory);
  const paths = getAgentMemoryGlobalPaths(homeDirectory);
  await ensureRealDirectory(paths.directory);
  await ensureRealDirectory(paths.runsDirectory);
  await ensureRealDirectory(path.join(paths.runsDirectory, 'records'));
  await assertSafeAgentMemoryTree(paths.directory);
  await writeInitialJson({
    rootDirectory: paths.directory,
    filePath: paths.profileJson,
    value: {
      schemaVersion: 1,
      items: [],
      consumedNominationIds: [],
      reviewedProjectRunKeys: [],
      projectRunHighWatermarks: {},
      projectionPending: false,
    },
  });
  await writeInitialMarkdown({
    rootDirectory: paths.directory,
    filePath: paths.profileMarkdown,
  });
}

export async function writeProjectAgentMemoryMetadata({
  projectId,
  name,
  sourcePath,
  homeDirectory = os.homedir(),
  projectMemoryDir = getProjectAgentMemoryDir(projectId, homeDirectory),
}: {
  projectId: string;
  name: string | null;
  sourcePath: string | null;
  homeDirectory?: string;
  projectMemoryDir?: string;
}): Promise<void> {
  await ensureProjectAgentMemoryDirectory({
    projectId,
    homeDirectory,
    projectMemoryDir,
  });
  await assertSafeAgentMemoryTree(projectMemoryDir);
  await atomicWriteAgentMemoryJson({
    rootDirectory: projectMemoryDir,
    filePath: path.join(projectMemoryDir, 'project.json'),
    value: { id: projectId, name, sourcePath },
  });
}

export async function ensureProjectAgentMemoryStorage({
  projectId,
  name = null,
  sourcePath = null,
  homeDirectory = os.homedir(),
}: {
  projectId: string;
  name?: string | null;
  sourcePath?: string | null;
  homeDirectory?: string;
}): Promise<void> {
  const paths = getAgentMemoryProjectPaths(projectId, homeDirectory);
  await ensureProjectAgentMemoryDirectory({ projectId, homeDirectory });
  await ensureRealDirectory(paths.eventsDirectory);
  await ensureRealDirectory(paths.runsDirectory);
  await ensureRealDirectory(path.join(paths.runsDirectory, 'records'));
  await assertSafeAgentMemoryTree(paths.directory);
  if (!(await pathExists(paths.metadataJson))) {
    await writeProjectAgentMemoryMetadata({
      projectId,
      name,
      sourcePath,
      homeDirectory,
    });
  }
  await writeInitialJson({
    rootDirectory: paths.directory,
    filePath: paths.itemsJson,
    value: { schemaVersion: 1, items: [] },
  });
  await writeInitialMarkdown({
    rootDirectory: paths.directory,
    filePath: paths.memoryMarkdown,
  });
  await writeInitialJson({
    rootDirectory: paths.directory,
    filePath: paths.extractionStateJson,
    value: {
      schemaVersion: 1,
      files: {},
      lastExtractedAt: null,
      projectionPending: false,
    },
  });
}

async function ensureProjectAgentMemoryAppendStorage({
  projectId,
  homeDirectory,
}: {
  projectId: string;
  homeDirectory: string;
}): Promise<void> {
  const paths = getAgentMemoryProjectPaths(projectId, homeDirectory);
  await ensureProjectAgentMemoryDirectory({ projectId, homeDirectory });
  await ensureRealDirectory(paths.eventsDirectory);
  await ensureRealDirectory(paths.runsDirectory);
  await ensureRealDirectory(path.join(paths.runsDirectory, 'records'));
  const canonicalFiles = [
    paths.metadataJson,
    paths.itemsJson,
    paths.memoryMarkdown,
    paths.extractionStateJson,
  ];
  if ((await Promise.all(canonicalFiles.map(pathExists))).some((exists) => !exists)) {
    await ensureProjectAgentMemoryStorage({ projectId, homeDirectory });
    return;
  }
  await Promise.all(canonicalFiles.map(assertRealFileIfPresent));
}

function completeJsonlEnd(content: Buffer): number {
  const lastNewline = content.lastIndexOf(0x0a);
  return lastNewline === -1 ? 0 : lastNewline + 1;
}

export class InvalidAgentMemoryEventLogError extends Error {
  constructor(filePath: string) {
    super(`Invalid JSON record in agent memory event log: ${filePath}`);
    this.name = 'InvalidAgentMemoryEventLogError';
  }
}

export class InvalidAgentMemoryEventRecordError extends Error {
  constructor(filePath: string) {
    super(`Unsupported record in agent memory event log: ${filePath}`);
    this.name = 'InvalidAgentMemoryEventRecordError';
  }
}

function parseEventRecord(
  value: unknown,
  filePath: string,
): AgentMemoryEvent | null {
  let parsed;
  try {
    parsed = { success: true as const, data: normalizeAgentMemoryEvent(value) };
  } catch {
    parsed = { success: false as const };
  }
  if (parsed.success) return parsed.data;
  if (
    isRecord(value) &&
    typeof value.schemaVersion === 'number' &&
    Number.isInteger(value.schemaVersion) &&
    value.schemaVersion > AGENT_MEMORY_SCHEMA_VERSION
  ) {
    return null;
  }
  throw new InvalidAgentMemoryEventRecordError(filePath);
}

async function eventFileNames(eventsDirectory: string): Promise<string[]> {
  try {
    return (await fs.readdir(eventsDirectory))
      .filter((fileName) => EVENT_FILE_PATTERN.test(fileName))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function assertManagedProjectTree({
  projectId,
  homeDirectory,
}: {
  projectId: string;
  homeDirectory: string;
}): Promise<boolean> {
  try {
    await assertSafeAgentMemoryPath({
      homeDirectory,
      targetPath: getAgentMemoryProjectPaths(projectId, homeDirectory)
        .eventsDirectory,
      type: 'directory',
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function getEventIndexPaths(eventsDirectory: string): {
  directory: string;
  manifest: string;
  daysDirectory: string;
  sourcesDirectory: string;
} {
  const directory = path.join(eventsDirectory, '.index');
  return {
    directory,
    manifest: path.join(directory, 'manifest.json'),
    daysDirectory: path.join(directory, 'days'),
    sourcesDirectory: path.join(directory, 'sources'),
  };
}

function sourceIdHash(sourceId: string): string {
  return createHash('sha256').update(sourceId).digest('hex');
}

function sourceShardName(sourceHash: string): string {
  return sourceHash.slice(0, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEventIndexRecord(value: unknown): value is EventIndexRecord {
  return (
    isRecord(value) &&
    typeof value.offset === 'number' &&
    Number.isInteger(value.offset) &&
    value.offset >= 0 &&
    typeof value.length === 'number' &&
    Number.isInteger(value.length) &&
    value.length > 0 &&
    (value.sourceHash === null || typeof value.sourceHash === 'string') &&
    (value.id === null || typeof value.id === 'string') &&
    (value.createdAt === null || typeof value.createdAt === 'string') &&
    typeof value.supported === 'boolean'
  );
}

function isDayIndex(value: unknown): value is EventDayIndex {
  return (
    isRecord(value) &&
    value.schemaVersion === EVENT_INDEX_SCHEMA_VERSION &&
    typeof value.fileName === 'string' &&
    EVENT_FILE_PATTERN.test(value.fileName) &&
    typeof value.fileSize === 'number' &&
    Number.isInteger(value.fileSize) &&
    value.fileSize >= 0 &&
    Array.isArray(value.records) &&
    value.records.every(isEventIndexRecord)
  );
}

function isManifest(value: unknown): value is EventIndexManifest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== EVENT_INDEX_SCHEMA_VERSION ||
    !isRecord(value.files) ||
    !isRecord(value.sourceShards)
  ) {
    return false;
  }
  return (
    Object.entries(value.files).every(
      ([fileName, metadata]) =>
        EVENT_FILE_PATTERN.test(fileName) &&
        isRecord(metadata) &&
        typeof metadata.size === 'number' &&
        Number.isInteger(metadata.size) &&
        metadata.size >= 0 &&
        typeof metadata.mtimeMs === 'number' &&
        Number.isFinite(metadata.mtimeMs) &&
        typeof metadata.supportedCount === 'number' &&
        Number.isInteger(metadata.supportedCount) &&
        metadata.supportedCount >= 0 &&
        typeof metadata.object === 'string' &&
        /^[a-zA-Z0-9.-]+\.json$/.test(metadata.object) &&
        typeof metadata.digest === 'string' &&
        /^[a-f0-9]{64}$/.test(metadata.digest) &&
        Array.isArray(metadata.sourceShards) &&
        metadata.sourceShards.every(
          (shard) => typeof shard === 'string' && /^[a-f0-9]{2}$/.test(shard),
        ),
    ) &&
    Object.entries(value.sourceShards).every(
      ([shard, metadata]) =>
        /^[a-f0-9]{2}$/.test(shard) &&
        isRecord(metadata) &&
        typeof metadata.object === 'string' &&
        /^[a-zA-Z0-9.-]+\.json$/.test(metadata.object) &&
        typeof metadata.digest === 'string' &&
        /^[a-f0-9]{64}$/.test(metadata.digest),
    )
  );
}

function isSourceIndex(value: unknown): value is EventSourceIndex {
  return (
    isRecord(value) &&
    value.schemaVersion === EVENT_INDEX_SCHEMA_VERSION &&
    typeof value.shard === 'string' &&
    /^[a-f0-9]{2}$/.test(value.shard) &&
    isRecord(value.entries) &&
    Object.entries(value.entries).every(
      ([hash, fileNames]) =>
        /^[a-f0-9]{64}$/.test(hash) &&
        Array.isArray(fileNames) &&
        fileNames.every(
          (fileName) =>
            typeof fileName === 'string' && EVENT_FILE_PATTERN.test(fileName),
        ),
    )
  );
}

async function readDerivedJsonWithDigest(filePath: string): Promise<{
  value: unknown;
  digest: string;
} | null> {
  try {
    await assertRealFileIfPresent(filePath);
    const content = (await readFileNoFollow(filePath)) as Buffer;
    return {
      value: JSON.parse(content.toString('utf-8')) as unknown,
      digest: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

async function readDerivedJson(filePath: string): Promise<unknown | null> {
  return (await readDerivedJsonWithDigest(filePath))?.value ?? null;
}

async function ensureEventIndexDirectories(eventsDirectory: string): Promise<void> {
  const indexPaths = getEventIndexPaths(eventsDirectory);
  await ensureRealDirectory(indexPaths.directory);
  await ensureRealDirectory(indexPaths.daysDirectory);
  await ensureRealDirectory(indexPaths.sourcesDirectory);
}

function indexedRecord({
  value,
  offset,
  length,
  filePath,
}: {
  value: unknown;
  offset: number;
  length: number;
  filePath: string;
}): EventIndexRecord {
  const supported = parseEventRecord(value, filePath);
  if (supported) {
    return {
      offset,
      length,
      sourceHash: sourceIdHash(supported.sourceId),
      id: supported.id,
      createdAt: supported.createdAt,
      supported: true,
    };
  }
  return {
    offset,
    length,
    sourceHash:
      isRecord(value) && typeof value.sourceId === 'string'
        ? sourceIdHash(value.sourceId)
        : null,
    id: isRecord(value) && typeof value.id === 'string' ? value.id : null,
    createdAt:
      isRecord(value) && typeof value.createdAt === 'string'
        ? value.createdAt
        : null,
    supported: false,
  };
}

async function indexEventFile({
  eventsDirectory,
  fileName,
}: {
  eventsDirectory: string;
  fileName: string;
}): Promise<EventDayIndex> {
  const filePath = path.join(eventsDirectory, fileName);
  await assertRealFileIfPresent(filePath);
  const content = await fs.readFile(filePath);
  const records: EventIndexRecord[] = [];
  let lineStart = 0;

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) continue;
    const line = content.subarray(lineStart, index).toString('utf-8');
    if (line.trim()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new InvalidAgentMemoryEventLogError(filePath);
      }
      records.push(
        indexedRecord({
          value,
          offset: lineStart,
          length: index - lineStart + 1,
          filePath,
        }),
      );
    }
    lineStart = index + 1;
  }

  let fileSize = content.length;
  if (lineStart < content.length) {
    const trailing = content.subarray(lineStart).toString('utf-8');
    let value: unknown;
    try {
      value = JSON.parse(trailing) as unknown;
    } catch {
      await fs.truncate(filePath, lineStart);
      await fs.chmod(filePath, 0o600);
      return {
        schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
        fileName,
        fileSize: lineStart,
        records,
      };
    }
    await fs.appendFile(filePath, '\n', { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    fileSize += 1;
    records.push(
      indexedRecord({
        value,
        offset: lineStart,
        length: Buffer.byteLength(trailing) + 1,
        filePath,
      }),
    );
  }

  return {
    schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
    fileName,
    fileSize,
    records,
  };
}

function indexJsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeIndexJson({
  eventsDirectory,
  filePath,
  value,
}: {
  eventsDirectory: string;
  filePath: string;
  value: unknown;
}): Promise<void> {
  await atomicWrite({
    rootDirectory: getEventIndexPaths(eventsDirectory).directory,
    filePath,
    content: indexJsonContent(value),
  });
}

async function writeImmutableIndexObject({
  eventsDirectory,
  directory,
  prefix,
  value,
}: {
  eventsDirectory: string;
  directory: string;
  prefix: string;
  value: unknown;
}): Promise<{ object: string; digest: string }> {
  const object = `${prefix}-${randomUUID()}.json`;
  const content = indexJsonContent(value);
  await atomicWrite({
    rootDirectory: getEventIndexPaths(eventsDirectory).directory,
    filePath: path.join(directory, object),
    content,
  });
  return {
    object,
    digest: createHash('sha256').update(content).digest('hex'),
  };
}

async function loadDayIndex({
  eventsDirectory,
  fileName,
  reference,
}: {
  eventsDirectory: string;
  fileName: string;
  reference: { object: string; digest: string };
}): Promise<EventDayIndex | null> {
  if (!reference.object.startsWith(`${fileName.replace(/\.jsonl$/, '')}-`)) {
    return null;
  }
  const indexed = await readDerivedJsonWithDigest(
    path.join(getEventIndexPaths(eventsDirectory).daysDirectory, reference.object),
  );
  return indexed &&
    indexed.digest === reference.digest &&
    isDayIndex(indexed.value) &&
    indexed.value.fileName === fileName
    ? indexed.value
    : null;
}

async function loadSourceIndex({
  eventsDirectory,
  shard,
  reference,
}: {
  eventsDirectory: string;
  shard: string;
  reference: { object: string; digest: string };
}): Promise<EventSourceIndex | null> {
  if (!reference.object.startsWith(`${shard}-`)) return null;
  const indexed = await readDerivedJsonWithDigest(
    path.join(
      getEventIndexPaths(eventsDirectory).sourcesDirectory,
      reference.object,
    ),
  );
  return indexed &&
    indexed.digest === reference.digest &&
    isSourceIndex(indexed.value) &&
    indexed.value.shard === shard
    ? indexed.value
    : null;
}

function sourceShardsForDay(day: EventDayIndex): string[] {
  return [
    ...new Set(
      day.records
        .map((record) => record.sourceHash)
        .filter((hash): hash is string => hash !== null)
        .map(sourceShardName),
    ),
  ].sort();
}

async function writeDayObject({
  eventsDirectory,
  day,
}: {
  eventsDirectory: string;
  day: EventDayIndex;
}): Promise<{ object: string; digest: string }> {
  return writeImmutableIndexObject({
    eventsDirectory,
    directory: getEventIndexPaths(eventsDirectory).daysDirectory,
    prefix: day.fileName.replace(/\.jsonl$/, ''),
    value: day,
  });
}

async function writeSourceObject({
  eventsDirectory,
  source,
}: {
  eventsDirectory: string;
  source: EventSourceIndex;
}): Promise<{ object: string; digest: string }> {
  return writeImmutableIndexObject({
    eventsDirectory,
    directory: getEventIndexPaths(eventsDirectory).sourcesDirectory,
    prefix: source.shard,
    value: source,
  });
}

async function publishManifest({
  eventsDirectory,
  manifest,
}: {
  eventsDirectory: string;
  manifest: EventIndexManifest;
}): Promise<void> {
  await writeIndexJson({
    eventsDirectory,
    filePath: getEventIndexPaths(eventsDirectory).manifest,
    value: manifest,
  });
}

function addSourceEntry(
  entries: Record<string, string[]>,
  sourceHash: string,
  fileName: string,
): void {
  entries[sourceHash] = [
    ...new Set([...(entries[sourceHash] ?? []), fileName]),
  ].sort();
}

function removeSourceEntry(
  entries: Record<string, string[]>,
  sourceHash: string,
  fileName: string,
): void {
  const remaining = (entries[sourceHash] ?? []).filter(
    (entry) => entry !== fileName,
  );
  if (remaining.length > 0) entries[sourceHash] = remaining;
  else delete entries[sourceHash];
}

async function updateSourceObjectsForDay({
  eventsDirectory,
  manifest,
  fileName,
  previousDay,
  nextDay,
}: {
  eventsDirectory: string;
  manifest: EventIndexManifest;
  fileName: string;
  previousDay: EventDayIndex | null;
  nextDay: EventDayIndex;
}): Promise<boolean> {
  const previousByShard = new Map<string, string[]>();
  const nextByShard = new Map<string, string[]>();
  for (const record of previousDay?.records ?? []) {
    if (!record.sourceHash) continue;
    const shard = sourceShardName(record.sourceHash);
    previousByShard.set(shard, [
      ...(previousByShard.get(shard) ?? []),
      record.sourceHash,
    ]);
  }
  for (const record of nextDay.records) {
    if (!record.sourceHash) continue;
    const shard = sourceShardName(record.sourceHash);
    nextByShard.set(shard, [
      ...(nextByShard.get(shard) ?? []),
      record.sourceHash,
    ]);
  }
  const shards = new Set([...previousByShard.keys(), ...nextByShard.keys()]);
  for (const shard of shards) {
    const reference = manifest.sourceShards[shard];
    const current = reference
      ? await loadSourceIndex({ eventsDirectory, shard, reference })
      : { schemaVersion: EVENT_INDEX_SCHEMA_VERSION, shard, entries: {} };
    if (!current) return false;
    const entries = Object.fromEntries(
      Object.entries(current.entries).map(([hash, files]) => [hash, [...files]]),
    );
    for (const hash of previousByShard.get(shard) ?? []) {
      removeSourceEntry(entries, hash, fileName);
    }
    for (const hash of nextByShard.get(shard) ?? []) {
      addSourceEntry(entries, hash, fileName);
    }
    if (Object.keys(entries).length === 0) {
      delete manifest.sourceShards[shard];
      continue;
    }
    manifest.sourceShards[shard] = await writeSourceObject({
      eventsDirectory,
      source: {
        schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
        shard,
        entries,
      },
    });
  }
  return true;
}

async function setManifestDay({
  eventsDirectory,
  manifest,
  day,
}: {
  eventsDirectory: string;
  manifest: EventIndexManifest;
  day: EventDayIndex;
}): Promise<void> {
  const filePath = path.join(eventsDirectory, day.fileName);
  await assertRealFileIfPresent(filePath);
  const stat = await fs.stat(filePath);
  manifest.files[day.fileName] = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    supportedCount: day.records.filter((record) => record.supported).length,
    sourceShards: sourceShardsForDay(day),
    ...(await writeDayObject({ eventsDirectory, day })),
  };
}

async function rebuildEventIndex(eventsDirectory: string): Promise<EventIndexManifest> {
  await ensureEventIndexDirectories(eventsDirectory);
  const manifest: EventIndexManifest = {
    schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
    files: {},
    sourceShards: {},
  };
  const days: EventDayIndex[] = [];
  for (const fileName of await eventFileNames(eventsDirectory)) {
    days.push(await indexEventFile({ eventsDirectory, fileName }));
  }
  const sourceEntries = new Map<string, Record<string, string[]>>();
  for (const day of days) {
    for (const record of day.records) {
      if (!record.sourceHash) continue;
      const shard = sourceShardName(record.sourceHash);
      const entries = sourceEntries.get(shard) ?? {};
      addSourceEntry(entries, record.sourceHash, day.fileName);
      sourceEntries.set(shard, entries);
    }
    await setManifestDay({ eventsDirectory, manifest, day });
  }
  for (const [shard, entries] of sourceEntries) {
    manifest.sourceShards[shard] = await writeSourceObject({
      eventsDirectory,
      source: {
        schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
        shard,
        entries,
      },
    });
  }
  await publishManifest({ eventsDirectory, manifest });
  return manifest;
}

async function refreshChangedDay({
  eventsDirectory,
  manifest,
  fileName,
}: {
  eventsDirectory: string;
  manifest: EventIndexManifest;
  fileName: string;
}): Promise<boolean> {
  const metadata = manifest.files[fileName];
  const previousDay = metadata
    ? await loadDayIndex({ eventsDirectory, fileName, reference: metadata })
    : null;
  if (metadata && !previousDay) return false;
  const nextDay = await indexEventFile({ eventsDirectory, fileName });
  if (
    !(await updateSourceObjectsForDay({
      eventsDirectory,
      manifest,
      fileName,
      previousDay,
      nextDay,
    }))
  ) {
    return false;
  }
  await setManifestDay({ eventsDirectory, manifest, day: nextDay });
  return true;
}

async function ensureEventIndex(
  eventsDirectory: string,
  validateCanonicalFiles = true,
): Promise<EventIndexManifest> {
  await ensureEventIndexDirectories(eventsDirectory);
  const value = await readDerivedJson(getEventIndexPaths(eventsDirectory).manifest);
  if (!isManifest(value)) return rebuildEventIndex(eventsDirectory);
  const manifest = value;
  if (!validateCanonicalFiles) return manifest;
  const fileNames = await eventFileNames(eventsDirectory);
  if (
    JSON.stringify(fileNames) !== JSON.stringify(Object.keys(manifest.files).sort())
  ) {
    return rebuildEventIndex(eventsDirectory);
  }
  let changed = false;
  for (const fileName of fileNames) {
    const filePath = path.join(eventsDirectory, fileName);
    await assertRealFileIfPresent(filePath);
    const stat = await fs.stat(filePath);
    const metadata = manifest.files[fileName];
    if (metadata.size === stat.size && metadata.mtimeMs === stat.mtimeMs) continue;
    if (!(await refreshChangedDay({ eventsDirectory, manifest, fileName }))) {
      return rebuildEventIndex(eventsDirectory);
    }
    changed = true;
  }
  if (changed) await publishManifest({ eventsDirectory, manifest });
  return manifest;
}

async function prepareAppendIndex({
  eventsDirectory,
  sourceId,
  fileName,
}: {
  eventsDirectory: string;
  sourceId: string;
  fileName: string;
}): Promise<{
  manifest: EventIndexManifest;
  source: EventSourceIndex;
  day: EventDayIndex | null;
  duplicate: boolean;
}> {
  const sourceHash = sourceIdHash(sourceId);
  const shard = sourceShardName(sourceHash);
  let manifest = await ensureEventIndex(eventsDirectory);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sourceReference = manifest.sourceShards[shard];
    const source = sourceReference
      ? await loadSourceIndex({
          eventsDirectory,
          shard,
          reference: sourceReference,
        })
      : {
          schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
          shard,
          entries: {},
        };
    if (source) {
      if (source.entries[sourceHash]?.length) {
        return { manifest, source, day: null, duplicate: true };
      }
      const dayReference = manifest.files[fileName];
      const day = dayReference
        ? await loadDayIndex({
            eventsDirectory,
            fileName,
            reference: dayReference,
          })
        : null;
      if (!dayReference || day) {
        return { manifest, source, day, duplicate: false };
      }
    }
    manifest = await rebuildEventIndex(eventsDirectory);
  }
  throw new Error('Failed to recover derived agent memory index');
}

async function appendEventUnlocked({
  event,
  homeDirectory,
}: {
  event: AgentMemoryEvent;
  homeDirectory: string;
}): Promise<{
  appended: boolean;
  filePath: string;
  fromOffset: number;
  toOffset: number;
}> {
  await ensureProjectAgentMemoryAppendStorage({
    projectId: event.projectId,
    homeDirectory,
  });
  const paths = getAgentMemoryProjectPaths(event.projectId, homeDirectory);
  const redacted = redactAgentMemoryValue(event);
  const redactedEvent = redacted.value as AgentMemoryEvent;
  const safeEvent = normalizeAgentMemoryEvent({
    ...redactedEvent,
    ...(redactedEvent.text.length > AGENT_MEMORY_MAX_EVENT_TEXT_CHARS
      ? {
          text: redactedEvent.text.slice(0, AGENT_MEMORY_MAX_EVENT_TEXT_CHARS),
          textTruncated: true,
        }
      : {}),
    redactions: [...event.redactions, ...redacted.markers],
  });
  const fileName = `${safeEvent.createdAt.slice(0, 10)}.jsonl`;
  const prepared = await prepareAppendIndex({
    eventsDirectory: paths.eventsDirectory,
    sourceId: safeEvent.sourceId,
    fileName,
  });
  if (prepared.duplicate) {
    return { appended: false, filePath: '', fromOffset: 0, toOffset: 0 };
  }
  const { manifest, source } = prepared;
  const previousDayObject = manifest.files[fileName]?.object;
  const previousSourceObject = manifest.sourceShards[source.shard]?.object;
  const filePath = path.join(paths.eventsDirectory, fileName);
  await assertRealFileIfPresent(filePath);
  const fromOffset = (await fs.stat(filePath).catch(() => ({ size: 0 }))).size;
  const line = `${JSON.stringify(safeEvent)}\n`;
  await fs.appendFile(filePath, line, { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  const existingDay = prepared.day ?? {
      schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
      fileName,
      fileSize: fromOffset,
      records: [],
    };
  const sourceHash = sourceIdHash(safeEvent.sourceId);
  const day: EventDayIndex = {
    ...existingDay,
    fileSize: fromOffset + Buffer.byteLength(line),
    records: [
      ...existingDay.records,
      {
        offset: fromOffset,
        length: Buffer.byteLength(line),
        sourceHash,
        id: safeEvent.id,
        createdAt: safeEvent.createdAt,
        supported: true,
      },
    ],
  };
  const dayReference = await writeDayObject({
    eventsDirectory: paths.eventsDirectory,
    day,
  });
  const sourceEntries = Object.fromEntries(
    Object.entries(source.entries).map(([hash, files]) => [hash, [...files]]),
  );
  addSourceEntry(sourceEntries, sourceHash, fileName);
  const sourceReference = await writeSourceObject({
    eventsDirectory: paths.eventsDirectory,
    source: {
      schemaVersion: EVENT_INDEX_SCHEMA_VERSION,
      shard: source.shard,
      entries: sourceEntries,
    },
  });
  const stat = await fs.stat(filePath);
  manifest.files[fileName] = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    supportedCount: day.records.filter((record) => record.supported).length,
    sourceShards: sourceShardsForDay(day),
    ...dayReference,
  };
  manifest.sourceShards[source.shard] = sourceReference;
  await publishManifest({ eventsDirectory: paths.eventsDirectory, manifest });
  const indexPaths = getEventIndexPaths(paths.eventsDirectory);
  await Promise.allSettled([
    previousDayObject
      ? fs.rm(path.join(indexPaths.daysDirectory, previousDayObject), {
          force: true,
        })
      : Promise.resolve(),
    previousSourceObject
      ? fs.rm(path.join(indexPaths.sourcesDirectory, previousSourceObject), {
          force: true,
        })
      : Promise.resolve(),
  ]);
  return {
    appended: true,
    filePath,
    fromOffset,
    toOffset: fromOffset + Buffer.byteLength(line),
  };
}

export async function appendAgentMemoryEvent({
  event,
  homeDirectory = os.homedir(),
}: {
  event: AgentMemoryEvent;
  homeDirectory?: string;
}): Promise<{
  appended: boolean;
  filePath: string;
  fromOffset: number;
  toOffset: number;
}> {
  const safeEvent = normalizeAgentMemoryEvent(event);
  return withProjectAgentMemoryLock(safeEvent.projectId, () =>
    appendEventUnlocked({ event: safeEvent, homeDirectory }),
  );
}

export async function readAgentMemoryEventPage({
  projectId,
  homeDirectory = os.homedir(),
  page = 0,
  pageSize = 20,
  validateCanonicalFiles = true,
}: {
  projectId: string;
  homeDirectory?: string;
  page?: number;
  pageSize?: number;
  validateCanonicalFiles?: boolean;
}): Promise<AgentMemoryPage<AgentMemoryEvent>> {
  return withProjectAgentMemoryLock(projectId, async () => {
    const safePage = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
    const safePageSize = Number.isFinite(pageSize)
      ? Math.min(100, Math.max(1, Math.floor(pageSize)))
      : 20;
    const paths = getAgentMemoryProjectPaths(projectId, homeDirectory);
    if (!(await assertManagedProjectTree({ projectId, homeDirectory }))) {
      return { items: [], page: safePage, pageSize: safePageSize, total: 0 };
    }
    let manifest = await ensureEventIndex(
      paths.eventsDirectory,
      validateCanonicalFiles,
    );
    const total = Object.values(manifest.files).reduce(
      (sum, metadata) => sum + metadata.supportedCount,
      0,
    );
    let remainingSkip = safePage * safePageSize;
    let remainingTake = safePageSize;
    const selected: Array<{ fileName: string; record: EventIndexRecord }> = [];
    for (const fileName of Object.keys(manifest.files).sort().reverse()) {
      if (remainingTake === 0) break;
      const count = manifest.files[fileName].supportedCount;
      if (remainingSkip >= count) {
        remainingSkip -= count;
        continue;
      }
      let day = await loadDayIndex({
        eventsDirectory: paths.eventsDirectory,
        fileName,
        reference: manifest.files[fileName],
      });
      if (!day) {
        manifest = await rebuildEventIndex(paths.eventsDirectory);
        const reference = manifest.files[fileName];
        day = reference
          ? await loadDayIndex({
              eventsDirectory: paths.eventsDirectory,
              fileName,
              reference,
            })
          : null;
      }
      if (!day) throw new Error(`Missing agent memory event index: ${fileName}`);
      const records = day.records
        .filter((record) => record.supported)
        .sort((left, right) =>
          (right.createdAt ?? '').localeCompare(left.createdAt ?? ''),
        );
      const available = records.slice(
        remainingSkip,
        remainingSkip + remainingTake,
      );
      selected.push(
        ...available.map((record) => ({ fileName, record })),
      );
      remainingTake -= available.length;
      remainingSkip = 0;
    }

    const items: AgentMemoryEvent[] = [];
    for (const selection of selected) {
      const filePath = path.join(paths.eventsDirectory, selection.fileName);
      await assertRealFileIfPresent(filePath);
      const handle = await openFileNoFollow(filePath);
      try {
        const buffer = Buffer.alloc(selection.record.length);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          selection.record.offset,
        );
        const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf-8'));
        items.push(normalizeAgentMemoryEvent(value));
      } finally {
        await handle.close();
      }
    }
    return { items, page: safePage, pageSize: safePageSize, total };
  });
}

function readPendingRecords({
  content,
  fromOffset,
  toOffset,
  filePath,
  maxEvents,
  maxEvidenceChars,
}: {
  content: Buffer;
  fromOffset: number;
  toOffset: number;
  filePath: string;
  maxEvents: number;
  maxEvidenceChars: number;
}): {
  events: AgentMemoryEvent[];
  toOffset: number;
  stoppedAtFuture: boolean;
  stoppedAtLimit: boolean;
  evidenceChars: number;
} {
  const events: AgentMemoryEvent[] = [];
  let lineStart = fromOffset;
  let evidenceChars = 0;
  for (let index = fromOffset; index < toOffset; index += 1) {
    if (content[index] !== 0x0a) continue;
    if (events.length >= maxEvents || evidenceChars >= maxEvidenceChars) {
      return {
        events,
        toOffset: lineStart,
        stoppedAtFuture: false,
        stoppedAtLimit: true,
        evidenceChars,
      };
    }
    const line = content.subarray(lineStart, index).toString('utf-8');
    if (line.trim()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new InvalidAgentMemoryEventLogError(filePath);
      }
      const event = parseEventRecord(value, filePath);
      if (!event) {
        return {
          events,
          toOffset: lineStart,
          stoppedAtFuture: true,
          stoppedAtLimit: false,
          evidenceChars,
        };
      }
      const remainingChars = maxEvidenceChars - evidenceChars;
      if (event.text.length > remainingChars) {
        if (events.length === 0 && remainingChars > 0) {
          events.push({
            ...event,
            text: event.text.slice(0, remainingChars),
            textTruncated: true,
          });
          return {
            events,
            toOffset: index + 1,
            stoppedAtFuture: false,
            stoppedAtLimit: true,
            evidenceChars: remainingChars,
          };
        }
        return {
          events,
          toOffset: lineStart,
          stoppedAtFuture: false,
          stoppedAtLimit: true,
          evidenceChars,
        };
      }
      events.push(event);
      evidenceChars += event.text.length;
    }
    lineStart = index + 1;
  }
  return {
    events,
    toOffset,
    stoppedAtFuture: false,
    stoppedAtLimit: false,
    evidenceChars,
  };
}

export async function readPendingAgentMemoryEvents({
  projectId,
  state,
  homeDirectory = os.homedir(),
  maxEvents = Number.POSITIVE_INFINITY,
  maxEvidenceChars = Number.POSITIVE_INFINITY,
}: {
  projectId: string;
  state: AgentMemoryExtractionState;
  homeDirectory?: string;
  maxEvents?: number;
  maxEvidenceChars?: number;
}): Promise<{ events: AgentMemoryEvent[]; ranges: AgentMemoryEventRange[] }> {
  const paths = getAgentMemoryProjectPaths(projectId, homeDirectory);
  if (!(await assertManagedProjectTree({ projectId, homeDirectory }))) {
    return { events: [], ranges: [] };
  }
  const events: AgentMemoryEvent[] = [];
  const ranges: AgentMemoryEventRange[] = [];
  let evidenceChars = 0;
  for (const fileName of await eventFileNames(paths.eventsDirectory)) {
    const filePath = path.join(paths.eventsDirectory, fileName);
    await assertRealFileIfPresent(filePath);
    const content = (await readFileNoFollow(filePath)) as Buffer;
    const completeEnd = completeJsonlEnd(content);
    const fromOffset = Math.min(state.files[fileName] ?? 0, completeEnd);
    if (fromOffset >= completeEnd) continue;
    const pending = readPendingRecords({
      content,
      fromOffset,
      toOffset: completeEnd,
      filePath,
      maxEvents: Math.max(0, maxEvents - events.length),
      maxEvidenceChars: Math.max(0, maxEvidenceChars - evidenceChars),
    });
    events.push(...pending.events);
    evidenceChars += pending.evidenceChars;
    if (pending.toOffset > fromOffset) {
      ranges.push({
        fileName,
        fromOffset,
        toOffset: pending.toOffset,
        eventCount: pending.events.length,
      });
    }
    if (pending.stoppedAtFuture || pending.stoppedAtLimit) {
      return { events, ranges };
    }
  }
  return { events, ranges };
}

export async function removeProjectAgentMemory({
  projectId,
  homeDirectory = os.homedir(),
}: {
  projectId: string;
  homeDirectory?: string;
}): Promise<void> {
  const managedDirectories = [
    path.join(homeDirectory, '.jean-claude'),
    getAgentMemoryRootDir(homeDirectory),
    getAgentMemoryProjectsDir(homeDirectory),
  ];
  for (const directory of managedDirectories) {
    if (!(await assertRealDirectory(directory))) return;
  }
  const projectDirectory = getProjectAgentMemoryDir(projectId, homeDirectory);
  if (!(await assertRealDirectory(projectDirectory))) return;
  await assertSafeAgentMemoryTree(projectDirectory);
  await fs.rm(projectDirectory, { force: true, recursive: true });
}

function withQueuedLock<T>({
  previous,
  setTail,
  operation,
}: {
  previous: Promise<void>;
  setTail: (tail: Promise<void>) => void;
  operation: () => Promise<T>;
}): Promise<T> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  setTail(tail);
  return previous.then(operation).finally(release);
}

export function withProjectAgentMemoryLock<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectOperationTails.get(projectId) ?? Promise.resolve();
  let currentTail: Promise<void>;
  return withQueuedLock({
    previous,
    setTail: (tail) => {
      currentTail = tail;
      projectOperationTails.set(projectId, tail);
      void tail.finally(() => {
        if (projectOperationTails.get(projectId) === currentTail) {
          projectOperationTails.delete(projectId);
        }
      });
    },
    operation,
  });
}

export function withProjectAgentMemoryExtractionLock<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = projectExtractionTails.get(projectId) ?? Promise.resolve();
  let currentTail: Promise<void>;
  return withQueuedLock({
    previous,
    setTail: (tail) => {
      currentTail = tail;
      projectExtractionTails.set(projectId, tail);
      void tail.finally(() => {
        if (projectExtractionTails.get(projectId) === currentTail) {
          projectExtractionTails.delete(projectId);
        }
      });
    },
    operation,
  });
}

export function withGlobalAgentMemoryLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = globalOperationTail;
  return withQueuedLock({
    previous,
    setTail: (tail) => {
      globalOperationTail = tail;
    },
    operation,
  });
}
