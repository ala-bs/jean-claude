import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  prunePersistedJobs,
  resetBudgetOverflowWarning,
  type BackgroundJob,
} from './background-jobs';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function job({
  id,
  status,
  ageDays = 0,
  promptSize = 10,
  completedAt,
}: {
  id: string;
  status: BackgroundJob['status'];
  ageDays?: number;
  promptSize?: number;
  completedAt?: string | null;
}): BackgroundJob {
  const at = new Date(NOW.getTime() - ageDays * DAY_MS).toISOString();
  return {
    id,
    type: 'task-creation',
    title: id,
    status,
    createdAt: at,
    completedAt:
      completedAt !== undefined
        ? completedAt
        : status === 'running'
          ? null
          : at,
    errorMessage: null,
    warningMessage: null,
    taskId: null,
    projectId: null,
    noteId: null,
    details: {
      projectName: null,
      promptPreview: null,
      backlogTodoIds: [],
      // Only `prompt` matters for size; the rest of the creation input is irrelevant here.
      creationInput: { prompt: 'x'.repeat(promptSize) } as never,
    },
  } as BackgroundJob;
}

describe('prunePersistedJobs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetBudgetOverflowWarning();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps every running job', () => {
    const jobs = Array.from({ length: 80 }, (_, i) =>
      job({ id: `r${i}`, status: 'running' }),
    );
    expect(prunePersistedJobs(jobs)).toHaveLength(80);
  });

  it('keeps in-flight running jobs even when they alone blow the budget, and drops every finished job to make room', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const kept = prunePersistedJobs([
      ...Array.from({ length: 10 }, (_, i) =>
        job({ id: `r${i}`, status: 'running', promptSize: 200_000 }),
      ),
      job({ id: 'tiny-recent', status: 'succeeded' }),
    ]);
    // Running jobs are live work: losing them would orphan in-flight operations.
    expect(kept.filter((j) => j.status === 'running')).toHaveLength(10);
    // Budget is negative, so nothing disposable survives...
    expect(kept.map((j) => j.id)).not.toContain('tiny-recent');
    // ...and the overflow is reported rather than surfacing as a quota error later.
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('caps finished jobs at 50, keeping the newest', () => {
    const jobs = Array.from({ length: 200 }, (_, i) =>
      job({ id: `f${i}`, status: 'succeeded', ageDays: i / 100 }),
    );
    const kept = prunePersistedJobs(jobs);
    expect(kept).toHaveLength(50);
    expect(kept[0].id).toBe('f0');
    expect(kept.at(-1)?.id).toBe('f49');
  });

  it('keeps the newest regardless of input ordering', () => {
    const kept = prunePersistedJobs([
      job({ id: 'oldest', status: 'succeeded', ageDays: 5 }),
      job({ id: 'newest', status: 'succeeded', ageDays: 0 }),
      job({ id: 'middle', status: 'succeeded', ageDays: 2 }),
    ]);
    expect(kept.map((j) => j.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('drops finished jobs older than 7 days, exactly at the boundary', () => {
    const kept = prunePersistedJobs([
      job({ id: 'just-over', status: 'succeeded', ageDays: 7.001 }),
      job({ id: 'just-under', status: 'succeeded', ageDays: 6.999 }),
    ]);
    expect(kept.map((j) => j.id)).toEqual(['just-under']);
  });

  it('treats an unparseable timestamp as expired instead of immortal', () => {
    const kept = prunePersistedJobs([
      job({ id: 'corrupt', status: 'succeeded', completedAt: 'N/A' }),
      job({ id: 'fine', status: 'succeeded' }),
    ]);
    expect(kept.map((j) => j.id)).toEqual(['fine']);
  });

  it('falls back to createdAt when completedAt is null', () => {
    const kept = prunePersistedJobs([
      job({ id: 'old', status: 'failed', ageDays: 9, completedAt: null }),
      job({ id: 'recent', status: 'failed', ageDays: 1, completedAt: null }),
    ]);
    expect(kept.map((j) => j.id)).toEqual(['recent']);
  });

  it('enforces the byte ceiling', () => {
    const jobs = Array.from({ length: 20 }, (_, i) =>
      job({
        id: `big${i}`,
        status: 'succeeded',
        promptSize: 100_000,
        ageDays: i / 100,
      }),
    );
    const kept = prunePersistedJobs(jobs);
    expect(JSON.stringify(kept).length * 2).toBeLessThanOrEqual(512 * 1024);
    expect(kept.length).toBeGreaterThan(0);
    // Newest survive, oldest are evicted.
    expect(kept[0].id).toBe('big0');
  });

  it('evicts succeeded jobs before failed ones, which are retryable', () => {
    const jobs = [
      job({ id: 'succeeded-new', status: 'succeeded', promptSize: 200_000 }),
      job({
        id: 'failed-old',
        status: 'failed',
        promptSize: 200_000,
        ageDays: 3,
      }),
    ];
    // Both cannot fit; the older failed job wins because only it is retryable.
    expect(prunePersistedJobs(jobs).map((j) => j.id)).toEqual(['failed-old']);
  });

  it('stops at the first job that does not fit instead of letting small old jobs leapfrog', () => {
    const kept = prunePersistedJobs([
      job({ id: 'newest-small', status: 'succeeded', ageDays: 0 }),
      job({ id: 'huge-middle', status: 'succeeded', ageDays: 1, promptSize: 600_000 }),
      job({ id: 'oldest-small', status: 'succeeded', ageDays: 2 }),
    ]);
    // `oldest-small` would fit, but keeping it would break the newest-first prefix.
    expect(kept.map((j) => j.id)).toEqual(['newest-small']);
  });

  it('keeps a job that completed exactly at the TTL boundary', () => {
    const kept = prunePersistedJobs([
      job({ id: 'exactly-7d', status: 'succeeded', ageDays: 7 }),
    ]);
    expect(kept.map((j) => j.id)).toEqual(['exactly-7d']);
  });

  it('clamps future timestamps so a skewed clock cannot make a job immortal', () => {
    const future = new Date(NOW.getTime() + 30 * DAY_MS).toISOString();
    const kept = prunePersistedJobs([
      job({ id: 'skewed', status: 'succeeded', completedAt: future }),
      job({ id: 'normal', status: 'succeeded', ageDays: 1 }),
    ]);
    // Clamped to `now`, so it sorts as the newest but is still TTL-eligible later.
    expect(kept.map((j) => j.id)).toEqual(['skewed', 'normal']);
  });

  it('does not let failed jobs crowd out every succeeded job', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const kept = prunePersistedJobs([
      ...Array.from({ length: 60 }, (_, i) =>
        job({ id: `f${i}`, status: 'failed', promptSize: 4_000, ageDays: 1 }),
      ),
      job({ id: 'recent-success', status: 'succeeded', ageDays: 0 }),
    ]);
    // The count cap is status-blind and applied before the byte accounting, so
    // the budget is never charged for the failed jobs that get sliced away...
    expect(kept).toHaveLength(50);
    // ...and the newest succeeded job is not crowded out by the failure burst.
    expect(kept.map((j) => j.id)).toContain('recent-success');
    // No false overflow alarm: what is actually persisted fits the budget.
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('skips byte eviction when the budget is not enforced', () => {
    const jobs = [
      job({ id: 'huge', status: 'succeeded', promptSize: 600_000 }),
      job({ id: 'small', status: 'succeeded', ageDays: 1 }),
    ];
    expect(
      prunePersistedJobs(jobs, { enforceByteBudget: false }).map((j) => j.id),
    ).toEqual(['huge', 'small']);
    expect(prunePersistedJobs(jobs).map((j) => j.id)).toEqual([]);
  });

  it('warns at most once per session about budget overflow', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const jobs = [job({ id: 'r', status: 'running', promptSize: 600_000 })];
    prunePersistedJobs(jobs);
    prunePersistedJobs(jobs);
    prunePersistedJobs(jobs);
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it('returns an empty list for a corrupt persisted value instead of throwing', () => {
    expect(prunePersistedJobs(null as unknown as BackgroundJob[])).toEqual([]);
    expect(
      prunePersistedJobs({ nope: true } as unknown as BackgroundJob[]),
    ).toEqual([]);
  });

  it('does not mutate its input', () => {
    const jobs = [
      job({ id: 'a', status: 'succeeded', ageDays: 9 }),
      job({ id: 'b', status: 'succeeded' }),
    ];
    prunePersistedJobs(jobs);
    expect(jobs.map((j) => j.id)).toEqual(['a', 'b']);
  });
});
