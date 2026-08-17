import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createLocalStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function persistedJob({
  id,
  status,
  ageDays = 0,
  promptSize = 10,
}: {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  ageDays?: number;
  promptSize?: number;
}) {
  const at = new Date(Date.now() - ageDays * 86_400_000).toISOString();
  return {
    id,
    type: 'task-creation',
    title: id,
    status,
    createdAt: at,
    completedAt: status === 'running' ? null : at,
    errorMessage: null,
    warningMessage: null,
    taskId: null,
    projectId: null,
    noteId: null,
    details: {
      projectName: null,
      promptPreview: null,
      backlogTodoIds: [],
      creationInput: { prompt: 'x'.repeat(promptSize) },
    },
  };
}

function seed(jobs: unknown[]) {
  localStorage.setItem(
    'background-jobs',
    JSON.stringify({ state: { jobs }, version: 0 }),
  );
}

describe('background jobs store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shrinks an oversized persisted payload on rehydrate, with no user action', async () => {
    // A user upgrading from the build that persisted jobs unbounded: every job
    // is finished, so nothing would ever call `set` and trigger a prune.
    seed(
      Array.from({ length: 60 }, (_, i) =>
        persistedJob({
          id: `old${i}`,
          status: 'succeeded',
          promptSize: 40_000,
          ageDays: i / 100,
        }),
      ),
    );
    const before = localStorage.getItem('background-jobs')?.length ?? 0;
    expect(before).toBeGreaterThan(2_000_000);

    await import('./background-jobs');

    // `length` is UTF-16 code units; the budget is bytes.
    const after = (localStorage.getItem('background-jobs')?.length ?? 0) * 2;
    expect(after).toBeLessThanOrEqual(512 * 1024);
    expect(after).toBeLessThan(before);
  });

  it('fails interrupted jobs BEFORE pruning, so a restart cannot leave an oversized payload', async () => {
    // Running jobs are exempt from byte eviction. If the boot repair pruned
    // first, these would all survive the prune and only then become failed —
    // leaving the very payload the fix exists to remove.
    seed(
      Array.from({ length: 40 }, (_, i) =>
        persistedJob({ id: `stuck${i}`, status: 'running', promptSize: 40_000 }),
      ),
    );

    const { useBackgroundJobsStore } = await import('./background-jobs');

    const jobs = useBackgroundJobsStore.getState().jobs;
    expect(jobs.every((j) => j.status === 'failed')).toBe(true);
    const persisted = (localStorage.getItem('background-jobs')?.length ?? 0) * 2;
    expect(persisted).toBeLessThanOrEqual(512 * 1024);
  });

  it('repairs in a single write instead of one per interrupted job', async () => {
    seed(
      Array.from({ length: 5 }, (_, i) =>
        persistedJob({ id: `stuck${i}`, status: 'running' }),
      ),
    );
    const writes: string[] = [];
    const raw = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'background-jobs') writes.push(value);
      raw(key, value);
    });

    await import('./background-jobs');

    expect(writes).toHaveLength(1);
  });

  it('survives a corrupt persisted payload', async () => {
    localStorage.setItem(
      'background-jobs',
      JSON.stringify({ state: { jobs: { not: 'an array' } }, version: 0 }),
    );

    const { useBackgroundJobsStore } = await import('./background-jobs');

    expect(useBackgroundJobsStore.getState().jobs).toEqual([]);
  });

  it('keeps working when the persist write throws (quota exhausted)', async () => {
    seed([persistedJob({ id: 'in-flight', status: 'running' })]);
    const raw = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'background-jobs') {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      raw(key, value);
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const { useBackgroundJobsStore } = await import('./background-jobs');

    // Zustand swallows throws from onRehydrateStorage, so the failure must be
    // reported — and in-memory repair must still have happened.
    expect(consoleError).toHaveBeenCalled();
    expect(
      useBackgroundJobsStore.getState().jobs.find((j) => j.id === 'in-flight')
        ?.status,
    ).toBe('failed');
    consoleError.mockRestore();
  });

  it('drops jobs past the TTL on rehydrate', async () => {
    seed([
      persistedJob({ id: 'stale', status: 'succeeded', ageDays: 30 }),
      persistedJob({ id: 'fresh', status: 'succeeded', ageDays: 1 }),
    ]);

    const { useBackgroundJobsStore } = await import('./background-jobs');

    expect(useBackgroundJobsStore.getState().jobs.map((j) => j.id)).toEqual([
      'fresh',
    ]);
  });

  it('still fails interrupted running jobs on rehydrate', async () => {
    seed([persistedJob({ id: 'in-flight', status: 'running' })]);

    const { useBackgroundJobsStore } = await import('./background-jobs');

    const job = useBackgroundJobsStore
      .getState()
      .jobs.find((j) => j.id === 'in-flight');
    expect(job?.status).toBe('failed');
    expect(job?.errorMessage).toBe('Interrupted by app restart');
  });

  it('bounds the in-memory list when adding jobs', async () => {
    const { useBackgroundJobsStore } = await import('./background-jobs');

    for (let i = 0; i < 120; i++) {
      const id = useBackgroundJobsStore.getState().addRunningJob({
        type: 'commit',
        title: `job ${i}`,
        details: { message: 'm' },
      });
      useBackgroundJobsStore.getState().markJobSucceeded(id);
    }

    const jobs = useBackgroundJobsStore.getState().jobs;
    expect(jobs.length).toBeLessThanOrEqual(51);
  });
});
