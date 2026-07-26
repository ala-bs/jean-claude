import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const executeTakeFirst = vi.fn();
  const insertExecute = vi.fn();
  const insertValues = vi.fn(() => ({
    onConflict: (
      callback: (builder: { column: (name: string) => unknown }) => unknown,
    ) => {
      callback({
        column: () => ({
          doUpdateSet: () => ({}),
          doNothing: () => ({}),
        }),
      });
      return {
        execute: insertExecute,
      };
    },
  }));
  const insertInto = vi.fn(() => ({
    values: insertValues,
  }));
  const selectAll = vi.fn(() => ({
    executeTakeFirst,
  }));
  const where = vi.fn(() => ({
    selectAll,
  }));
  const selectFrom = vi.fn(() => ({
    where,
  }));

  const dbMock = {
    insertInto,
    selectFrom,
    transaction: vi.fn(() => ({
      execute: (operation: (trx: unknown) => Promise<unknown>) =>
        operation(dbMock),
    })),
  };

  return {
    dbMock,
    executeTakeFirst,
    insertExecute,
    insertInto,
  };
});

const { executeTakeFirst, insertExecute, insertInto } = mocks;

vi.mock('../index', () => ({
  db: mocks.dbMock,
}));

vi.mock('../../lib/debug', () => ({
  dbg: {
    db: vi.fn(),
  },
}));

import { SettingsRepository } from './settings';

