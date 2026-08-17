import { describe, expect, it, vi } from 'vitest';

vi.mock('../database/repositories', () => ({ TaskRepository: {} }));
vi.mock('./cache-event-service', () => ({ emitTaskUpsert: vi.fn() }));

import { withTaskSessionRulesLock } from './task-session-rules-service';

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: resolve! };
}

describe('withTaskSessionRulesLock', () => {
  it('serializes mutations for one task', async () => {
    const firstCanFinish = deferred();
    const firstStarted = deferred();
    const order: string[] = [];

    const first = withTaskSessionRulesLock('task-1', async () => {
      order.push('first-start');
      firstStarted.resolve();
      await firstCanFinish.promise;
      order.push('first-end');
    });
    await firstStarted.promise;
    const second = withTaskSessionRulesLock('task-1', async () => {
      order.push('second');
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    firstCanFinish.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('allows different tasks to mutate concurrently', async () => {
    const firstCanFinish = deferred();
    const order: string[] = [];

    const first = withTaskSessionRulesLock('task-1', async () => {
      order.push('first-start');
      await firstCanFinish.promise;
    });
    const second = withTaskSessionRulesLock('task-2', async () => {
      order.push('second');
    });

    await second;
    expect(order).toEqual(['first-start', 'second']);
    firstCanFinish.resolve();
    await first;
  });
});
