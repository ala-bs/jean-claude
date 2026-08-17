import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_MEMORY_MAX_CONTEXT_CHARS,
  type AgentMemoryEvent,
  type AgentMemoryExtractionRun,
} from '@shared/agent-memory-types';

import {
  appendAgentMemoryEvent,
  atomicWriteAgentMemoryJson,
  atomicWriteAgentMemoryMarkdown,
  ensureAgentMemoryGlobalStorage,
  ensureProjectAgentMemoryStorage,
  getAgentMemoryGlobalPaths,
  getAgentMemoryProjectKey,
  getAgentMemoryProjectPaths,
  getAgentMemoryRootDir,
  InvalidAgentMemoryEventLogError,
  InvalidAgentMemoryEventRecordError,
  readAgentMemoryEventPage,
  readAgentMemoryRunIndex,
  readAgentMemoryRunTiming,
  readPendingAgentMemoryEvents,
  recordAgentMemoryRunTiming,
  withGlobalAgentMemoryLock,
  withProjectAgentMemoryLock,
  writeAgentMemoryRunRecord,
} from './agent-memory-storage';

let homeDirectory: string;

function event(overrides: Partial<AgentMemoryEvent> = {}): AgentMemoryEvent {
  return {
    schemaVersion: 1,
    id: 'event-1',
    sourceId: 'source-1',
    source: 'task-review',
    projectId: 'project-1',
    taskId: 'task-1',
    stepId: 'step-1',
    text: 'Prefer focused tests.',
    context: {
      selectedText: null,
      filePath: null,
      lineStart: null,
      lineEnd: null,
      presets: [],
    },
    createdAt: '2026-07-18T12:00:00.000Z',
    redactions: [],
    ...overrides,
  } as AgentMemoryEvent;
}

function run(
  overrides: Partial<AgentMemoryExtractionRun> & Pick<AgentMemoryExtractionRun, 'id'>,
): AgentMemoryExtractionRun {
  return {
    schemaVersion: 1,
    scope: 'global',
    trigger: 'scheduled',
    backend: 'claude-code',
    model: 'haiku',
    thinkingEffort: 'default',
    status: 'succeeded',
    eventRanges: [],
    proposedItemCount: 1,
    acceptedItemCount: 1,
    startedAt: '2026-07-19T08:00:00.000Z',
    completedAt: '2026-07-19T08:00:01.000Z',
    durationMs: 1_000,
    error: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  homeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'jc-agent-memory-storage-'),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (homeDirectory) {
    await fs.rm(homeDirectory, { force: true, recursive: true });
  }
});

