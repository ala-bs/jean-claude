import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_MEMORY_SCHEMA_VERSION,
  type AgentMemoryExtractionRun,
  type AgentMemoryItem,
} from '@shared/agent-memory-types';

import {
  appendAgentMemoryEvent,
  ensureAgentMemoryGlobalStorage,
  ensureProjectAgentMemoryStorage,
  getAgentMemoryGlobalPaths,
  getAgentMemoryProjectPaths,
  readAgentMemoryRunIndex,
} from './agent-memory-storage';
import { createAgentMemoryDashboardService } from './agent-memory-dashboard-service';

const tempDirectories: string[] = [];

function item(
  overrides: Partial<AgentMemoryItem> & Pick<AgentMemoryItem, 'id' | 'category' | 'scope'>,
): AgentMemoryItem {
  return {
    schemaVersion: AGENT_MEMORY_SCHEMA_VERSION,
    statement: `Statement ${overrides.id}`,
    kind: overrides.scope === 'global' ? 'inferred-preference' : 'project-guideline',
    status: 'confirmed',
    confidence: 0.8,
    evidenceIds: [`event-${overrides.id}`],
    taskCount: 2,
    projectCount: overrides.scope === 'global' ? 2 : 1,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-02T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...(overrides.scope === 'project' ? { projectId: 'project-1' } : {}),
    ...overrides,
  };
}

function run({
  id,
  scope,
  status = 'succeeded',
}: {
  id: string;
  scope: 'project' | 'global';
  status?: 'succeeded' | 'failed';
}): AgentMemoryExtractionRun {
  return {
    schemaVersion: AGENT_MEMORY_SCHEMA_VERSION,
    id,
    scope,
    ...(scope === 'project' ? { projectId: 'project-1' } : {}),
    trigger: 'scheduled',
    backend: 'claude-code',
    model: 'haiku',
    thinkingEffort: 'low',
    status,
    eventRanges:
      scope === 'project'
        ? [
            {
              fileName: '2026-07-01.jsonl',
              fromOffset: 0,
              toOffset: 42,
              eventCount: 1,
            },
          ]
        : [],
    proposedItemCount: 2,
    acceptedItemCount: status === 'succeeded' ? 1 : 0,
    startedAt: '2026-07-02T00:00:00.000Z',
    completedAt: '2026-07-02T00:00:01.000Z',
    durationMs: 1_000,
    error: status === 'failed' ? { message: 'Backend unavailable' } : null,
  };
}

