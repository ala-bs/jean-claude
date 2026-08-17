import { describe, expect, it, vi } from 'vitest';

import { createAgentMemorySchedulerService } from './agent-memory-scheduler-service';

const enabledSetting = {
  enabled: true,
  extractionIntervalMinutes: 15,
  extractionBackend: 'claude-code' as const,
  extractionModel: 'haiku',
  extractionThinkingEffort: 'default' as const,
};

function project(id: string) {
  return { id, name: id, path: `/projects/${id}` };
}

function harness(overrides: Record<string, unknown> = {}) {
  let current = new Date('2026-07-19T08:00:00.000Z');
  const projects = [project('project-1'), project('project-2')];
  const dependencies = {
    now: () => current,
    getSetting: vi.fn().mockResolvedValue(enabledSetting),
    findProjects: vi.fn().mockResolvedValue(projects),
    findProjectById: vi.fn(async (id: string) => projects.find((value) => value.id === id)),
    extractProjectMemory: vi.fn().mockResolvedValue({ processed: true, run: null }),
    mergeGlobalMemory: vi.fn().mockResolvedValue({ processed: true, run: null }),
    readRunTiming: vi.fn().mockResolvedValue({
      lastAttemptAt: null,
      lastSuccessAt: null,
    }),
    recordRunTiming: vi.fn().mockResolvedValue(undefined),
    logFailure: vi.fn(),
    logSweepFailure: vi.fn(),
    setInterval: vi.fn(globalThis.setInterval),
    clearInterval: vi.fn(globalThis.clearInterval),
    ...overrides,
  };
  return {
    dependencies,
    service: createAgentMemorySchedulerService(dependencies),
    setNow(value: string) {
      current = new Date(value);
    },
  };
}

