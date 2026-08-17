import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProjectSettingsAutosave,
  createProjectSettingsSaveQueue,
  flushProjectSettings,
  getProjectSettingsSaveData,
  type ProjectSettingsSave,
} from './utils-project-settings-save-data';
import { STARTER_WORK_ITEM_TITLE_PARSER_SETTING } from '@shared/work-item-title-parser-types';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getProjectSettingsSaveData', () => {
  it('keeps only dirty fields to avoid overwriting concurrent updates', () => {
    expect(
      getProjectSettingsSaveData({
        data: {
          name: 'Jean Claude',
          summary: null,
          color: '#7c3aed',
        },
        dirtyFields: new Set(['name', 'color']),
      }),
    ).toEqual({
      name: 'Jean Claude',
      color: '#7c3aed',
    });
  });

  it('keeps summary when user edited it', () => {
    expect(
      getProjectSettingsSaveData({
        data: {
          name: 'Jean Claude',
          summary: null,
        },
        dirtyFields: new Set(['summary']),
      }),
    ).toEqual({
      summary: null,
    });
  });

  it('keeps work item title parser when user edited it', () => {
    expect(
      getProjectSettingsSaveData({
        data: {
          name: 'Jean Claude',
          workItemTitleParser: STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
        },
        dirtyFields: new Set(['workItemTitleParser']),
      }),
    ).toEqual({
      workItemTitleParser: STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
    });
  });

  it('flushes latest dirty data immediately when disposed before debounce', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const data = { name: 'Before' };
    const dirtyFields = new Set<keyof ProjectSettingsSave['data']>(['name']);
    const dirtyFieldVersions = new Map<keyof ProjectSettingsSave['data'], number>([
      ['name', 1],
    ]);
    const autosave = createProjectSettingsAutosave({
      save: () => {
        flushProjectSettings({ data, dirtyFields, dirtyFieldVersions, save });
      },
    });

    autosave.schedule();
    data.name = 'Latest';
    dirtyFieldVersions.set('name', 2);
    autosave.flush();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({
      data: { name: 'Latest' },
      fieldVersions: new Map([['name', 2]]),
    });

    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledOnce();
  });

  it('debounces repeated schedules for 500ms', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const autosave = createProjectSettingsAutosave({ save });

    autosave.schedule();
    vi.advanceTimersByTime(400);
    autosave.schedule();
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledOnce();
  });

  it('flushes only dirty parser data', () => {
    const save = vi.fn();

    flushProjectSettings({
      data: {
        name: 'Jean Claude',
        color: '#7c3aed',
        workItemTitleParser: STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
      },
      dirtyFields: new Set(['workItemTitleParser']),
      dirtyFieldVersions: new Map([['workItemTitleParser', 3]]),
      save,
    });

    expect(save).toHaveBeenCalledWith({
      data: {
        workItemTitleParser: STARTER_WORK_ITEM_TITLE_PARSER_SETTING,
      },
      fieldVersions: new Map([['workItemTitleParser', 3]]),
    });
  });

  it('continues with latest queued save after prior save fails', async () => {
    const firstSave = deferred<void>();
    const savedData: ProjectSettingsSave['data'][] = [];
    const onError = vi.fn();
    const queue = createProjectSettingsSaveQueue({
      save: async (save) => {
        savedData.push(save.data);
        if (savedData.length === 1) await firstSave.promise;
      },
      onSuccess: vi.fn(),
      onError,
    });
    const firstDrain = queue.enqueue({
      data: { name: 'First' },
      fieldVersions: new Map([['name', 1]]),
    });
    queue.enqueue({
      data: { name: 'Superseded' },
      fieldVersions: new Map([['name', 2]]),
    });
    queue.enqueue({
      data: { name: 'Latest' },
      fieldVersions: new Map([['name', 3]]),
    });

    firstSave.reject(new Error('first failed'));
    await firstDrain;

    expect(savedData).toEqual([{ name: 'First' }, { name: 'Latest' }]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('discards an identical queued retry when the active save succeeds', async () => {
    const activeSave = deferred<void>();
    const save = vi.fn(() => activeSave.promise);
    const dirtyFields = new Set<keyof ProjectSettingsSave['data']>(['name']);
    const dirtyFieldVersions = new Map<keyof ProjectSettingsSave['data'], number>([
      ['name', 1],
    ]);
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess: (saved, queuedSave) => {
        for (const [field, version] of saved.fieldVersions) {
          if (
            dirtyFieldVersions.get(field) === version &&
            !queuedSave?.fieldVersions.has(field)
          ) {
            dirtyFields.delete(field);
            dirtyFieldVersions.delete(field);
          }
        }
      },
      onError: vi.fn(),
    });
    const pendingSave: ProjectSettingsSave = {
      data: { name: 'Saved' },
      fieldVersions: new Map([['name', 1]]),
    };

    const drain = queue.enqueue(pendingSave);
    queue.enqueue({
      data: { name: 'Saved' },
      fieldVersions: new Map([['name', 1]]),
    });
    activeSave.resolve();
    await drain;

    expect(save).toHaveBeenCalledOnce();
    expect(dirtyFields).toEqual(new Set());
    expect(dirtyFieldVersions).toEqual(new Map());
  });

  it('retries an identical queued save once when the active save fails', async () => {
    const activeSave = deferred<void>();
    const save = vi
      .fn<(save: ProjectSettingsSave) => Promise<void>>()
      .mockImplementationOnce(() => activeSave.promise)
      .mockResolvedValueOnce();
    const onError = vi.fn();
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess: vi.fn(),
      onError,
    });
    const pendingSave: ProjectSettingsSave = {
      data: { name: 'Retry' },
      fieldVersions: new Map([['name', 1]]),
    };

    const drain = queue.enqueue(pendingSave);
    queue.enqueue({
      data: { name: 'Retry' },
      fieldVersions: new Map([['name', 1]]),
    });
    activeSave.reject(new Error('first failed'));
    await drain;

    expect(save).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('prunes matching fields from a partially overlapping queue after success', async () => {
    const activeSave = deferred<void>();
    const save = vi
      .fn<(save: ProjectSettingsSave) => Promise<void>>()
      .mockImplementationOnce(() => activeSave.promise)
      .mockResolvedValueOnce();
    const onSuccess = vi.fn();
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess,
      onError: vi.fn(),
    });
    const active: ProjectSettingsSave = {
      data: { name: 'Saved' },
      fieldVersions: new Map([['name', 1]]),
    };
    const queued: ProjectSettingsSave = {
      data: { name: 'Saved', color: '#123456' },
      fieldVersions: new Map([
        ['name', 1],
        ['color', 1],
      ]),
    };

    const drain = queue.enqueue(active);
    queue.enqueue(queued);
    activeSave.resolve();
    await drain;

    const prunedQueuedSave = {
      data: { color: '#123456' },
      fieldVersions: new Map([['color', 1]]),
    };
    expect(save).toHaveBeenNthCalledWith(2, prunedQueuedSave);
    expect(onSuccess).toHaveBeenNthCalledWith(1, active, prunedQueuedSave);
    expect(queued).toEqual({
      data: { name: 'Saved', color: '#123456' },
      fieldVersions: new Map([
        ['name', 1],
        ['color', 1],
      ]),
    });
  });

  it('keeps every queued field after an overlapping active save fails', async () => {
    const activeSave = deferred<void>();
    const save = vi
      .fn<(save: ProjectSettingsSave) => Promise<void>>()
      .mockImplementationOnce(() => activeSave.promise)
      .mockResolvedValueOnce();
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });
    const active: ProjectSettingsSave = {
      data: { name: 'Saved' },
      fieldVersions: new Map([['name', 1]]),
    };
    const queued: ProjectSettingsSave = {
      data: { name: 'Saved', color: '#123456' },
      fieldVersions: new Map([
        ['name', 1],
        ['color', 1],
      ]),
    };

    const drain = queue.enqueue(active);
    queue.enqueue(queued);
    activeSave.reject(new Error('active failed'));
    await drain;

    expect(save).toHaveBeenNthCalledWith(2, queued);
  });

  it('keeps newer overlapping fields after active success', async () => {
    const activeSave = deferred<void>();
    const save = vi
      .fn<(save: ProjectSettingsSave) => Promise<void>>()
      .mockImplementationOnce(() => activeSave.promise)
      .mockResolvedValueOnce();
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });
    const active: ProjectSettingsSave = {
      data: { name: 'First' },
      fieldVersions: new Map([['name', 1]]),
    };
    const queued: ProjectSettingsSave = {
      data: { name: 'Latest', color: '#123456' },
      fieldVersions: new Map([
        ['name', 2],
        ['color', 1],
      ]),
    };

    const drain = queue.enqueue(active);
    queue.enqueue(queued);
    activeSave.resolve();
    await drain;

    expect(save).toHaveBeenNthCalledWith(2, queued);
  });

  it('sends a queued save with newer field versions after active success', async () => {
    const activeSave = deferred<void>();
    const save = vi
      .fn<(save: ProjectSettingsSave) => Promise<void>>()
      .mockImplementationOnce(() => activeSave.promise)
      .mockResolvedValueOnce();
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess: vi.fn(),
      onError: vi.fn(),
    });
    const active: ProjectSettingsSave = {
      data: { name: 'First' },
      fieldVersions: new Map([['name', 1]]),
    };
    const newer: ProjectSettingsSave = {
      data: { name: 'Latest' },
      fieldVersions: new Map([['name', 2]]),
    };

    const drain = queue.enqueue(active);
    queue.enqueue(newer);
    activeSave.resolve();
    await drain;

    expect(save).toHaveBeenNthCalledWith(1, active);
    expect(save).toHaveBeenNthCalledWith(2, newer);
  });

  it('does not retry again after the single queued retry fails', async () => {
    const activeSave = deferred<void>();
    const save = vi
      .fn<(save: ProjectSettingsSave) => Promise<void>>()
      .mockImplementationOnce(() => activeSave.promise)
      .mockRejectedValueOnce(new Error('retry failed'));
    const onError = vi.fn();
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess: vi.fn(),
      onError,
    });
    const pendingSave: ProjectSettingsSave = {
      data: { name: 'Retry' },
      fieldVersions: new Map([['name', 1]]),
    };

    const drain = queue.enqueue(pendingSave);
    queue.enqueue({
      data: { name: 'Retry' },
      fieldVersions: new Map([['name', 1]]),
    });
    activeSave.reject(new Error('first failed'));
    await drain;

    expect(save).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('does not resend fields cleared by a completed save', async () => {
    const dirtyFields = new Set<keyof ProjectSettingsSave['data']>(['name']);
    const dirtyFieldVersions = new Map<keyof ProjectSettingsSave['data'], number>([
      ['name', 1],
    ]);
    const save = vi.fn(async () => {});
    const queue = createProjectSettingsSaveQueue({
      save,
      onSuccess: (saved, queuedSave) => {
        for (const [field, version] of saved.fieldVersions) {
          if (
            dirtyFieldVersions.get(field) === version &&
            !queuedSave?.fieldVersions.has(field)
          ) {
            dirtyFields.delete(field);
            dirtyFieldVersions.delete(field);
          }
        }
      },
      onError: vi.fn(),
    });

    flushProjectSettings({
      data: { name: 'Saved' },
      dirtyFields,
      dirtyFieldVersions,
      save: (pendingSave) => void queue.enqueue(pendingSave),
    });
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    expect(
      flushProjectSettings({
        data: { name: 'Saved' },
        dirtyFields,
        dirtyFieldVersions,
        save: (pendingSave) => void queue.enqueue(pendingSave),
      }),
    ).toBe(false);
    expect(save).toHaveBeenCalledOnce();
  });
});