async function setupMemory() {
  await fs.mkdir(os.tmpdir(), { recursive: true });
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dashboard-'));
  tempDirectories.push(homeDirectory);
  await ensureAgentMemoryGlobalStorage({ homeDirectory });
  await ensureProjectAgentMemoryStorage({
    projectId: 'project-1',
    name: 'Project One',
    homeDirectory,
  });
  return homeDirectory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('AgentMemoryDashboardService', () => {
  it('groups memory, explains candidate count blockers, and pages evidence and run bodies', async () => {
    const homeDirectory = await setupMemory();
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    const projectPaths = getAgentMemoryProjectPaths('project-1', homeDirectory);
    await fs.writeFile(
      globalPaths.profileJson,
      JSON.stringify({
        schemaVersion: 1,
        items: [
          item({ id: 'global-engineering', category: 'engineering', scope: 'global' }),
          item({ id: 'global-communication', category: 'communication', scope: 'global' }),
          item({
            id: 'global-candidate',
            category: 'quality',
            scope: 'global',
            status: 'candidate',
            taskCount: 3,
            projectCount: 1,
          }),
        ],
        consumedNominationIds: [],
        reviewedProjectRunKeys: [],
        projectionPending: false,
      }),
    );
    await fs.writeFile(
      projectPaths.itemsJson,
      JSON.stringify({
        schemaVersion: 1,
        items: [
          item({ id: 'constraint', category: 'constraint', scope: 'project' }),
          item({ id: 'guideline', category: 'guideline', scope: 'project' }),
          item({
            id: 'task-candidate',
            category: 'recurring-priority',
            scope: 'task',
            projectId: 'project-1',
            taskId: 'task-1',
            status: 'candidate',
            taskCount: 1,
            projectCount: 1,
          }),
        ],
      }),
    );
    for (let index = 0; index < 3; index += 1) {
      await appendAgentMemoryEvent({
        homeDirectory,
        event: {
          schemaVersion: 1,
          id: `event-${index}`,
          sourceId: `source-${index}`,
          source: 'initial-task-prompt',
          projectId: 'project-1',
          text: `Evidence ${index}`,
          context: null,
          createdAt: `2026-07-0${index + 1}T00:00:00.000Z`,
          redactions: [],
        },
      });
    }
    const runPaths = [
      ...['project-run-1', 'project-run-2', 'project-run-3'].map((id) => ({
        filePath: path.join(projectPaths.runsDirectory, `${id}.json`),
        value: { run: run({ id, scope: 'project' }), acceptedNominations: [] },
      })),
      ...['global-run-1', 'global-run-2'].map((id) => ({
        filePath: path.join(globalPaths.runsDirectory, `${id}.json`),
        value: {
          run: run({ id, scope: 'global' }),
          consumedNominationIds: [],
          reviewedProjectRunKeys: [],
        },
      })),
    ];
    for (const [index, entry] of runPaths.entries()) {
      await fs.writeFile(entry.filePath, JSON.stringify(entry.value));
      const timestamp = new Date(Date.UTC(2026, 6, index + 1));
      await fs.utimes(entry.filePath, timestamp, timestamp);
    }
    const readFile = vi.fn(fs.readFile);
    const stat = vi.spyOn(fs, 'stat');
    const service = createAgentMemoryDashboardService({
      homeDirectory,
      readFile,
      getSetting: vi.fn().mockResolvedValue({ enabled: true }),
    });

    const dashboard = await service.getDashboard({
      projectId: 'project-1',
      evidencePage: 1,
      extractionRunPage: 1,
      pageSize: 2,
    });

    expect(dashboard.globalProfile.map((group) => group.category)).toEqual([
      'communication',
      'engineering',
    ]);
    expect(dashboard.projectMemory.map((group) => group.category)).toEqual([
      'constraint',
      'guideline',
    ]);
    expect(dashboard.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          item: expect.objectContaining({ id: 'task-candidate' }),
          blockers: expect.arrayContaining([
            { kind: 'task-count', current: 1, required: 2 },
            { kind: 'project-count', current: 1, required: 2 },
          ]),
        }),
        expect.objectContaining({
          item: expect.objectContaining({ id: 'global-candidate' }),
          blockers: [{ kind: 'project-count', current: 1, required: 2 }],
        }),
      ]),
    );
    expect(dashboard.evidence).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(dashboard.evidence.items).toHaveLength(1);
    expect(dashboard.extractionRuns).toMatchObject({
      page: 1,
      pageSize: 2,
      total: 5,
    });
    expect(dashboard.extractionRuns.items).toHaveLength(2);
    const runBodyReads = readFile.mock.calls.filter(([filePath]) =>
      String(filePath).includes(`${path.sep}runs${path.sep}`),
    );
    expect(runBodyReads).toHaveLength(2);
    expect(stat).toHaveBeenCalledTimes(8);
    expect(
      stat.mock.calls.filter(([filePath]) =>
        String(filePath).endsWith(`${path.sep}runs${path.sep}records`),
      ),
    ).toHaveLength(6);
    expect(
      stat.mock.calls.filter(([filePath]) =>
        /(?:profile|memory-items)\.json$/.test(String(filePath)),
      ),
    ).toHaveLength(2);
  });

  it('keeps stored data readable while disabled and blocks manual model work before project reads', async () => {
    const homeDirectory = await setupMemory();
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    await fs.writeFile(
      globalPaths.profileJson,
      JSON.stringify({
        schemaVersion: 1,
        items: [item({ id: 'saved', category: 'product', scope: 'global' })],
        consumedNominationIds: [],
        reviewedProjectRunKeys: [],
        projectionPending: false,
      }),
    );
    const findProjectById = vi.fn();
    const extractProjectMemory = vi.fn();
    const service = createAgentMemoryDashboardService({
      homeDirectory,
      getSetting: vi.fn().mockResolvedValue({ enabled: false }),
      findProjectById,
      extractProjectMemory,
    });

    const dashboard = await service.getDashboard({ projectId: 'project-1' });

    expect(dashboard.enabled).toBe(false);
    expect(dashboard.globalProfile[0]?.items[0]?.id).toBe('saved');
    await expect(service.extractNow('project-1')).rejects.toThrow(
      'Agent Memory is disabled',
    );
    expect(findProjectById).not.toHaveBeenCalled();
    expect(extractProjectMemory).not.toHaveBeenCalled();
  });

  it('shows a bounded legacy profile with a repair notice while disabled', async () => {
    const homeDirectory = await setupMemory();
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    const legacyProfile = JSON.stringify({
      schemaVersion: 1,
      items: [item({ id: 'legacy-saved', category: 'product', scope: 'global' })],
      consumedNominationIds: Array.from(
        { length: 35_000 },
        (_, index) => `legacy-${index}-${'x'.repeat(140)}`,
      ),
      reviewedProjectRunKeys: [],
      projectionPending: false,
    });
    expect(Buffer.byteLength(legacyProfile)).toBeGreaterThan(5_000_000);
    await fs.writeFile(globalPaths.profileJson, legacyProfile);
    const service = createAgentMemoryDashboardService({
      homeDirectory,
      getSetting: vi.fn().mockResolvedValue({ enabled: false }),
    });

    const dashboard = await service.getDashboard();

    expect(dashboard.globalProfile[0]?.items[0]?.id).toBe('legacy-saved');
    expect(dashboard.repairNotice).toMatch(/needs repair/i);
  });

  it('runs selected project extraction before one global merge', async () => {
    const order: string[] = [];
    const service = createAgentMemoryDashboardService({
      getSetting: vi.fn().mockResolvedValue({
        enabled: true,
        extractionBackend: 'claude-code',
        extractionModel: 'haiku',
        extractionThinkingEffort: 'low',
      }),
      findProjectById: vi.fn().mockResolvedValue({ id: 'project-1', name: 'One' }),
      findProjects: vi.fn().mockResolvedValue([
        { id: 'project-1', name: 'One' },
        { id: 'project-2', name: 'Two' },
      ]),
      extractProjectMemory: vi.fn(async () => {
        order.push('project');
        return { processed: true, run: null };
      }),
      mergeGlobalMemory: vi.fn(async ({ projectIds }) => {
        order.push(`global:${projectIds.join(',')}`);
        return { processed: true, run: null };
      }),
    });

    await service.extractNow('project-1');

    expect(order).toEqual(['project', 'global:project-1,project-2']);
  });

  it('rechecks consent after project lookup before starting extraction', async () => {
    const getSetting = vi
      .fn()
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ enabled: false });
    const extractProjectMemory = vi.fn();
    const service = createAgentMemoryDashboardService({
      getSetting,
      findProjectById: vi.fn().mockResolvedValue({ id: 'project-1', name: 'One' }),
      extractProjectMemory,
    });

    await expect(service.extractNow('project-1')).rejects.toThrow(
      'Agent Memory is disabled',
    );
    expect(extractProjectMemory).not.toHaveBeenCalled();
  });

  it('rechecks consent before global merge', async () => {
    const enabled = {
      enabled: true,
      extractionBackend: 'claude-code' as const,
      extractionModel: 'haiku',
      extractionThinkingEffort: 'low' as const,
    };
    const getSetting = vi
      .fn()
      .mockResolvedValueOnce(enabled)
      .mockResolvedValueOnce(enabled)
      .mockResolvedValueOnce({ ...enabled, enabled: false });
    const mergeGlobalMemory = vi.fn();
    const service = createAgentMemoryDashboardService({
      getSetting,
      findProjectById: vi.fn().mockResolvedValue({ id: 'project-1', name: 'One' }),
      findProjects: vi.fn().mockResolvedValue([{ id: 'project-1', name: 'One' }]),
      extractProjectMemory: vi.fn().mockResolvedValue({
        processed: true,
        run: null,
      }),
      mergeGlobalMemory,
    });

    await expect(service.extractNow('project-1')).rejects.toThrow(
      'Agent Memory is disabled',
    );
    expect(mergeGlobalMemory).not.toHaveBeenCalled();
  });

  it('passes a lock-time database recheck before manual extraction work', async () => {
    const project = { id: 'project-1', name: 'One' };
    const findProjectById = vi
      .fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(undefined);
    const mergeGlobalMemory = vi.fn();
    const extractProjectMemory = vi.fn(
      async ({
        recheckProjectExists,
      }: {
        recheckProjectExists?: () => Promise<boolean>;
      }) => {
        if (!(await recheckProjectExists?.())) {
          throw new Error('Project not found: project-1');
        }
        return { processed: true, run: null };
      },
    );
    const service = createAgentMemoryDashboardService({
      getSetting: vi.fn().mockResolvedValue({
        enabled: true,
        extractionBackend: 'claude-code',
        extractionModel: 'haiku',
        extractionThinkingEffort: 'low',
      }),
      findProjectById,
      extractProjectMemory,
      mergeGlobalMemory,
    });

    await expect(service.extractNow('project-1')).rejects.toThrow(
      'Project not found: project-1',
    );

    expect(findProjectById).toHaveBeenCalledTimes(2);
    expect(mergeGlobalMemory).not.toHaveBeenCalled();
  });

  it('retries a failed run without changing its extraction checkpoint', async () => {
    const homeDirectory = await setupMemory();
    const projectPaths = getAgentMemoryProjectPaths('project-1', homeDirectory);
    const failedRun = run({ id: 'failed-run', scope: 'project', status: 'failed' });
    await fs.writeFile(
      path.join(projectPaths.runsDirectory, 'failed-run.json'),
      JSON.stringify({ run: failedRun, acceptedNominations: [] }),
    );
    const checkpointBefore = await fs.readFile(projectPaths.extractionStateJson, 'utf8');
    const extractProjectMemory = vi.fn().mockResolvedValue({
      processed: true,
      run: null,
    });
    const service = createAgentMemoryDashboardService({
      homeDirectory,
      getSetting: vi.fn().mockResolvedValue({
        enabled: true,
        extractionBackend: 'claude-code',
        extractionModel: 'haiku',
        extractionThinkingEffort: 'default',
      }),
      findProjectById: vi.fn().mockResolvedValue({ id: 'project-1', name: 'One' }),
      extractProjectMemory,
    });

    await service.retryRun({
      projectId: 'project-1',
      runId: 'failed-run',
      scope: 'project',
    });

    expect(extractProjectMemory).toHaveBeenCalledOnce();
    expect(await fs.readFile(projectPaths.extractionStateJson, 'utf8')).toBe(
      checkpointBefore,
    );
  });

  it('reads only the requested run page without statting every run', async () => {
    const homeDirectory = await setupMemory();
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    for (let index = 0; index < 250; index += 1) {
      const id = `run-${String(index).padStart(4, '0')}`;
      await fs.writeFile(
        path.join(globalPaths.runsDirectory, `${id}.json`),
        JSON.stringify({
          run: run({ id, scope: 'global' }),
          consumedNominationIds: [],
          reviewedProjectRunKeys: [],
        }),
      );
    }
    await readAgentMemoryRunIndex({ scope: 'global', homeDirectory });
    const readFile = vi.fn(fs.readFile);
    const stat = vi.spyOn(fs, 'stat');
    const open = vi.spyOn(fs, 'open');
    const service = createAgentMemoryDashboardService({
      homeDirectory,
      readFile,
      getSetting: vi.fn().mockResolvedValue({ enabled: true }),
    });

    const dashboard = await service.getDashboard({
      extractionRunPage: 20,
      pageSize: 5,
    });

    expect(dashboard.extractionRuns).toMatchObject({
      page: 20,
      pageSize: 5,
      total: 250,
    });
    expect(dashboard.extractionRuns.items).toHaveLength(5);
    expect(
      readFile.mock.calls.filter(([filePath]) =>
        String(filePath).includes(`${path.sep}runs${path.sep}`),
      ),
    ).toHaveLength(5);
    expect(stat).toHaveBeenCalledTimes(2);
    expect(
      stat.mock.calls.some(
        ([filePath]) =>
          String(filePath) === path.join(globalPaths.runsDirectory, 'records'),
      ),
    ).toBe(true);
    expect(
      open.mock.calls.filter(([filePath]) =>
        String(filePath).includes(
          `${path.sep}runs${path.sep}records${path.sep}run-`,
        ),
      ),
    ).toHaveLength(0);
  });

  it('pages runs chronologically with the newest failed run first', async () => {
    const homeDirectory = await setupMemory();
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    const records = [
      {
        id: 'old-run',
        startedAt: '2026-07-01T00:00:00.000Z',
        status: 'succeeded' as const,
      },
      {
        id: 'newest-failed-run',
        startedAt: '2026-07-03T00:00:00.000Z',
        status: 'failed' as const,
      },
      {
        id: 'middle-run',
        startedAt: '2026-07-02T00:00:00.000Z',
        status: 'succeeded' as const,
      },
    ];
    for (const record of records) {
      const value = run({
        id: record.id,
        scope: 'global',
        status: record.status,
      });
      await fs.writeFile(
        path.join(globalPaths.runsDirectory, `${record.id}.json`),
        JSON.stringify({
          run: {
            ...value,
            startedAt: record.startedAt,
            completedAt: record.startedAt,
          },
          consumedNominationIds: [],
          reviewedProjectRunKeys: [],
        }),
      );
    }
    const service = createAgentMemoryDashboardService({
      homeDirectory,
      getSetting: vi.fn().mockResolvedValue({ enabled: true }),
    });

    const dashboard = await service.getDashboard({ pageSize: 2 });

    expect(dashboard.extractionRuns.items.map(({ id }) => id)).toEqual([
      'newest-failed-run',
      'middle-run',
    ]);
    expect(dashboard.extractionRuns.items[0].status).toBe('failed');
  });

  it('fails closed when the configured home directory is a symlink', async () => {
    const target = await setupMemory();
    const linkedHome = path.join(os.tmpdir(), 'agent-dashboard-linked-home');
    tempDirectories.push(linkedHome);
    await fs.rm(linkedHome, { force: true, recursive: true });
    await fs.symlink(target, linkedHome);
    const service = createAgentMemoryDashboardService({
      homeDirectory: linkedHome,
      getSetting: vi.fn().mockResolvedValue({ enabled: true }),
    });

    await expect(service.getDashboard()).rejects.toThrow(
      'Unsafe symlink in agent memory',
    );
  });

  it('fails closed when a canonical JSON leaf is a symlink', async () => {
    const homeDirectory = await setupMemory();
    const globalPaths = getAgentMemoryGlobalPaths(homeDirectory);
    const outsideFile = path.join(homeDirectory, 'outside-profile.json');
    await fs.writeFile(
      outsideFile,
      JSON.stringify({
        schemaVersion: 1,
        items: [],
        consumedNominationIds: [],
        reviewedProjectRunKeys: [],
        projectionPending: false,
      }),
    );
    await fs.rm(globalPaths.profileJson);
    await fs.symlink(outsideFile, globalPaths.profileJson);
    const service = createAgentMemoryDashboardService({
      homeDirectory,
      getSetting: vi.fn().mockResolvedValue({ enabled: true }),
    });

    await expect(service.getDashboard()).rejects.toThrow(
      'Unsafe symlink in agent memory',
    );
  });
});