describe('agent memory paths and canonical writes', () => {
  it('builds exact global and project layout', () => {
    const root = path.join(homeDirectory, '.jean-claude', 'memory');
    expect(getAgentMemoryRootDir(homeDirectory)).toBe(root);
    expect(getAgentMemoryGlobalPaths(homeDirectory)).toEqual({
      directory: path.join(root, 'global'),
      profileJson: path.join(root, 'global', 'profile.json'),
      profileMarkdown: path.join(root, 'global', 'profile.md'),
      runsDirectory: path.join(root, 'global', 'runs'),
    });
    expect(getAgentMemoryProjectPaths('project-1', homeDirectory)).toEqual({
      directory: path.join(root, 'projects', 'project-1'),
      metadataJson: path.join(root, 'projects', 'project-1', 'project.json'),
      eventsDirectory: path.join(root, 'projects', 'project-1', 'events'),
      itemsJson: path.join(root, 'projects', 'project-1', 'memory-items.json'),
      memoryMarkdown: path.join(root, 'projects', 'project-1', 'project-memory.md'),
      extractionStateJson: path.join(
        root,
        'projects',
        'project-1',
        'extraction-state.json',
      ),
      publicationJournalJson: path.join(
        root,
        'projects',
        'project-1',
        'publication-journal.json',
      ),
      runsDirectory: path.join(root, 'projects', 'project-1', 'runs'),
    });
  });

  it.each(['', '..', '../project', 'team/project', '项目', 'Project']) (
    'hashes unsafe project key %j deterministically',
    (projectId) => {
      const key = getAgentMemoryProjectKey(projectId);
      expect(key).toMatch(/^\.hashed-[a-f0-9]{32}$/);
      expect(getAgentMemoryProjectKey(projectId)).toBe(key);
    },
  );

  it('creates canonical global and project files and directories', async () => {
    await ensureAgentMemoryGlobalStorage({ homeDirectory });
    await ensureProjectAgentMemoryStorage({
      projectId: 'project-1',
      name: 'Jean-Claude',
      sourcePath: '/projects/jean-claude',
      homeDirectory,
    });

    const global = getAgentMemoryGlobalPaths(homeDirectory);
    const project = getAgentMemoryProjectPaths('project-1', homeDirectory);
    await expect(fs.readdir(global.directory)).resolves.toEqual([
      'profile.json',
      'profile.md',
      'runs',
    ]);
    await expect(fs.readdir(project.directory)).resolves.toEqual([
      'events',
      'extraction-state.json',
      'memory-items.json',
      'project-memory.md',
      'project.json',
      'runs',
    ]);
  });

  it('uses sibling temporary files and rename for JSON and Markdown writes', async () => {
    await ensureAgentMemoryGlobalStorage({ homeDirectory });
    const paths = getAgentMemoryGlobalPaths(homeDirectory);
    const rename = vi.spyOn(fs, 'rename');

    await atomicWriteAgentMemoryJson({
      rootDirectory: paths.directory,
      filePath: paths.profileJson,
      value: { schemaVersion: 1, items: [] },
    });
    await atomicWriteAgentMemoryMarkdown({
      rootDirectory: paths.directory,
      filePath: paths.profileMarkdown,
      content: '# Profile\n',
    });

    expect(rename).toHaveBeenCalledTimes(2);
    for (const [temporaryPath, destinationPath] of rename.mock.calls) {
      expect(path.dirname(String(temporaryPath))).toBe(
        path.dirname(String(destinationPath)),
      );
    }
  });

  it('rejects managed parent and nested symlinks', async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'jc-agent-memory-outside-'),
    );
    await fs.mkdir(path.join(homeDirectory, '.jean-claude'));
    await fs.symlink(outside, path.join(homeDirectory, '.jean-claude', 'memory'));
    try {
      await expect(
        ensureProjectAgentMemoryStorage({
          projectId: 'project-1',
          name: 'Unsafe',
          sourcePath: '/unsafe',
          homeDirectory,
        }),
      ).rejects.toThrow('Unsafe agent memory directory');
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { force: true, recursive: true });
    }
  });

  it('rejects a symlink at the managed .jean-claude ancestor', async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'jc-agent-memory-ancestor-outside-'),
    );
    await fs.symlink(outside, path.join(homeDirectory, '.jean-claude'));
    try {
      await expect(
        ensureAgentMemoryGlobalStorage({ homeDirectory }),
      ).rejects.toThrow('Unsafe agent memory directory');
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { force: true, recursive: true });
    }
  });
});

