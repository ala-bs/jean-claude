import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import {
  AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS,
  AGENT_MEMORY_MAX_EVENT_TEXT_CHARS,
  agentMemoryEventSchema,
} from '@shared/agent-memory-types';

import {
  AGENT_MESSAGE_LATEST_RESULT_INDEX,
  down,
  up,
} from './079_migrate_agent_memory';
import { getAgentMemoryProjectPaths } from '../../services/agent-memory-storage';

let db: Kysely<unknown>;
let homeDirectory: string;
let createIndexColumns: ReturnType<typeof vi.fn>;
let createIndexExecute: ReturnType<typeof vi.fn>;
let dropIndexExecute: ReturnType<typeof vi.fn>;
const project = {
  id: 'project-1',
  name: 'Jean-Claude',
  path: '/projects/jean-claude',
};
const restartResidueCases = [
  {
    label: 'failed-active',
    pathFor: (activeTree: string) =>
      path.join(path.dirname(activeTree), '.agent-memory-failed-active-project-1'),
  },
  {
    label: 'quarantined backup',
    pathFor: (activeTree: string) =>
      path.join(
        path.dirname(activeTree),
        '.agent-memory-cleanup-076',
        '.agent-memory-backup-project-1',
      ),
  },
] as const;

function createMigrationDb(
  projects: Array<{ id: string; name: string; path: string }> = [project],
): Kysely<unknown> {
  return {
    selectFrom: () => ({
      select: () => ({ execute: async () => projects }),
    }),
    schema: {
      createIndex: (name: string) => {
        expect(name).toBe(AGENT_MESSAGE_LATEST_RESULT_INDEX);
        return {
          ifNotExists: () => ({
            on: (table: string) => {
              expect(table).toBe('agent_messages');
              return { columns: createIndexColumns };
            },
          }),
        };
      },
      dropIndex: (name: string) => {
        expect(name).toBe(AGENT_MESSAGE_LATEST_RESULT_INDEX);
        return {
          ifExists: () => ({ execute: dropIndexExecute }),
        };
      },
    },
  } as unknown as Kysely<unknown>;
}

function oldRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-1',
    createdAt: '2026-07-17T23:30:00-02:00',
    source: 'task-review-comment',
    taskId: 'task-1',
    projectId: project.id,
    comment: {
      body: 'Prefer explicit names; token=secret-value',
      selectedText: 'const token = "secret-value";',
      filePath: 'src/auth.ts',
      lineStart: 10,
      lineEnd: 12,
      presets: ['clarity'],
    },
    fileSnapshot: { filePath: 'src/auth.ts', content: 'must disappear' },
    metadata: { taskPrompt: 'must disappear', taskName: 'Old task' },
    context: { branchName: 'must-disappear' },
    ...overrides,
  };
}

async function writeOldTree(
  records: unknown[],
  targetProject = project,
): Promise<string> {
  const paths = getAgentMemoryProjectPaths(targetProject.id, homeDirectory);
  await fs.mkdir(path.join(paths.directory, 'user-reviews'), { recursive: true });
  await fs.mkdir(path.join(paths.directory, 'user-preferences-history'), {
    recursive: true,
  });
  await fs.writeFile(
    paths.metadataJson,
    `${JSON.stringify({
      id: targetProject.id,
      name: targetProject.name,
      sourcePath: targetProject.path,
    })}\n`,
  );
  await fs.writeFile(
    path.join(paths.directory, 'user-reviews', 'reviews.jsonl'),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  await fs.writeFile(
    path.join(paths.directory, 'user-reviews-state.json'),
    '{"files":{}}\n',
  );
  await fs.writeFile(
    path.join(paths.directory, 'user-preferences.md'),
    '# Never import this\n',
  );
  await fs.writeFile(
    path.join(paths.directory, 'user-preferences-history', 'run.json'),
    '{"old":true}\n',
  );
  return paths.directory;
}

beforeEach(async () => {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  homeDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'jc-agent-memory-migration-'),
  );
  createIndexExecute = vi.fn(async () => undefined);
  createIndexColumns = vi.fn(() => ({ execute: createIndexExecute }));
  dropIndexExecute = vi.fn(async () => undefined);
  db = createMigrationDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(homeDirectory, { force: true, recursive: true });
});