describe('AgentMemorySchedulerService', () => {
  it('exits while disabled before reading projects or invoking extraction', async () => {
    const test = harness({
      getSetting: vi.fn().mockResolvedValue({ ...enabledSetting, enabled: false }),
    });

    await test.service.runNow();

    expect(test.dependencies.findProjects).not.toHaveBeenCalled();
    expect(test.dependencies.extractProjectMemory).not.toHaveBeenCalled();
    expect(test.dependencies.mergeGlobalMemory).not.toHaveBeenCalled();
  });

  it('does one startup backlog sweep per calendar day, then uses minute interval eligibility', async () => {
    const test = harness();

    await test.service.runNow();
    await test.service.runNow();
    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(2);
    expect(test.dependencies.extractProjectMemory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ config: expect.objectContaining({ trigger: 'backlog' }) }),
    );

    test.setNow('2026-07-19T08:14:59.000Z');
    await test.service.runNow();
    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(2);

    test.setNow('2026-07-19T08:15:00.000Z');
    await test.service.runNow();
    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(4);
    expect(test.dependencies.extractProjectMemory).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ config: expect.objectContaining({ trigger: 'scheduled' }) }),
    );

    test.setNow('2026-07-20T08:01:00.000Z');
    await test.service.runNow();
    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(6);
    expect(test.dependencies.extractProjectMemory).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ config: expect.objectContaining({ trigger: 'backlog' }) }),
    );
  });

  it('runs the daily backlog on startup before the prior-day interval expires', async () => {
    const test = harness({
      getSetting: vi.fn().mockResolvedValue({
        ...enabledSetting,
        extractionIntervalMinutes: 24 * 60,
      }),
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      readRunTiming: vi.fn().mockResolvedValue({
        lastAttemptAt: '2026-07-18T23:55:00.000',
        lastSuccessAt: '2026-07-18T23:55:00.000',
      }),
    });
    test.setNow('2026-07-19T08:00:00.000');

    await test.service.runNow();

    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ trigger: 'backlog' }),
      }),
    );
    expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledOnce();
  });

  it('runs a next-day timer backlog while throttling same-day timer polls', async () => {
    let timerCallback: (() => void) | undefined;
    const test = harness({
      getSetting: vi.fn().mockResolvedValue({
        ...enabledSetting,
        extractionIntervalMinutes: 24 * 60,
      }),
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      setInterval: vi.fn((callback: () => void) => {
        timerCallback = callback;
        return { unref: vi.fn() } as never;
      }),
    });
    test.setNow('2026-07-19T23:55:00.000');
    test.service.start();
    await vi.waitFor(() => {
      expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledOnce();
    });

    test.setNow('2026-07-19T23:56:00.000');
    timerCallback?.();
    await vi.waitFor(() => {
      expect(test.dependencies.getSetting).toHaveBeenCalledTimes(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledOnce();

    test.setNow('2026-07-20T08:00:00.000');
    timerCallback?.();
    await vi.waitFor(() => {
      expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(2);
    });
    expect(test.dependencies.extractProjectMemory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ trigger: 'backlog' }),
      }),
    );
    test.service.stop();
  });

  it('settles all projects and delays failed work until the configured interval', async () => {
    const order: string[] = [];
    const projectOneError = new Error('project one failed');
    const test = harness({
      extractProjectMemory: vi
        .fn(({ project: value }: { project: { id: string } }) => {
          order.push(`start:${value.id}`);
          order.push(`settled:${value.id}`);
          return Promise.resolve({ processed: true, run: null });
        })
        .mockRejectedValueOnce(projectOneError),
      mergeGlobalMemory: vi.fn(async () => {
        order.push('global');
        return { processed: true, run: null };
      }),
    });

    await expect(test.service.runNow()).rejects.toBeInstanceOf(AggregateError);

    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(2);
    expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledOnce();
    expect(order.at(-1)).toBe('global');
    expect(test.dependencies.logFailure).toHaveBeenCalledWith({
      scope: 'project',
      projectId: 'project-1',
      phase: 'extraction',
      error: projectOneError,
    });

    await test.service.runNow();

    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(2);
    expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledOnce();

    test.setNow('2026-07-19T08:15:00.000Z');
    await test.service.runNow();

    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledTimes(4);
    expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledTimes(2);
  });

  it('tracks failed global attempts separately and retries at the interval', async () => {
    const mergeError = new Error('global failed');
    const mergeGlobalMemory = vi
      .fn()
      .mockRejectedValueOnce(mergeError)
      .mockResolvedValue({ processed: true, run: null });
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      mergeGlobalMemory,
    });

    await expect(test.service.runNow()).rejects.toBeInstanceOf(AggregateError);
    await test.service.runNow();

    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledOnce();
    expect(mergeGlobalMemory).toHaveBeenCalledOnce();
    test.setNow('2026-07-19T08:15:00.000Z');
    await test.service.runNow();
    expect(mergeGlobalMemory).toHaveBeenCalledTimes(2);
    expect(test.dependencies.logFailure).toHaveBeenCalledWith({
      scope: 'global',
      phase: 'merge',
      error: mergeError,
    });
  });

  it('throttles a persistently failing project across minute polls', async () => {
    const extractProjectMemory = vi.fn().mockRejectedValue(new Error('failed'));
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      extractProjectMemory,
    });

    await expect(test.service.runNow()).rejects.toBeInstanceOf(AggregateError);
    for (let minute = 1; minute < 15; minute += 1) {
      test.setNow(
        `2026-07-19T08:${String(minute).padStart(2, '0')}:00.000Z`,
      );
      await test.service.runNow();
    }
    expect(extractProjectMemory).toHaveBeenCalledOnce();

    test.setNow('2026-07-19T08:15:00.000Z');
    await expect(test.service.runNow()).rejects.toBeInstanceOf(AggregateError);
    expect(extractProjectMemory).toHaveBeenCalledTimes(2);
  });

  it('recovers failed-attempt throttling from run history after restart', async () => {
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      readRunTiming: vi.fn(async ({ scope }: { scope: 'project' | 'global' }) =>
        scope === 'project'
          ? {
              lastAttemptAt: '2026-07-19T07:55:00.000Z',
              lastSuccessAt: null,
            }
          : { lastAttemptAt: null, lastSuccessAt: null },
      ),
    });

    await test.service.runNow();
    expect(test.dependencies.extractProjectMemory).not.toHaveBeenCalled();

    test.setNow('2026-07-19T08:10:00.000Z');
    await test.service.runNow();
    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledOnce();
  });

  it('persists successful no-op attempt timing so restart does not repeat the daily sweep', async () => {
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      extractProjectMemory: vi.fn().mockResolvedValue({ processed: false, run: null }),
      mergeGlobalMemory: vi.fn().mockResolvedValue({ processed: false, run: null }),
    });

    await test.service.runNow();

    expect(test.dependencies.recordRunTiming).toHaveBeenCalledWith({
      scope: 'project',
      projectId: 'project-1',
      attemptedAt: '2026-07-19T08:00:00.000Z',
      succeeded: true,
    });
    expect(test.dependencies.recordRunTiming).toHaveBeenCalledWith({
      scope: 'global',
      attemptedAt: '2026-07-19T08:00:00.000Z',
      succeeded: true,
    });
  });

  it('skips projects removed from the database before extraction and global merge', async () => {
    const test = harness({
      findProjectById: vi.fn(async (id: string) =>
        id === 'project-1' ? project(id) : undefined,
      ),
    });

    await test.service.runNow();

    expect(test.dependencies.extractProjectMemory).toHaveBeenCalledOnce();
    expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledWith(
      expect.objectContaining({ projectIds: ['project-1'] }),
    );
  });

  it('rechecks deletion inside extraction and excludes the deleted project from global merge', async () => {
    let lookupCount = 0;
    const findProjectById = vi.fn(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? project('project-1') : undefined;
    });
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById,
      extractProjectMemory: vi.fn(
        async ({
          recheckProjectExists,
        }: {
          recheckProjectExists?: () => Promise<boolean>;
        }) => {
          if (!(await recheckProjectExists?.())) {
            throw new Error('Project deleted');
          }
          return { processed: true, run: null };
        },
      ),
    });

    await expect(test.service.runNow()).rejects.toBeInstanceOf(AggregateError);

    expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledWith(
      expect.objectContaining({ projectIds: [] }),
    );
  });

  it('prevents overlapping sweeps and has idempotent start and stop lifecycle', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      extractProjectMemory: vi.fn(async () => {
        await blocked;
        return { processed: true, run: null };
      }),
    });

    test.service.start();
    test.service.start();
    await vi.waitFor(() => {
      expect(test.dependencies.extractProjectMemory).toHaveBeenCalledOnce();
    });
    const overlapping = test.service.runNow();
    expect(test.dependencies.setInterval).toHaveBeenCalledOnce();
    expect(test.dependencies.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      60_000,
    );

    test.service.stop();
    test.service.stop();
    expect(test.dependencies.clearInterval).toHaveBeenCalledOnce();
    release?.();
    await expect(overlapping).rejects.toThrow('Agent Memory extraction canceled');
    vi.useRealTimers();
  });

  it('cancels a direct in-flight sweep and skips global merge', async () => {
    let extractionSignal: AbortSignal | undefined;
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      extractProjectMemory: vi.fn(
        ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            extractionSignal = signal;
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    });

    const sweep = test.service.runNow();
    await vi.waitFor(() => expect(extractionSignal).toBeDefined());
    const cancellation = test.service.cancelCurrent();

    await expect(sweep).rejects.toThrow('Agent Memory extraction canceled');
    await cancellation;
    expect(extractionSignal?.aborted).toBe(true);
    expect(test.dependencies.mergeGlobalMemory).not.toHaveBeenCalled();
  });

  it('surfaces aggregate scheduled failures to the scheduler logger', async () => {
    vi.useFakeTimers();
    const test = harness({
      findProjects: vi.fn().mockResolvedValue([project('project-1')]),
      findProjectById: vi.fn().mockResolvedValue(project('project-1')),
      extractProjectMemory: vi.fn().mockRejectedValue(new Error('failed')),
    });

    test.service.start();

    await vi.waitFor(() => {
      expect(test.dependencies.logSweepFailure).toHaveBeenCalledWith(
        expect.any(AggregateError),
      );
    });
    expect(test.dependencies.mergeGlobalMemory).toHaveBeenCalledOnce();
    test.service.stop();
    vi.useRealTimers();
  });
});