describe('SettingsRepository legacy normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default PR review agent setting', async () => {
    executeTakeFirst.mockResolvedValue(undefined);

    await expect(SettingsRepository.get('prReviewAgent')).resolves.toEqual({
      backend: null,
      modelPreference: 'default',
      thinkingEffort: 'default',
    });

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('allows PR review agent setting to inherit backend with explicit model and thinking', async () => {
    insertExecute.mockResolvedValue(undefined);

    await expect(
      SettingsRepository.set('prReviewAgent', {
        backend: null,
        modelPreference: 'sonnet',
        thinkingEffort: 'high',
      }),
    ).resolves.toBeUndefined();

    expect(insertInto).toHaveBeenCalledWith('settings');
  });

  it('normalizes legacy backend default models missing codex', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'backendDefaultModels',
      value: JSON.stringify({
        models: {
          'claude-code': 'sonnet',
          opencode: 'openai/gpt-5',
        },
      }),
      updatedAt: '2026-06-12T00:00:00.000Z',
    });
    insertExecute.mockResolvedValue(undefined);

    await expect(
      SettingsRepository.get('backendDefaultModels'),
    ).resolves.toEqual({
      models: {
        'claude-code': 'sonnet',
        opencode: 'openai/gpt-5',
        codex: 'default',
        copilot: 'default',
        vibe: 'default',
      },
    });

    expect(insertInto).toHaveBeenCalledWith('settings');
  });

  it('normalizes legacy thinking settings missing codex', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'thinkingSettings',
      value: JSON.stringify({
        efforts: {
          'claude-code': { default: 'high', sonnet: 'max' },
          opencode: { default: 'medium' },
        },
        selectedModels: {
          'claude-code': 'sonnet',
          opencode: 'openai/gpt-5',
        },
      }),
      updatedAt: '2026-06-12T00:00:00.000Z',
    });
    insertExecute.mockResolvedValue(undefined);

    await expect(SettingsRepository.get('thinkingSettings')).resolves.toEqual({
      efforts: {
        'claude-code': { default: 'high', sonnet: 'max' },
        opencode: { default: 'medium' },
        codex: { default: 'default' },
        copilot: { default: 'default' },
        vibe: { default: 'default' },
      },
      selectedModels: {
        'claude-code': 'sonnet',
        opencode: 'openai/gpt-5',
        codex: 'default',
        copilot: 'default',
        vibe: 'default',
      },
    });

    expect(insertInto).toHaveBeenCalledWith('settings');
  });

  it('keeps valid calendar notification app join target', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'calendarNotifications',
      value: JSON.stringify({
        enabled: true,
        leadTimeMinutes: 5,
        showStartWindow: true,
        meetingJoinTarget: 'app',
      }),
      updatedAt: '2026-06-12T00:00:00.000Z',
    });

    await expect(
      SettingsRepository.get('calendarNotifications'),
    ).resolves.toEqual({
      enabled: true,
      leadTimeMinutes: 5,
      showStartWindow: true,
      meetingJoinTarget: 'app',
    });

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('normalizes work activity setting to enabled unless explicitly false', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'workActivity',
      value: JSON.stringify({ enabled: 'yes' }),
      updatedAt: '2026-06-12T00:00:00.000Z',
    });
    insertExecute.mockResolvedValue(undefined);

    await expect(SettingsRepository.get('workActivity')).resolves.toEqual({
      enabled: true,
    });

    expect(insertInto).toHaveBeenCalledWith('settings');
  });

  it('keeps valid work activity setting without rewriting it', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'workActivity',
      value: JSON.stringify({ enabled: false }),
      updatedAt: '2026-06-12T00:00:00.000Z',
    });

    await expect(SettingsRepository.get('workActivity')).resolves.toEqual({
      enabled: false,
    });

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('maps shipped Preference Memory persistence to Agent Memory', async () => {
    executeTakeFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        key: 'preferenceMemory',
        value: JSON.stringify({
          enabled: true,
          consolidationEnabled: false,
          consolidationIntervalMinutes: 45,
          consolidationBackend: 'opencode',
          consolidationModel: 'openai/gpt-5',
          consolidationThinkingEffort: 'high',
        }),
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
    insertExecute.mockResolvedValue(undefined);

    await expect(SettingsRepository.get('agentMemory')).resolves.toEqual({
      enabled: true,
      extractionIntervalMinutes: 45,
      extractionBackend: 'opencode',
      extractionModel: 'openai/gpt-5',
      extractionThinkingEffort: 'high',
    });

    expect(insertInto).toHaveBeenCalledWith('settings');
  });

  it('returns mapped Agent Memory when persisting the migration fails', async () => {
    executeTakeFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        key: 'preferenceMemory',
        value: JSON.stringify({
          enabled: true,
          consolidationEnabled: false,
          consolidationIntervalMinutes: 90,
          consolidationBackend: 'opencode',
          consolidationModel: 'openai/gpt-5',
          consolidationThinkingEffort: 'high',
        }),
        updatedAt: '2026-07-01T00:00:00.000Z',
      });
    insertExecute.mockRejectedValue(new Error('settings write failed'));

    await expect(SettingsRepository.get('agentMemory')).resolves.toEqual({
      enabled: true,
      extractionIntervalMinutes: 90,
      extractionBackend: 'opencode',
      extractionModel: 'openai/gpt-5',
      extractionThinkingEffort: 'high',
    });
  });

  it('does not overwrite a concurrent Agent Memory update during lazy migration', async () => {
    const concurrent = {
      enabled: false,
      extractionIntervalMinutes: 30,
      extractionBackend: 'claude-code',
      extractionModel: 'sonnet',
      extractionThinkingEffort: 'high',
    };
    executeTakeFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        key: 'preferenceMemory',
        value: JSON.stringify({
          enabled: true,
          consolidationIntervalMinutes: 90,
          consolidationBackend: 'opencode',
          consolidationModel: 'openai/gpt-5',
          consolidationThinkingEffort: 'low',
        }),
        updatedAt: '2026-07-01T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        key: 'agentMemory',
        value: JSON.stringify(concurrent),
        updatedAt: '2026-07-19T00:00:00.000Z',
      });

    await expect(SettingsRepository.get('agentMemory')).resolves.toEqual(
      concurrent,
    );

    expect(mocks.dbMock.transaction).toHaveBeenCalledOnce();
    expect(insertInto).not.toHaveBeenCalled();
  });

  it('does not accept the retired consolidation flag in Agent Memory', async () => {
    await expect(
      SettingsRepository.set('agentMemory', {
        enabled: true,
        extractionIntervalMinutes: 30,
        extractionBackend: 'claude-code',
        extractionModel: 'haiku',
        extractionThinkingEffort: 'default',
        consolidationEnabled: true,
      } as never),
    ).rejects.toThrow('Invalid value for setting "agentMemory"');
  });
});