describe('agent memory run index', () => {
  it('persists no-op scheduler timing independently from run records', async () => {
    await recordAgentMemoryRunTiming({
      scope: 'project',
      projectId: 'project-1',
      attemptedAt: '2026-07-19T08:00:00.000Z',
      succeeded: true,
      homeDirectory,
    });

    await expect(
      readAgentMemoryRunTiming({
        scope: 'project',
        projectId: 'project-1',
        homeDirectory,
      }),
    ).resolves.toEqual({
      lastAttemptAt: '2026-07-19T08:00:00.000Z',
      lastSuccessAt: '2026-07-19T08:00:00.000Z',
    });
  });

  it('updates indexed run status without changing its sequence', async () => {
    await ensureAgentMemoryGlobalStorage({ homeDirectory });
    const paths = getAgentMemoryGlobalPaths(homeDirectory);
    const legacyPath = path.join(paths.runsDirectory, 'run-1.json');
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        run: run({
          id: 'run-1',
          status: 'running',
          acceptedItemCount: 0,
          completedAt: null,
          durationMs: null,
        }),
        consumedNominationIds: [],
        reviewedProjectRunKeys: [],
      }),
    );
    await expect(
      readAgentMemoryRunTiming({ scope: 'global', homeDirectory }),
    ).resolves.toEqual({
      lastAttemptAt: '2026-07-19T08:00:00.000Z',
      lastSuccessAt: null,
    });
    const recordsDirectory = path.join(paths.runsDirectory, 'records');
    const recordPath = path.join(recordsDirectory, 'run-1.json');
    const open = vi.spyOn(fs, 'open');

    await writeAgentMemoryRunRecord({
      fileName: 'run-1.json',
      homeDirectory,
      record: {
        run: run({
          id: 'run-1',
          status: 'failed',
          acceptedItemCount: 0,
          completedAt: '2026-07-19T08:05:00.000Z',
          error: { message: 'failed' },
        }),
        consumedNominationIds: [],
        reviewedProjectRunKeys: [],
      },
    });
    open.mockClear();
    await expect(
      readAgentMemoryRunIndex({ scope: 'global', homeDirectory }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'run-1', sequence: 1, status: 'failed' }),
    ]);
    expect(open.mock.calls.filter(([filePath]) => String(filePath) === recordPath)).toHaveLength(0);

    await writeAgentMemoryRunRecord({
      fileName: 'run-1.json',
      homeDirectory,
      record: {
        run: run({
          id: 'run-1',
          status: 'succeeded',
          startedAt: '2026-07-19T08:00:00.000Z',
          completedAt: '2026-07-19T08:05:00.000Z',
        }),
        consumedNominationIds: [],
        reviewedProjectRunKeys: [],
      },
    });

    await expect(
      readAgentMemoryRunTiming({ scope: 'global', homeDirectory }),
    ).resolves.toEqual({
      lastAttemptAt: '2026-07-19T08:00:00.000Z',
      lastSuccessAt: '2026-07-19T08:05:00.000Z',
    });
    const persisted = JSON.parse(await fs.readFile(recordPath, 'utf-8'));
    expect(persisted.run).toMatchObject({ sequence: 1, status: 'succeeded' });
  });

  it('migrates and rebuilds large legacy run sets with bounded read concurrency', async () => {
    await ensureAgentMemoryGlobalStorage({ homeDirectory });
    const paths = getAgentMemoryGlobalPaths(homeDirectory);
    for (let index = 0; index < 200; index += 1) {
      const id = `legacy-${String(index).padStart(3, '0')}`;
      await fs.writeFile(
        path.join(paths.runsDirectory, `${id}.json`),
        JSON.stringify({
          run: run({
            id,
            status: index === 199 ? 'failed' : 'succeeded',
            acceptedItemCount: index === 199 ? 0 : 1,
            startedAt: `2026-07-19T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00.000Z`,
            completedAt: `2026-07-19T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:01.000Z`,
            error: index === 199 ? { message: 'latest failed' } : null,
          }),
          consumedNominationIds: [],
          reviewedProjectRunKeys: [],
        }),
      );
    }
    const originalOpen = fs.open.bind(fs);
    let activeOpens = 0;
    let maxConcurrentOpens = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).includes(`${path.sep}records${path.sep}`)) {
        activeOpens += 1;
        maxConcurrentOpens = Math.max(maxConcurrentOpens, activeOpens);
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          return await originalOpen(...args);
        } finally {
          activeOpens -= 1;
        }
      }
      return originalOpen(...args);
    });

    const entries = await readAgentMemoryRunIndex({
      scope: 'global',
      homeDirectory,
    });

    expect(entries).toHaveLength(200);
    expect(entries[0]).toMatchObject({ id: 'legacy-199', status: 'failed' });
    expect(entries.map(({ sequence }) => sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    const persistedLegacy = JSON.parse(
      await fs.readFile(
        path.join(paths.runsDirectory, 'records', 'legacy-000.json'),
        'utf-8',
      ),
    );
    expect(persistedLegacy.run.sequence).toBe(1);
    expect(maxConcurrentOpens).toBeGreaterThan(1);
    expect(maxConcurrentOpens).toBeLessThanOrEqual(8);
    await expect(fs.readdir(paths.runsDirectory)).resolves.toEqual([
      'index.v1',
      'records',
    ]);
  });

  it('updates one indexed run repeatedly without reading historical run bodies', async () => {
    await ensureAgentMemoryGlobalStorage({ homeDirectory });
    const paths = getAgentMemoryGlobalPaths(homeDirectory);
    for (let index = 0; index < 200; index += 1) {
      const id = `historical-${String(index).padStart(3, '0')}`;
      await fs.writeFile(
        path.join(paths.runsDirectory, `${id}.json`),
        JSON.stringify({
          run: run({ id }),
          consumedNominationIds: [],
          reviewedProjectRunKeys: [],
        }),
      );
    }
    await readAgentMemoryRunIndex({ scope: 'global', homeDirectory });
    const open = vi.spyOn(fs, 'open');
    const updates: AgentMemoryExtractionRun[] = [
      run({
        id: 'newest-run',
        status: 'running',
        acceptedItemCount: 0,
        startedAt: '2026-07-20T08:00:00.000Z',
        completedAt: null,
        durationMs: null,
      }),
      run({
        id: 'newest-run',
        status: 'failed',
        acceptedItemCount: 0,
        startedAt: '2026-07-20T08:00:00.000Z',
        completedAt: '2026-07-20T08:01:00.000Z',
        error: { message: 'failed' },
      }),
      run({
        id: 'newest-run',
        status: 'succeeded',
        startedAt: '2026-07-20T08:00:00.000Z',
        completedAt: '2026-07-20T08:02:00.000Z',
      }),
    ];
    for (const value of updates) {
      await writeAgentMemoryRunRecord({
        fileName: 'newest-run.json',
        record: {
          run: value,
          consumedNominationIds: [],
          reviewedProjectRunKeys: [],
        },
        homeDirectory,
      });
    }

    const entries = await readAgentMemoryRunIndex({
      scope: 'global',
      homeDirectory,
    });

    expect(entries).toHaveLength(201);
    expect(entries[0]).toMatchObject({
      id: 'newest-run',
      sequence: 201,
      status: 'succeeded',
      completedAt: '2026-07-20T08:02:00.000Z',
    });
    expect(
      open.mock.calls.filter(([filePath]) =>
        String(filePath).includes(
          `${path.sep}records${path.sep}historical-`,
        ),
      ),
    ).toHaveLength(0);
  });
});