describe('079_migrate_agent_memory', () => {
  it('creates and rolls back the latest-result lookup index', async () => {
    await up(db, homeDirectory);

    expect(createIndexColumns).toHaveBeenCalledWith([
      'stepId',
      'type',
      'messageIndex desc',
    ]);
    expect(createIndexExecute).toHaveBeenCalledOnce();

    await down(db);
    expect(dropIndexExecute).toHaveBeenCalledOnce();
  });

  it('preserves legacy files when index creation fails', async () => {
    const projectDirectory = await writeOldTree([oldRecord()]);
    createIndexExecute.mockRejectedValueOnce(new Error('index failed'));

    await expect(up(db, homeDirectory)).rejects.toThrow('index failed');

    await expect(
      fs.readFile(
        path.join(projectDirectory, 'user-reviews', 'reviews.jsonl'),
        'utf-8',
      ),
    ).resolves.toContain('review-1');
    await expect(
      fs.stat(path.join(projectDirectory, 'events')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.readdir(path.dirname(projectDirectory)),
    ).resolves.not.toEqual(
      expect.arrayContaining([
        '.agent-memory-staging-project-1',
        '.agent-memory-backup-project-1',
        '.agent-memory-failed-active-project-1',
        '.agent-memory-cleanup-076',
      ]),
    );
  });

  it('retries migration after a transient index failure', async () => {
    const projectDirectory = await writeOldTree([oldRecord()]);
    createIndexExecute.mockRejectedValueOnce(new Error('index failed'));

    await expect(up(db, homeDirectory)).rejects.toThrow('index failed');
    await expect(up(db, homeDirectory)).resolves.toBeUndefined();

    expect(createIndexExecute).toHaveBeenCalledTimes(2);
    await expect(
      fs.readFile(
        path.join(projectDirectory, 'events', '2026-07-18.jsonl'),
        'utf-8',
      ),
    ).resolves.toContain('review-1');
    await expect(
      fs.stat(path.join(projectDirectory, 'user-reviews')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('converts only task reviews into redacted UTC-grouped Agent Memory events', async () => {
    await writeOldTree([
      oldRecord(),
      oldRecord({ id: 'pr-1', source: 'pr-file-comment' }),
    ]);
    const paths = getAgentMemoryProjectPaths(project.id, homeDirectory);

    await up(db, homeDirectory);

    const lines = (
      await fs.readFile(path.join(paths.eventsDirectory, '2026-07-18.jsonl'), 'utf-8')
    )
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const event = agentMemoryEventSchema.parse(JSON.parse(lines[0]));
    expect(event).toMatchObject({
      schemaVersion: 1,
      source: 'task-review',
      sourceId: 'review-1',
      projectId: project.id,
      taskId: 'task-1',
      createdAt: '2026-07-18T01:30:00.000Z',
      text: 'Prefer explicit names; token=[REDACTED:credential-assignment]',
      context: {
        selectedText:
          'const token = "[REDACTED:credential-assignment]";',
        filePath: 'src/auth.ts',
        lineStart: 10,
        lineEnd: 12,
        presets: ['clarity'],
      },
    });
    expect(event.redactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain('must disappear');
    expect(JSON.stringify(event)).not.toContain('must-disappear');
  });

  it('truncates oversized migrated review text and marks it for extraction', async () => {
    await writeOldTree([
      oldRecord({
        comment: {
          ...(oldRecord().comment as Record<string, unknown>),
          body: 'x'.repeat(AGENT_MEMORY_MAX_EVENT_TEXT_CHARS + 100),
          selectedText: 'y'.repeat(AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS + 100),
        },
      }),
    ]);
    const paths = getAgentMemoryProjectPaths(project.id, homeDirectory);

    await up(db, homeDirectory);

    const event = agentMemoryEventSchema.parse(
      JSON.parse(
        (await fs.readFile(
          path.join(paths.eventsDirectory, '2026-07-18.jsonl'),
          'utf-8',
        )).trim(),
      ),
    );
    expect(event.text).toHaveLength(AGENT_MEMORY_MAX_EVENT_TEXT_CHARS);
    expect(event.textTruncated).toBe(true);
    if (event.source !== 'task-review') throw new Error('Expected task review');
    expect(event.context.selectedText).toHaveLength(
      AGENT_MEMORY_MAX_CONTEXT_FIELD_CHARS,
    );
    expect(event.contextTruncated).toBe(true);
  });

  it('creates complete empty structured state and removes every old artifact', async () => {
    await writeOldTree([]);
    const paths = getAgentMemoryProjectPaths(project.id, homeDirectory);

    await up(db, homeDirectory);

    await expect(fs.readFile(paths.itemsJson, 'utf-8')).resolves.toBe(
      `${JSON.stringify({ schemaVersion: 1, items: [] }, null, 2)}\n`,
    );
    await expect(fs.readFile(paths.memoryMarkdown, 'utf-8')).resolves.toBe('');
    await expect(fs.readFile(paths.extractionStateJson, 'utf-8')).resolves.toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          files: {},
          lastExtractedAt: null,
          projectionPending: false,
        },
        null,
        2,
      )}\n`,
    );
    await expect(fs.readdir(paths.runsDirectory)).resolves.toEqual([]);
    await expect(
      fs.stat(path.join(paths.directory, 'user-reviews')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(paths.directory, 'user-preferences.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(paths.directory, 'user-reviews-state.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(paths.directory, 'user-preferences-history')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('migrates retained orphan project memory absent from the database', async () => {
    const orphanProject = {
      id: 'deleted-project',
      name: 'Deleted project',
      path: '/projects/deleted',
    };
    await writeOldTree(
      [
        oldRecord({ id: 'orphan-review', projectId: orphanProject.id }),
        oldRecord({
          id: 'orphan-pr-comment',
          projectId: orphanProject.id,
          source: 'pr-file-comment',
        }),
      ],
      orphanProject,
    );
    const paths = getAgentMemoryProjectPaths(orphanProject.id, homeDirectory);

    await up(db, homeDirectory);

    const eventContent = await fs.readFile(
      path.join(paths.eventsDirectory, '2026-07-18.jsonl'),
      'utf-8',
    );
    expect(eventContent).toContain('orphan-review');
    expect(eventContent).not.toContain('orphan-pr-comment');
    expect(eventContent).not.toContain('secret-value');
    await expect(
      fs.stat(path.join(paths.directory, 'user-reviews')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(paths.directory, 'user-preferences.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(paths.directory, 'user-reviews-state.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(paths.directory, 'user-preferences-history')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on an unknown project directory without mutating valid memory', async () => {
    const validTree = await writeOldTree([oldRecord()]);
    const unknownTree = path.join(path.dirname(validTree), 'unknown-project');
    await fs.mkdir(unknownTree);
    await fs.writeFile(path.join(unknownTree, 'keep.txt'), 'keep');

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Invalid retained Agent Memory project metadata',
    );

    await expect(
      fs.readFile(path.join(unknownTree, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    await expect(
      fs.readFile(path.join(validTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
  });

  // getAgentMemoryProjectKey encodes filename-unsafe project ids as
  // `.hashed-<hex>`, so a leading dot must not be treated as ignorable junk.
  it('migrates a retained orphan project whose key is dot-prefixed and hashed', async () => {
    const orphanProject = {
      id: 'Deleted/Project With Caps',
      name: 'Deleted project',
      path: '/projects/deleted',
    };
    const orphanTree = await writeOldTree(
      [oldRecord({ id: 'hashed-orphan-review', projectId: orphanProject.id })],
      orphanProject,
    );
    expect(path.basename(orphanTree).startsWith('.hashed-')).toBe(true);
    const paths = getAgentMemoryProjectPaths(orphanProject.id, homeDirectory);

    await up(db, homeDirectory);

    await expect(
      fs.readFile(path.join(paths.eventsDirectory, '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('hashed-orphan-review');
    await expect(
      fs.stat(path.join(paths.directory, 'user-reviews')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores OS junk and stray files in the projects directory', async () => {
    const validTree = await writeOldTree([oldRecord()]);
    const projectsDirectory = path.dirname(validTree);
    await fs.writeFile(path.join(projectsDirectory, '.DS_Store'), 'junk');
    await fs.mkdir(path.join(projectsDirectory, '.agent-memory-staging-abc'));
    await fs.writeFile(path.join(projectsDirectory, 'stray.tmp'), 'stray');

    await expect(up(db, homeDirectory)).resolves.not.toThrow();
  });

  it('fails closed on mismatched orphan metadata without deleting recoverable content', async () => {
    const orphanProject = {
      id: 'deleted-project',
      name: 'Deleted project',
      path: '/projects/deleted',
    };
    const orphanTree = await writeOldTree([oldRecord()], orphanProject);
    await fs.writeFile(
      path.join(orphanTree, 'project.json'),
      `${JSON.stringify({
        id: 'different-project',
        name: orphanProject.name,
        sourcePath: orphanProject.path,
      })}\n`,
    );

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Retained Agent Memory project key does not match metadata',
    );

    await expect(
      fs.readFile(path.join(orphanTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(
      fs.readFile(path.join(orphanTree, 'user-reviews', 'reviews.jsonl'), 'utf-8'),
    ).resolves.toContain('secret-value');
  });

  it('fails closed on a symlinked orphan directory without deleting its target', async () => {
    const validTree = await writeOldTree([oldRecord()]);
    const externalTree = path.join(homeDirectory, 'external-orphan');
    await fs.mkdir(externalTree);
    await fs.writeFile(path.join(externalTree, 'keep.txt'), 'keep');
    const orphanLink = path.join(path.dirname(validTree), 'orphan-link');
    await fs.symlink(externalTree, orphanLink);

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Unsafe retained Agent Memory project directory',
    );

    await expect(
      fs.readFile(path.join(externalTree, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    expect((await fs.lstat(orphanLink)).isSymbolicLink()).toBe(true);
    await expect(
      fs.readFile(path.join(validTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
  });

  it('produces deterministic event IDs from old record IDs', async () => {
    await writeOldTree([oldRecord()]);
    const paths = getAgentMemoryProjectPaths(project.id, homeDirectory);
    await up(db, homeDirectory);
    const first = JSON.parse(
      await fs.readFile(path.join(paths.eventsDirectory, '2026-07-18.jsonl'), 'utf-8'),
    ) as { id: string };

    await fs.rm(paths.directory, { recursive: true });
    await writeOldTree([oldRecord()]);
    await up(db, homeDirectory);
    const second = JSON.parse(
      await fs.readFile(path.join(paths.eventsDirectory, '2026-07-18.jsonl'), 'utf-8'),
    ) as { id: string };

    expect(second.id).toBe(first.id);
  });

  it('rejects duplicate source IDs before activation and preserves old tree', async () => {
    const oldTree = await writeOldTree([
      oldRecord(),
      oldRecord({ comment: { body: 'Second review' } }),
    ]);

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Duplicate Agent Memory source ID: review-1',
    );

    await expect(
      fs.readFile(path.join(oldTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(fs.stat(path.join(oldTree, 'events'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rolls back activation failure without exposing partial new state', async () => {
    const oldTree = await writeOldTree([oldRecord()]);
    const realRename = fs.rename;
    const rename = vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (String(from).includes('.agent-memory-staging-') && String(to) === oldTree) {
        return Promise.reject(new Error('activation failed'));
      }
      return realRename(from, to);
    });

    await expect(up(db, homeDirectory)).rejects.toThrow('activation failed');
    rename.mockRestore();

    await expect(
      fs.readFile(path.join(oldTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(fs.stat(path.join(oldTree, 'events'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves old files when post-activation digest verification fails', async () => {
    const oldTree = await writeOldTree([oldRecord()]);
    const realRename = fs.rename;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      if (String(from).includes('.agent-memory-staging-') && String(to) === oldTree) {
        await fs.appendFile(
          path.join(oldTree, 'memory-items.json'),
          '\n',
        );
      }
    });

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Agent Memory canonical digest mismatch',
    );
    rename.mockRestore();

    await expect(
      fs.readFile(path.join(oldTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(fs.stat(path.join(oldTree, 'events'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rolls back every project when a later project cannot activate', async () => {
    const secondProject = {
      id: 'project-2',
      name: 'Second',
      path: '/projects/second',
    };
    db = createMigrationDb([project, secondProject]);
    const firstTree = await writeOldTree([oldRecord()]);
    const secondTree = await writeOldTree(
      [oldRecord({ id: 'review-2', projectId: secondProject.id })],
      secondProject,
    );
    const realRename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (
        String(from).includes('.agent-memory-staging-project-2') &&
        String(to) === secondTree
      ) {
        return Promise.reject(new Error('second activation failed'));
      }
      return realRename(from, to);
    });

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'second activation failed',
    );

    await expect(
      fs.readFile(path.join(firstTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(
      fs.readFile(path.join(secondTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(fs.stat(path.join(firstTree, 'events'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(secondTree, 'events'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('converges every project to new state when one legacy restore fails', async () => {
    const secondProject = {
      id: 'project-2',
      name: 'Second',
      path: '/projects/second',
    };
    const thirdProject = {
      id: 'project-3',
      name: 'Third',
      path: '/projects/third',
    };
    const fourthProject = {
      id: 'project-4',
      name: 'Fourth',
      path: '/projects/fourth',
    };
    db = createMigrationDb([
      project,
      secondProject,
      thirdProject,
      fourthProject,
    ]);
    const firstTree = await writeOldTree([oldRecord()]);
    const secondTree = await writeOldTree(
      [oldRecord({ id: 'review-2' })],
      secondProject,
    );
    const thirdTree = await writeOldTree(
      [oldRecord({ id: 'review-3' })],
      thirdProject,
    );
    const fourthTree = await writeOldTree(
      [oldRecord({ id: 'review-4' })],
      fourthProject,
    );
    const realRename = fs.rename;
    let thirdRestoreAttempted = false;
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      if (
        String(from).includes('.agent-memory-staging-project-3') &&
        String(to) === thirdTree
      ) {
        return Promise.reject(new Error('third activation failed'));
      }
      if (
        String(from).includes('.agent-memory-backup-project-2') &&
        String(to) === secondTree
      ) {
        return Promise.reject(new Error('second restore failed'));
      }
      if (
        String(from).includes('.agent-memory-backup-project-3') &&
        String(to) === thirdTree
      ) {
        thirdRestoreAttempted = true;
      }
      return realRename(from, to);
    });

    await expect(up(db, homeDirectory)).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AggregateError &&
        error.errors.some(
          (entry) =>
            entry instanceof Error && entry.message === 'second restore failed',
        )
      );
    });

    expect(thirdRestoreAttempted).toBe(true);
    for (const [tree, reviewId] of [
      [firstTree, 'review-1'],
      [secondTree, 'review-2'],
      [thirdTree, 'review-3'],
      [fourthTree, 'review-4'],
    ]) {
      await expect(
        fs.readFile(path.join(tree, 'events', '2026-07-18.jsonl'), 'utf-8'),
      ).resolves.toContain(reviewId);
      await expect(
        fs.stat(path.join(tree, 'user-preferences.md')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    for (const projectId of [
      'project-1',
      'project-2',
      'project-3',
      'project-4',
    ]) {
      await expect(
        fs.stat(
          path.join(
            path.dirname(firstTree),
            `.agent-memory-backup-${projectId}`,
          ),
        ),
      ).resolves.toBeDefined();
    }
  });

  it('rejects cleanup failure and restores every active project to legacy state', async () => {
    const secondProject = {
      id: 'project-2',
      name: 'Second',
      path: '/projects/second',
    };
    db = createMigrationDb([project, secondProject]);
    const firstTree = await writeOldTree([oldRecord()]);
    const secondTree = await writeOldTree(
      [oldRecord({ id: 'review-2' })],
      secondProject,
    );
    const realRm = fs.rm;
    let cleanupFailed = false;
    vi.spyOn(fs, 'rm').mockImplementation((target, options) => {
      if (
        !cleanupFailed &&
        (String(target).includes('.agent-memory-backup-') ||
          String(target).includes('.agent-memory-cleanup-076'))
      ) {
        cleanupFailed = true;
        return Promise.reject(new Error('legacy cleanup failed'));
      }
      return realRm(target, options);
    });

    await expect(up(db, homeDirectory)).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AggregateError &&
        error.errors.some(
          (entry) =>
            entry instanceof Error && entry.message === 'legacy cleanup failed',
        )
      );
    });

    await expect(
      fs.readFile(path.join(firstTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(
      fs.readFile(path.join(secondTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    await expect(fs.stat(path.join(firstTree, 'events'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(path.join(secondTree, 'events'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps every active project new when partial cleanup makes full rollback unsafe', async () => {
    const secondProject = {
      id: 'project-2',
      name: 'Second',
      path: '/projects/second',
    };
    db = createMigrationDb([project, secondProject]);
    const firstTree = await writeOldTree([oldRecord()]);
    const secondTree = await writeOldTree(
      [oldRecord({ id: 'review-2' })],
      secondProject,
    );
    const cleanupDirectory = path.join(
      path.dirname(firstTree),
      '.agent-memory-cleanup-076',
    );
    const realRm = fs.rm;
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === cleanupDirectory) {
        await realRm(
          path.join(cleanupDirectory, '.agent-memory-backup-project-1'),
          { recursive: true },
        );
        throw new Error('partial legacy cleanup failed');
      }
      return realRm(target, options);
    });

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'partial legacy cleanup failed',
    );

    await expect(
      fs.readFile(path.join(firstTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
    await expect(
      fs.readFile(path.join(secondTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-2');
    await expect(
      fs.stat(path.join(firstTree, 'user-preferences.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(secondTree, 'user-preferences.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(
        path.join(cleanupDirectory, '.agent-memory-backup-project-2'),
      ),
    ).resolves.toBeDefined();

    rm.mockRestore();
    await expect(up(db, homeDirectory)).resolves.toBeUndefined();
    await expect(fs.stat(cleanupDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.readFile(path.join(firstTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
    await expect(
      fs.readFile(path.join(secondTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-2');
  });

  it('recovers a verified new tree from an interrupted failed-active sibling', async () => {
    const activeTree = await writeOldTree([oldRecord()]);
    const projectsDirectory = path.dirname(activeTree);
    const legacyCopy = path.join(homeDirectory, 'legacy-copy');
    await fs.cp(activeTree, legacyCopy, { recursive: true });
    await up(db, homeDirectory);

    const failedActiveTree = path.join(
      projectsDirectory,
      '.agent-memory-failed-active-project-1',
    );
    const backupTree = path.join(
      projectsDirectory,
      '.agent-memory-backup-project-1',
    );
    await fs.rename(activeTree, failedActiveTree);
    await fs.rename(legacyCopy, backupTree);

    await expect(up(db, homeDirectory)).resolves.toBeUndefined();

    await expect(
      fs.readFile(path.join(activeTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
    await expect(fs.stat(failedActiveTree)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(backupTree)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an unsafe quarantined symlink without deleting recoverable data', async () => {
    const activeTree = await writeOldTree([oldRecord()]);
    await up(db, homeDirectory);
    const cleanupDirectory = path.join(
      path.dirname(activeTree),
      '.agent-memory-cleanup-076',
    );
    const externalDirectory = path.join(homeDirectory, 'external-legacy');
    await fs.mkdir(cleanupDirectory);
    await fs.mkdir(externalDirectory);
    await fs.writeFile(path.join(externalDirectory, 'keep.txt'), 'keep');
    await fs.symlink(
      externalDirectory,
      path.join(cleanupDirectory, '.agent-memory-backup-project-1'),
    );

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Unsafe agent memory path',
    );

    await expect(
      fs.readFile(path.join(externalDirectory, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    await expect(
      fs.readFile(path.join(activeTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
  });

  it('converges mixed new and legacy active trees after interrupted activation', async () => {
    const secondProject = {
      id: 'project-2',
      name: 'Second',
      path: '/projects/second',
    };
    db = createMigrationDb([project, secondProject]);
    const firstTree = await writeOldTree([oldRecord()]);
    const secondTree = await writeOldTree(
      [oldRecord({ id: 'review-2' })],
      secondProject,
    );
    const firstLegacy = path.join(homeDirectory, 'first-legacy');
    const secondLegacy = path.join(homeDirectory, 'second-legacy');
    await fs.cp(firstTree, firstLegacy, { recursive: true });
    await fs.cp(secondTree, secondLegacy, { recursive: true });
    await up(db, homeDirectory);

    const projectsDirectory = path.dirname(firstTree);
    const firstBackup = path.join(
      projectsDirectory,
      '.agent-memory-backup-project-1',
    );
    const secondStaging = path.join(
      projectsDirectory,
      '.agent-memory-staging-project-2',
    );
    await fs.rename(firstLegacy, firstBackup);
    await fs.rename(secondTree, secondStaging);
    await fs.rename(secondLegacy, secondTree);

    await expect(up(db, homeDirectory)).resolves.toBeUndefined();

    await expect(
      fs.readFile(path.join(firstTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
    await expect(
      fs.readFile(path.join(secondTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-2');
    await expect(fs.stat(firstBackup)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(secondStaging)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('resumes normal migration when every active tree remains legacy', async () => {
    const secondProject = {
      id: 'project-2',
      name: 'Second',
      path: '/projects/second',
    };
    db = createMigrationDb([project, secondProject]);
    const firstTree = await writeOldTree([oldRecord()]);
    const secondTree = await writeOldTree(
      [oldRecord({ id: 'review-2' })],
      secondProject,
    );
    const firstLegacy = path.join(homeDirectory, 'first-legacy');
    const secondLegacy = path.join(homeDirectory, 'second-legacy');
    await fs.cp(firstTree, firstLegacy, { recursive: true });
    await fs.cp(secondTree, secondLegacy, { recursive: true });
    await up(db, homeDirectory);

    const projectsDirectory = path.dirname(firstTree);
    const firstFailedActive = path.join(
      projectsDirectory,
      '.agent-memory-failed-active-project-1',
    );
    const secondStaging = path.join(
      projectsDirectory,
      '.agent-memory-staging-project-2',
    );
    const cleanupDirectory = path.join(
      projectsDirectory,
      '.agent-memory-cleanup-076',
    );
    await fs.rename(firstTree, firstFailedActive);
    await fs.rename(firstLegacy, firstTree);
    await fs.rename(secondTree, secondStaging);
    await fs.rename(secondLegacy, secondTree);
    await fs.mkdir(cleanupDirectory);

    await expect(up(db, homeDirectory)).resolves.toBeUndefined();

    await expect(
      fs.readFile(path.join(firstTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
    await expect(
      fs.readFile(path.join(secondTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-2');
    await expect(fs.stat(firstFailedActive)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(secondStaging)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(cleanupDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rebuilds partial regular staging when the active tree is valid legacy', async () => {
    const activeTree = await writeOldTree([oldRecord()]);
    const stagingTree = path.join(
      path.dirname(activeTree),
      '.agent-memory-staging-project-1',
    );
    await fs.mkdir(stagingTree);
    await fs.writeFile(path.join(stagingTree, 'partial.json'), '{');

    await expect(up(db, homeDirectory)).resolves.toBeUndefined();

    await expect(
      fs.readFile(path.join(activeTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
    await expect(fs.stat(stagingTree)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans partial regular staging when the active tree is valid new', async () => {
    const activeTree = await writeOldTree([oldRecord()]);
    await up(db, homeDirectory);
    const stagingTree = path.join(
      path.dirname(activeTree),
      '.agent-memory-staging-project-1',
    );
    await fs.mkdir(stagingTree);
    await fs.writeFile(path.join(stagingTree, 'partial.json'), '{');

    await expect(up(db, homeDirectory)).resolves.toBeUndefined();

    await expect(
      fs.readFile(path.join(activeTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
    ).resolves.toContain('review-1');
    await expect(fs.stat(stagingTree)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves partial regular staging when the active tree is missing', async () => {
    const paths = getAgentMemoryProjectPaths(project.id, homeDirectory);
    const stagingTree = path.join(
      path.dirname(paths.directory),
      '.agent-memory-staging-project-1',
    );
    await fs.mkdir(stagingTree, { recursive: true });
    await fs.writeFile(path.join(stagingTree, 'partial.json'), '{');

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Invalid regular Agent Memory residue requires a verified active tree',
    );

    await expect(
      fs.readFile(path.join(stagingTree, 'partial.json'), 'utf-8'),
    ).resolves.toBe('{');
    await expect(fs.stat(paths.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects symlinked staging without deleting its target', async () => {
    const activeTree = await writeOldTree([oldRecord()]);
    const externalDirectory = path.join(homeDirectory, 'external-staging');
    const stagingTree = path.join(
      path.dirname(activeTree),
      '.agent-memory-staging-project-1',
    );
    await fs.mkdir(externalDirectory);
    await fs.writeFile(path.join(externalDirectory, 'keep.txt'), 'keep');
    await fs.symlink(externalDirectory, stagingTree);

    await expect(up(db, homeDirectory)).rejects.toThrow(
      'Unsafe agent memory path',
    );

    await expect(
      fs.readFile(path.join(externalDirectory, 'keep.txt'), 'utf-8'),
    ).resolves.toBe('keep');
    await expect(
      fs.readFile(path.join(activeTree, 'user-preferences.md'), 'utf-8'),
    ).resolves.toBe('# Never import this\n');
    expect((await fs.lstat(stagingTree)).isSymbolicLink()).toBe(true);
  });

  it.each(restartResidueCases)(
    'cleans partial $label residue when the active tree is valid',
    async ({ pathFor }) => {
      const activeTree = await writeOldTree([oldRecord()]);
      await up(db, homeDirectory);
      const residuePath = pathFor(activeTree);
      await fs.mkdir(residuePath, { recursive: true });
      await fs.writeFile(path.join(residuePath, 'partial.json'), '{');

      await expect(up(db, homeDirectory)).resolves.toBeUndefined();

      await expect(fs.stat(residuePath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        fs.readFile(path.join(activeTree, 'events', '2026-07-18.jsonl'), 'utf-8'),
      ).resolves.toContain('review-1');
    },
  );

  it.each(restartResidueCases)(
    'preserves partial $label residue when the active tree is missing',
    async ({ pathFor }) => {
      const paths = getAgentMemoryProjectPaths(project.id, homeDirectory);
      const residuePath = pathFor(paths.directory);
      await fs.mkdir(residuePath, { recursive: true });
      await fs.writeFile(path.join(residuePath, 'partial.json'), '{');

      await expect(up(db, homeDirectory)).rejects.toThrow(
        'Invalid regular Agent Memory residue requires a verified active tree',
      );

      await expect(
        fs.readFile(path.join(residuePath, 'partial.json'), 'utf-8'),
      ).resolves.toBe('{');
      await expect(fs.stat(paths.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(restartResidueCases)(
    'rejects symlinked $label residue without deleting its target',
    async ({ label, pathFor }) => {
      const activeTree = await writeOldTree([oldRecord()]);
      const residuePath = pathFor(activeTree);
      const externalDirectory = path.join(homeDirectory, `external-${label}`);
      await fs.mkdir(path.dirname(residuePath), { recursive: true });
      await fs.mkdir(externalDirectory);
      await fs.writeFile(path.join(externalDirectory, 'keep.txt'), 'keep');
      await fs.symlink(externalDirectory, residuePath);

      await expect(up(db, homeDirectory)).rejects.toThrow(
        'Unsafe agent memory path',
      );

      await expect(
        fs.readFile(path.join(externalDirectory, 'keep.txt'), 'utf-8'),
      ).resolves.toBe('keep');
      await expect(
        fs.readFile(path.join(activeTree, 'user-preferences.md'), 'utf-8'),
      ).resolves.toBe('# Never import this\n');
      expect((await fs.lstat(residuePath)).isSymbolicLink()).toBe(true);
    },
  );
});