describe('agent memory event storage', () => {
  it('appends complete redacted JSONL and suppresses duplicate source IDs', async () => {
    const first = await appendAgentMemoryEvent({
      event: event({ text: 'Authorization: Bearer disk-secret-value' }),
      homeDirectory,
    });
    const duplicate = await appendAgentMemoryEvent({
      event: event({
        id: 'event-2',
        createdAt: '2026-07-19T12:00:00.000Z',
      }),
      homeDirectory,
    });

    expect(first.appended).toBe(true);
    expect(duplicate.appended).toBe(false);
    const content = await fs.readFile(first.filePath, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content).not.toContain('disk-secret-value');
    expect(content).toContain('[REDACTED:bearer-token]');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('normalizes aggregate oversized context before disk and marks truncation', async () => {
    await appendAgentMemoryEvent({
      homeDirectory,
      event: {
        ...event(),
        source: 'pr-reply',
        context: {
          pullRequestId: '42',
          threadId: 'thread-1',
          filePath: 'src/app.ts',
          lineStart: 1,
          lineEnd: 1,
          selectedLines: 'a'.repeat(15_000),
          threadContext: 'b'.repeat(30_000),
        },
      } as AgentMemoryEvent,
    });

    const [stored] = (
      await readAgentMemoryEventPage({ projectId: 'project-1', homeDirectory })
    ).items;
    const aggregate = Object.values(stored.context!).reduce<number>(
      (total, value) => total + (typeof value === 'string' ? value.length : 0),
      0,
    );
    expect(stored.contextTruncated).toBe(true);
    expect(aggregate).toBeLessThanOrEqual(AGENT_MEMORY_MAX_CONTEXT_CHARS);
  });

  it('deduplicates a valid trailing record without a newline', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const content = await fs.readFile(first.filePath, 'utf-8');
    await fs.writeFile(first.filePath, content.trimEnd(), 'utf-8');

    const duplicate = await appendAgentMemoryEvent({
      event: event({ id: 'event-2' }),
      homeDirectory,
    });

    expect(duplicate.appended).toBe(false);
    const repaired = await fs.readFile(first.filePath, 'utf-8');
    expect(repaired.endsWith('\n')).toBe(true);
    expect(repaired.trim().split('\n')).toHaveLength(1);
  });

  it('preserves a valid trailing record when newline repair fails', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const content = (await fs.readFile(first.filePath, 'utf-8')).trimEnd();
    await fs.writeFile(first.filePath, content, 'utf-8');
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('repair failed'));

    await expect(
      appendAgentMemoryEvent({ event: event({ id: 'event-2' }), homeDirectory }),
    ).rejects.toThrow('repair failed');
    await expect(fs.readFile(first.filePath, 'utf-8')).resolves.toBe(content);
  });

  it('preserves and skips a syntactically valid future-schema trailing record', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const futureRecord = {
      schemaVersion: 2,
      id: 'future-event',
      sourceId: 'future-source',
      source: 'future-source-type',
      text: 'Future event body',
    };
    await fs.appendFile(first.filePath, JSON.stringify(futureRecord), 'utf-8');

    await appendAgentMemoryEvent({
      event: event({ id: 'event-2', sourceId: 'source-2' }),
      homeDirectory,
    });

    const content = await fs.readFile(first.filePath, 'utf-8');
    expect(content).toContain(JSON.stringify(futureRecord));
    expect(content.trim().split('\n')).toHaveLength(3);
    await expect(
      readAgentMemoryEventPage({ projectId: 'project-1', homeDirectory }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it.each([0, 1])(
    'preserves malformed schema version %i records and raises a controlled error',
    async (schemaVersion) => {
      const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
      const malformedRecord = {
        schemaVersion,
        id: 'malformed-event',
        sourceId: 'malformed-source',
        text: 'must-not-appear-in-error',
      };
      await fs.appendFile(first.filePath, JSON.stringify(malformedRecord), 'utf-8');

      let thrown: unknown;
      try {
        await appendAgentMemoryEvent({
          event: event({ id: 'event-2', sourceId: 'source-2' }),
          homeDirectory,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidAgentMemoryEventRecordError);
      expect(String(thrown)).not.toContain('must-not-appear-in-error');
      await expect(fs.readFile(first.filePath, 'utf-8')).resolves.toContain(
        JSON.stringify(malformedRecord),
      );
    },
  );

  it('preserves invalid complete JSON and raises a controlled error', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const invalidLine = '{"api_key":"must-not-appear-in-error",}\n';
    await fs.appendFile(first.filePath, invalidLine, 'utf-8');

    await expect(
      appendAgentMemoryEvent({
        event: event({ id: 'event-2', sourceId: 'source-2' }),
        homeDirectory,
      }),
    ).rejects.toBeInstanceOf(InvalidAgentMemoryEventLogError);
    await expect(fs.readFile(first.filePath, 'utf-8')).resolves.toContain(
      invalidLine,
    );
    try {
      await appendAgentMemoryEvent({
        event: event({ id: 'event-3', sourceId: 'source-3' }),
        homeDirectory,
      });
    } catch (error) {
      expect(String(error)).not.toContain('must-not-appear-in-error');
    }
  });

  it('removes an incomplete trailing line before a later append', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    await fs.appendFile(first.filePath, '{"incomplete":', 'utf-8');

    await appendAgentMemoryEvent({
      event: event({
        id: 'event-2',
        sourceId: 'source-2',
        createdAt: '2026-07-18T13:00:00.000Z',
      }),
      homeDirectory,
    });

    const content = await fs.readFile(first.filePath, 'utf-8');
    expect(content).not.toContain('incomplete');
    expect(content.trim().split('\n')).toHaveLength(2);
  });

  it('ignores an incomplete trailing line and pages newest evidence', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    await appendAgentMemoryEvent({
      event: event({
        id: 'event-2',
        sourceId: 'source-2',
        createdAt: '2026-07-18T13:00:00.000Z',
      }),
      homeDirectory,
    });
    await fs.appendFile(first.filePath, '{"partial":', 'utf-8');

    const page = await readAgentMemoryEventPage({
      projectId: 'project-1',
      homeDirectory,
      page: 0,
      pageSize: 1,
    });
    expect(page).toMatchObject({ page: 0, pageSize: 1, total: 2 });
    expect(page.items[0].id).toBe('event-2');
  });

  it('returns pending complete events and byte ranges after checkpoints', async () => {
    const first = event();
    const second = event({ id: 'event-2', sourceId: 'source-2' });
    const firstAppend = await appendAgentMemoryEvent({
      event: first,
      homeDirectory,
    });
    await appendAgentMemoryEvent({ event: second, homeDirectory });
    const firstLineBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`);

    const pending = await readPendingAgentMemoryEvents({
      projectId: 'project-1',
      homeDirectory,
      state: {
        schemaVersion: 1,
        files: { [path.basename(firstAppend.filePath)]: firstLineBytes },
        lastExtractedAt: null,
        projectionPending: false,
      },
    });

    expect(pending.events.map((entry) => entry.id)).toEqual(['event-2']);
    expect(pending.ranges).toEqual([
      {
        fileName: '2026-07-18.jsonl',
        fromOffset: firstLineBytes,
        toOffset: (await fs.stat(firstAppend.filePath)).size,
        eventCount: 1,
      },
    ]);
  });

  it('bounds pending snapshots on complete JSONL event boundaries', async () => {
    const first = await appendAgentMemoryEvent({
      event: event({ text: '1234' }),
      homeDirectory,
    });
    await appendAgentMemoryEvent({
      event: event({
        id: 'event-2',
        sourceId: 'source-2',
        text: 'second event',
      }),
      homeDirectory,
    });
    const state = {
      schemaVersion: 1 as const,
      files: {},
      lastExtractedAt: null,
      projectionPending: false,
    };
    const bounded = await readPendingAgentMemoryEvents({
      projectId: 'project-1',
      homeDirectory,
      state,
      maxEvents: 10,
      maxEvidenceChars: 5,
    });
    expect(bounded.events).toEqual([
      expect.objectContaining({ id: 'event-1', text: '1234' }),
    ]);
    const firstLineEnd = (await fs.readFile(first.filePath)).indexOf(0x0a) + 1;
    expect(bounded.ranges).toEqual([
      expect.objectContaining({
        fromOffset: 0,
        toOffset: firstLineEnd,
        eventCount: 1,
      }),
    ]);

    const remainder = await readPendingAgentMemoryEvents({
      projectId: 'project-1',
      homeDirectory,
      state: {
        ...state,
        files: { '2026-07-18.jsonl': firstLineEnd },
      },
      maxEvents: 1,
      maxEvidenceChars: 100,
    });
    expect(remainder.events.map((entry) => entry.id)).toEqual(['event-2']);

    const oversized = await readPendingAgentMemoryEvents({
      projectId: 'project-1',
      homeDirectory,
      state,
      maxEvents: 1,
      maxEvidenceChars: 3,
    });
    expect(oversized.events).toEqual([
      expect.objectContaining({ id: 'event-1', text: '123', textTruncated: true }),
    ]);
    expect(oversized.ranges).toEqual([
      expect.objectContaining({
        fromOffset: 0,
        toOffset: firstLineEnd,
        eventCount: 1,
      }),
    ]);
  });

  it('does not parse unchanged event history during append', async () => {
    for (let index = 0; index < 6; index += 1) {
      await appendAgentMemoryEvent({
        event: event({
          id: `history-event-${index}`,
          sourceId: `history-source-${index}`,
          createdAt: `2026-06-${String(10 + index).padStart(2, '0')}T12:00:00.000Z`,
        }),
        homeDirectory,
      });
    }
    const readFile = vi.spyOn(fs, 'readFile');

    await appendAgentMemoryEvent({
      event: event({
        id: 'new-event',
        sourceId: 'new-source',
        createdAt: '2026-06-15T13:00:00.000Z',
      }),
      homeDirectory,
    });

    expect(
      readFile.mock.calls.filter(([filePath]) =>
        String(filePath).endsWith('.jsonl'),
      ),
    ).toHaveLength(0);
    expect(
      readFile.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}.index${path.sep}days${path.sep}`),
      ).length,
    ).toBeLessThanOrEqual(1);
    expect(
      readFile.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}.index${path.sep}sources${path.sep}`),
      ).length,
    ).toBeLessThanOrEqual(1);
  });

  it('pages by indexed offsets without loading retained event files', async () => {
    for (let index = 0; index < 6; index += 1) {
      await appendAgentMemoryEvent({
        event: event({
          id: `event-${index}`,
          sourceId: `source-${index}`,
          createdAt: `2026-07-${String(10 + index).padStart(2, '0')}T12:00:00.000Z`,
        }),
        homeDirectory,
      });
    }
    const open = vi.spyOn(fs, 'open');

    const page = await readAgentMemoryEventPage({
      projectId: 'project-1',
      homeDirectory,
      page: 0,
      pageSize: 2,
    });

    expect(page.items.map((entry) => entry.id)).toEqual(['event-5', 'event-4']);
    expect(
      open.mock.calls.filter(([filePath]) =>
        String(filePath).endsWith('.jsonl'),
      ),
    ).toHaveLength(2);
    expect(
      open.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}.index${path.sep}days${path.sep}`),
      ),
    ).toHaveLength(2);
    expect(
      open.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}.index${path.sep}sources${path.sep}`),
      ),
    ).toHaveLength(0);
  });

  it('removes replaced immutable day objects after manifest publication', async () => {
    await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const projectPaths = getAgentMemoryProjectPaths('project-1', homeDirectory);
    const indexDirectory = path.join(projectPaths.eventsDirectory, '.index');
    const manifestPath = path.join(indexDirectory, 'manifest.json');
    const firstManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    const firstObject = firstManifest.files['2026-07-18.jsonl'].object;

    await appendAgentMemoryEvent({
      event: event({ id: 'event-2', sourceId: 'source-2' }),
      homeDirectory,
    });

    const nextManifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    const nextObject = nextManifest.files['2026-07-18.jsonl'].object;
    expect(nextObject).not.toBe(firstObject);
    await expect(
      fs.readdir(path.join(indexDirectory, 'days')),
    ).resolves.toEqual([nextObject]);
  });

  it('rebuilds missing or stale derived indexes from canonical events', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const projectPaths = getAgentMemoryProjectPaths('project-1', homeDirectory);
    await fs.rm(path.join(projectPaths.eventsDirectory, '.index'), {
      force: true,
      recursive: true,
    });
    await expect(
      appendAgentMemoryEvent({ event: event({ id: 'duplicate-1' }), homeDirectory }),
    ).resolves.toMatchObject({ appended: false });

    const externalEvent = event({
      id: 'external-event',
      sourceId: 'external-source',
    });
    await fs.appendFile(first.filePath, `${JSON.stringify(externalEvent)}\n`, 'utf-8');
    await expect(
      appendAgentMemoryEvent({
        event: event({ id: 'duplicate-2', sourceId: 'external-source' }),
        homeDirectory,
      }),
    ).resolves.toMatchObject({ appended: false });
  });

  it('rebuilds structurally valid day and source index corruption', async () => {
    await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const projectPaths = getAgentMemoryProjectPaths('project-1', homeDirectory);
    const indexDirectory = path.join(projectPaths.eventsDirectory, '.index');
    let manifest = JSON.parse(
      await fs.readFile(path.join(indexDirectory, 'manifest.json'), 'utf-8'),
    );
    const dayPath = path.join(
      indexDirectory,
      'days',
      manifest.files['2026-07-18.jsonl'].object,
    );
    const day = JSON.parse(await fs.readFile(dayPath, 'utf-8'));
    await fs.writeFile(
      dayPath,
      `${JSON.stringify({ ...day, records: [] }, null, 2)}\n`,
      'utf-8',
    );

    await expect(
      readAgentMemoryEventPage({ projectId: 'project-1', homeDirectory }),
    ).resolves.toMatchObject({ total: 1 });

    const sourceDirectory = path.join(indexDirectory, 'sources');
    manifest = JSON.parse(
      await fs.readFile(path.join(indexDirectory, 'manifest.json'), 'utf-8'),
    );
    const [sourceReference] = Object.values(manifest.sourceShards) as Array<{
      object: string;
    }>;
    await fs.writeFile(
      path.join(sourceDirectory, sourceReference.object),
      `${JSON.stringify({ schemaVersion: 2, entries: {} }, null, 2)}\n`,
      'utf-8',
    );
    await expect(
      appendAgentMemoryEvent({ event: event({ id: 'duplicate' }), homeDirectory }),
    ).resolves.toMatchObject({ appended: false });
  });

  it('recovers canonical events after interrupted manifest publication', async () => {
    await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const originalRename = fs.rename;
    let interruptManifest = true;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (interruptManifest && String(to).endsWith('manifest.json')) {
        interruptManifest = false;
        throw new Error('simulated power loss');
      }
      return originalRename(from, to);
    });

    await expect(
      appendAgentMemoryEvent({
        event: event({ id: 'event-2', sourceId: 'source-2' }),
        homeDirectory,
      }),
    ).rejects.toThrow('simulated power loss');
    vi.restoreAllMocks();

    await expect(
      appendAgentMemoryEvent({
        event: event({ id: 'duplicate', sourceId: 'source-2' }),
        homeDirectory,
      }),
    ).resolves.toMatchObject({ appended: false });
    await expect(
      readAgentMemoryEventPage({ projectId: 'project-1', homeDirectory }),
    ).resolves.toMatchObject({ total: 2 });
  });

  it('stops pending ranges before a future-schema record', async () => {
    const first = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const future = {
      schemaVersion: 2,
      id: 'future-event',
      sourceId: 'future-source',
      source: 'future-source-type',
      text: 'Future body',
    };
    const afterFuture = event({ id: 'event-2', sourceId: 'source-2' });
    await fs.appendFile(
      first.filePath,
      `${JSON.stringify(future)}\n${JSON.stringify(afterFuture)}\n`,
      'utf-8',
    );
    const firstLineEnd = (await fs.readFile(first.filePath)).indexOf(0x0a) + 1;
    const state = {
      schemaVersion: 1 as const,
      files: {},
      lastExtractedAt: null,
      projectionPending: false,
    };

    const pending = await readPendingAgentMemoryEvents({
      projectId: 'project-1',
      homeDirectory,
      state,
    });
    expect(pending.events.map((entry) => entry.id)).toEqual(['event-1']);
    expect(pending.ranges).toEqual([
      {
        fileName: '2026-07-18.jsonl',
        fromOffset: 0,
        toOffset: firstLineEnd,
        eventCount: 1,
      },
    ]);

    await expect(
      readPendingAgentMemoryEvents({
        projectId: 'project-1',
        homeDirectory,
        state: { ...state, files: { '2026-07-18.jsonl': firstLineEnd } },
      }),
    ).resolves.toEqual({ events: [], ranges: [] });
  });
});

describe('agent memory permissions', () => {
  it('creates and corrects managed directories and files to private modes', async () => {
    await ensureAgentMemoryGlobalStorage({ homeDirectory });
    const append = await appendAgentMemoryEvent({ event: event(), homeDirectory });
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    const projectPaths = getAgentMemoryProjectPaths('project-1', homeDirectory);
    const indexDirectory = path.join(projectPaths.eventsDirectory, '.index');

    await fs.chmod(globalPaths.profileJson, 0o644);
    await fs.chmod(projectPaths.eventsDirectory, 0o755);
    await ensureAgentMemoryGlobalStorage({ homeDirectory });
    await ensureProjectAgentMemoryStorage({ projectId: 'project-1', homeDirectory });

    const directoryPaths = [
      path.join(homeDirectory, '.jean-claude'),
      getAgentMemoryRootDir(homeDirectory),
      globalPaths.directory,
      globalPaths.runsDirectory,
      projectPaths.directory,
      projectPaths.eventsDirectory,
      projectPaths.runsDirectory,
      indexDirectory,
      path.join(indexDirectory, 'days'),
      path.join(indexDirectory, 'sources'),
    ];
    for (const directoryPath of directoryPaths) {
      expect((await fs.stat(directoryPath)).mode & 0o777).toBe(0o700);
    }

    const filePaths = [
      globalPaths.profileJson,
      globalPaths.profileMarkdown,
      projectPaths.metadataJson,
      projectPaths.itemsJson,
      projectPaths.memoryMarkdown,
      projectPaths.extractionStateJson,
      append.filePath,
      path.join(indexDirectory, 'manifest.json'),
    ];
    filePaths.push(
      ...(await fs.readdir(path.join(indexDirectory, 'days'))).map((fileName) =>
        path.join(indexDirectory, 'days', fileName),
      ),
    );
    const sourceIndexFiles = await fs.readdir(path.join(indexDirectory, 'sources'));
    filePaths.push(
      ...sourceIndexFiles.map((fileName) =>
        path.join(indexDirectory, 'sources', fileName),
      ),
    );
    for (const filePath of filePaths) {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('agent memory operation locks', () => {
  it('serializes project operations without blocking another project', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withProjectAgentMemoryLock('project-1', async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = withProjectAgentMemoryLock('project-1', async () => {
      order.push('second');
    });
    await withProjectAgentMemoryLock('project-2', async () => {
      order.push('other');
    });
    expect(order).toEqual(['first-start', 'other']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second']);
  });

  it('serializes global operations', async () => {
    const order: string[] = [];
    const first = withGlobalAgentMemoryLock(async () => {
      order.push('first');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('release');
    });
    const second = withGlobalAgentMemoryLock(async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'release', 'second']);
  });
});
