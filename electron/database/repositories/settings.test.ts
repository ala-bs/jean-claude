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

import {
  migrateLegacyModelSettingsToProfiles,
  migrateProfilePresetIdBindings,
  normalizeModelProfilesSetting,
  SettingsRepository,
} from './settings';

describe('SettingsRepository legacy normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps only enabledBackends on the backends setting', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'backends',
      value: JSON.stringify({ enabledBackends: ['claude-code'] }),
      updatedAt: '2026-09-19T00:00:00.000Z',
    });

    await expect(SettingsRepository.get('backends')).resolves.toEqual({
      enabledBackends: ['claude-code'],
    });

    expect(insertInto).not.toHaveBeenCalled();
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

  it('returns default Eurecia settings when none are persisted', async () => {
    executeTakeFirst.mockResolvedValue(undefined);

    await expect(SettingsRepository.get('eurecia')).resolves.toEqual({
      baseUrl: 'https://plateforme.eurecia.com',
      axis1Label: 'Project',
      axis2Label: 'Activity',
      axis3Label: 'Role',
    });

    expect(insertInto).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'http://plateforme.eurecia.com',
    'https://user:password@plateforme.eurecia.com',
    'https://plateforme.eurecia.com/path',
    'https://plateforme.eurecia.com?tenant=1',
    'https://plateforme.eurecia.com?',
    'https://plateforme.eurecia.com#tenant',
    'https://plateforme.eurecia.com#',
  ])('falls back for invalid Eurecia base URL %s', async (baseUrl) => {
    executeTakeFirst.mockResolvedValue({
      key: 'eurecia',
      value: JSON.stringify({
        baseUrl,
        axis1Label: 'Project',
        axis2Label: 'Activity',
        axis3Label: 'Role',
      }),
      updatedAt: '2026-07-14T00:00:00.000Z',
    });

    await expect(SettingsRepository.get('eurecia')).resolves.toEqual({
      baseUrl: 'https://plateforme.eurecia.com',
      axis1Label: 'Project',
      axis2Label: 'Activity',
      axis3Label: 'Role',
    });

    expect(insertInto).not.toHaveBeenCalled();
  });

  it('falls back for invalid Eurecia axis labels', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'eurecia',
      value: JSON.stringify({
        baseUrl: 'https://tenant.eurecia.com',
        axis1Label: ' ',
        axis2Label: 'Activity',
        axis3Label: 'Role',
      }),
      updatedAt: '2026-07-14T00:00:00.000Z',
    });

    await expect(SettingsRepository.get('eurecia')).resolves.toEqual({
      baseUrl: 'https://plateforme.eurecia.com',
      axis1Label: 'Project',
      axis2Label: 'Activity',
      axis3Label: 'Role',
    });
  });

  it.each(['Project\nAdmin', 'Activity\tInternal'])(
    'falls back for Eurecia axis label containing control characters',
    async (axis1Label) => {
      executeTakeFirst.mockResolvedValue({
        key: 'eurecia',
        value: JSON.stringify({
          baseUrl: 'https://tenant.eurecia.com',
          axis1Label,
          axis2Label: 'Activity',
          axis3Label: 'Role',
        }),
        updatedAt: '2026-07-14T00:00:00.000Z',
      });

      await expect(SettingsRepository.get('eurecia')).resolves.toEqual({
        baseUrl: 'https://plateforme.eurecia.com',
        axis1Label: 'Project',
        axis2Label: 'Activity',
        axis3Label: 'Role',
      });
    },
  );

  it.each([
    {
      baseUrl: 'https://tenant.eurecia.com',
      axis1Label: 'A'.repeat(101),
      axis2Label: 'Activity',
      axis3Label: 'Role',
    },
    {
      baseUrl: 'https://tenant.eurecia.com',
      axis1Label: 'Project',
      axis2Label: 'Activity',
    },
    {
      baseUrl: 'https://tenant.eurecia.com',
      axis1Label: 'Project',
      axis2Label: 'Activity',
      axis3Label: 'Role',
      extraAxisLabel: 'Duplicate',
    },
  ])('falls back for invalid Eurecia setting shape', async (value) => {
    executeTakeFirst.mockResolvedValue({
      key: 'eurecia',
      value: JSON.stringify(value),
      updatedAt: '2026-07-14T00:00:00.000Z',
    });

    await expect(SettingsRepository.get('eurecia')).resolves.toEqual({
      baseUrl: 'https://plateforme.eurecia.com',
      axis1Label: 'Project',
      axis2Label: 'Activity',
      axis3Label: 'Role',
    });
  });

  it('keeps a valid Eurecia origin and labels', async () => {
    const setting = {
      baseUrl: 'https://tenant.eurecia.com/',
      axis1Label: 'Client',
      axis2Label: 'Service',
      axis3Label: 'Assignment',
    };
    executeTakeFirst.mockResolvedValue({
      key: 'eurecia',
      value: JSON.stringify(setting),
      updatedAt: '2026-07-14T00:00:00.000Z',
    });

    await expect(SettingsRepository.get('eurecia')).resolves.toEqual(setting);
    expect(insertInto).not.toHaveBeenCalled();
  });

  it('writes valid Eurecia settings', async () => {
    insertExecute.mockResolvedValue(undefined);

    await expect(
      SettingsRepository.set('eurecia', {
        baseUrl: 'https://tenant.eurecia.com',
        axis1Label: 'Client',
        axis2Label: 'Service',
        axis3Label: 'Assignment',
      }),
    ).resolves.toBeUndefined();

    expect(insertInto).toHaveBeenCalledWith('settings');
    expect(insertExecute).toHaveBeenCalledOnce();
  });

  it('rejects invalid Eurecia settings without writing', async () => {
    await expect(
      SettingsRepository.set('eurecia', {
        baseUrl: 'http://tenant.eurecia.com',
        axis1Label: 'Client',
        axis2Label: 'Service',
        axis3Label: 'Assignment',
      }),
    ).rejects.toThrow('Invalid value for setting "eurecia"');

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

const LEGACY_FIXTURE = {
  backends: {
    enabledBackends: ['claude-code', 'codex'],
    defaultBackend: 'claude-code',
  },
  backendDefaultModels: {
    models: {
      'claude-code': 'sonnet',
      opencode: 'default',
      codex: 'gpt-5',
      copilot: 'default',
      vibe: 'default',
    },
  },
  thinkingSettings: {
    efforts: {
      'claude-code': { default: 'default', sonnet: 'high' },
      opencode: { default: 'default' },
      codex: { default: 'default', 'gpt-5': 'low' },
      copilot: { default: 'default' },
      vibe: { default: 'default' },
    },
  },
  summaryModels: { models: { 'claude-code': 'haiku' } },
  prReviewAgent: {
    backend: 'claude-code',
    modelPreference: 'opus',
    thinkingEffort: 'high',
  },
  agentMemory: {
    enabled: true,
    extractionIntervalMinutes: 1440,
    extractionBackend: 'opencode',
    extractionModel: 'openai/gpt-5',
    extractionThinkingEffort: 'medium',
  },
  rateLimitSwap: {
    enabled: true,
    chain: [{ backend: 'claude-code', threshold: 0.8 }, { backend: 'codex' }],
  },
  aiSkillSlots: {
    'task-name': {
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      skillName: null,
    },
    'merge-commit-message': {
      backend: 'codex',
      model: 'gpt-5-mini',
      thinkingEffort: 'low',
      skillName: null,
    },
  },
};

const LEGACY_FIXTURE_PRESETS = [
  {
    id: 'legacy-claude-code-sonnet-high',
    name: 'Claude Code sonnet · high',
    backend: 'claude-code',
    model: 'sonnet',
    thinkingEffort: 'high',
  },
  {
    id: 'legacy-claude-code-haiku-default',
    name: 'Claude Code haiku',
    backend: 'claude-code',
    model: 'haiku',
    thinkingEffort: 'default',
  },
  {
    id: 'legacy-claude-code-opus-high',
    name: 'Claude Code opus · high',
    backend: 'claude-code',
    model: 'opus',
    thinkingEffort: 'high',
  },
  {
    id: 'legacy-opencode-openai-gpt-5-medium',
    name: 'OpenCode openai/gpt-5 · medium',
    backend: 'opencode',
    model: 'openai/gpt-5',
    thinkingEffort: 'medium',
  },
  {
    id: 'legacy-codex-gpt-5-mini-low',
    name: 'Codex gpt-5-mini · low',
    backend: 'codex',
    model: 'gpt-5-mini',
    thinkingEffort: 'low',
  },
  {
    id: 'legacy-codex-gpt-5-low',
    name: 'Codex gpt-5 · low',
    backend: 'codex',
    model: 'gpt-5',
    thinkingEffort: 'low',
  },
];

const LEGACY_FIXTURE_QUICK_IDS = LEGACY_FIXTURE_PRESETS.map(
  (preset) => preset.id,
);

describe('migrateLegacyModelSettingsToProfiles', () => {
  it('derives profiles with inline triples, active id and fallback order from the legacy keys', () => {
    const result = migrateLegacyModelSettingsToProfiles(LEGACY_FIXTURE);

    expect(result.profiles).toEqual([
      {
        id: 'legacy-default',
        name: 'Default',
        presets: LEGACY_FIXTURE_PRESETS,
        quickPresetIds: LEGACY_FIXTURE_QUICK_IDS,
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'high',
          },
          summary: {
            backend: 'claude-code',
            model: 'haiku',
            thinkingEffort: 'default',
          },
          'pr-review': {
            backend: 'claude-code',
            model: 'opus',
            thinkingEffort: 'high',
          },
          memory: {
            backend: 'opencode',
            model: 'openai/gpt-5',
            thinkingEffort: 'medium',
          },
          'task-name': {
            backend: 'claude-code',
            model: 'haiku',
            thinkingEffort: 'default',
          },
          // `merge-commit-message` has its own role now, so the legacy slot
          // migrates there rather than into the `ai-generation` catch-all.
          'merge-commit-message': {
            backend: 'codex',
            model: 'gpt-5-mini',
            thinkingEffort: 'low',
          },
        },
      },
      {
        id: 'legacy-backend-codex',
        name: 'Codex',
        presets: LEGACY_FIXTURE_PRESETS,
        quickPresetIds: LEGACY_FIXTURE_QUICK_IDS,
        roles: {
          agent: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'low' },
        },
      },
    ]);

    expect(result.activeModelProfileId).toBe('legacy-default');
    expect(result.modelFallbackOrder).toEqual([
      'legacy-default',
      'legacy-backend-codex',
    ]);
  });

  it('is idempotent when re-run over its own output', () => {
    const first = migrateLegacyModelSettingsToProfiles(LEGACY_FIXTURE);
    const second = migrateLegacyModelSettingsToProfiles({
      ...LEGACY_FIXTURE,
      modelProfiles: first.profiles,
      activeModelProfileId: first.activeModelProfileId,
      modelFallbackOrder: first.modelFallbackOrder,
    });

    expect(second).toEqual(first);
  });

  it('reuses an existing preset with the same triple instead of duplicating it', () => {
    const result = migrateLegacyModelSettingsToProfiles({
      backends: { enabledBackends: ['claude-code'], defaultBackend: 'claude-code' },
      backendDefaultModels: { models: { 'claude-code': 'sonnet' } },
      thinkingSettings: { efforts: { 'claude-code': { sonnet: 'high' } } },
      backendModelPresets: [
        {
          id: 'user-preset',
          name: 'My sonnet',
          backend: 'claude-code',
          model: 'sonnet',
          thinkingEffort: 'high',
        },
      ],
    });

    expect(result.profiles[0].presets).toEqual([
      {
        id: 'user-preset',
        name: 'My sonnet',
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      },
    ]);
    expect(result.profiles[0].quickPresetIds).toEqual(['user-preset']);
    expect(result.profiles[0].roles.agent).toEqual({
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'high',
    });
  });

  it('preserves user-authored profiles (upgraded to inline triples) and an existing active selection', () => {
    const result = migrateLegacyModelSettingsToProfiles({
      ...LEGACY_FIXTURE,
      backendModelPresets: [
        {
          id: 'x',
          name: 'X',
          backend: 'codex',
          model: 'gpt-5',
          thinkingEffort: 'low',
        },
      ],
      modelProfiles: [{ id: 'mine', name: 'Mine', roles: { agent: 'x' } }],
      activeModelProfileId: 'mine',
    });

    expect(result.profiles[0]).toEqual({
      id: 'mine',
      name: 'Mine',
      presets: [
        {
          id: 'x',
          name: 'X',
          backend: 'codex',
          model: 'gpt-5',
          thinkingEffort: 'low',
        },
      ],
      quickPresetIds: ['x'],
      roles: {
        agent: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'low' },
      },
    });
    expect(result.profiles.map((profile) => profile.id)).toEqual([
      'mine',
      'legacy-default',
      'legacy-backend-codex',
    ]);
    expect(result.activeModelProfileId).toBe('mine');
  });

  it('falls back to defaults for empty legacy settings', () => {
    const result = migrateLegacyModelSettingsToProfiles({});

    expect(result.profiles).toEqual([
      {
        id: 'legacy-default',
        name: 'Default',
        presets: [
          {
            id: 'legacy-claude-code-default-default',
            name: 'Claude Code default',
            backend: 'claude-code',
            model: 'default',
            thinkingEffort: 'default',
          },
        ],
        quickPresetIds: ['legacy-claude-code-default-default'],
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'default',
            thinkingEffort: 'default',
          },
        },
      },
    ]);
    expect(result.activeModelProfileId).toBe('legacy-default');
    expect(result.modelFallbackOrder).toEqual([]);
  });

  it('falls back to defaults for corrupt legacy values', () => {
    const corrupt = migrateLegacyModelSettingsToProfiles({
      backends: 'nope',
      backendDefaultModels: 42,
      thinkingSettings: [],
      summaryModels: null,
      prReviewAgent: 'broken',
      agentMemory: 0,
      rateLimitSwap: { enabled: 'yes', chain: 'nope' },
      aiSkillSlots: ['bad'],
    });

    expect(corrupt).toEqual(migrateLegacyModelSettingsToProfiles({}));
  });

  it('creates a fallback profile for a swap entry that matches no profile', () => {
    const result = migrateLegacyModelSettingsToProfiles({
      backends: { enabledBackends: ['claude-code'], defaultBackend: 'claude-code' },
      backendDefaultModels: { models: { 'claude-code': 'sonnet' } },
      rateLimitSwap: {
        enabled: true,
        chain: [{ backend: 'codex', model: 'gpt-5' }],
      },
    });

    expect(result.profiles.map((profile) => profile.id)).toEqual([
      'legacy-default',
      'legacy-fallback-codex-gpt-5-default',
    ]);
    expect(result.modelFallbackOrder).toEqual([
      'legacy-fallback-codex-gpt-5-default',
    ]);
  });

  it('still migrates the pre-chain rateLimitSwap rules/swapTo shape', () => {
    const result = migrateLegacyModelSettingsToProfiles({
      backends: { enabledBackends: ['claude-code'], defaultBackend: 'claude-code' },
      backendDefaultModels: { models: { 'claude-code': 'sonnet' } },
      rateLimitSwap: {
        enabled: true,
        rules: [
          {
            backend: 'claude-code',
            threshold: 0.8,
            swapTo: { backend: 'codex', model: 'gpt-5' },
          },
        ],
      },
    });

    expect(result.modelFallbackOrder).toEqual([
      'legacy-default',
      'legacy-fallback-codex-gpt-5-default',
    ]);
  });

  it('reads the legacy keys straight off raw stored JSON', () => {
    // The keys no longer exist in `AppSettings`; the migration must keep parsing
    // whatever an upgrading user still has on disk.
    const raw: unknown = JSON.parse(JSON.stringify(LEGACY_FIXTURE));
    const result = migrateLegacyModelSettingsToProfiles(
      raw as typeof LEGACY_FIXTURE,
    );

    expect(result.profiles[0].roles).toEqual({
      agent: { backend: 'claude-code', model: 'sonnet', thinkingEffort: 'high' },
      summary: {
        backend: 'claude-code',
        model: 'haiku',
        thinkingEffort: 'default',
      },
      'pr-review': {
        backend: 'claude-code',
        model: 'opus',
        thinkingEffort: 'high',
      },
      memory: {
        backend: 'opencode',
        model: 'openai/gpt-5',
        thinkingEffort: 'medium',
      },
      'task-name': {
        backend: 'claude-code',
        model: 'haiku',
        thinkingEffort: 'default',
      },
      'merge-commit-message': {
        backend: 'codex',
        model: 'gpt-5-mini',
        thinkingEffort: 'low',
      },
    });
  });
});

describe('normalizeModelProfilesSetting', () => {
  it('returns null for a non-array value', () => {
    expect(normalizeModelProfilesSetting({ profiles: [] })).toBeNull();
  });

  it('returns null when the stored profiles need no change', () => {
    expect(
      normalizeModelProfilesSetting([
        {
          id: 'a',
          name: 'A',
          presets: [
            {
              id: 'p1',
              name: 'P1',
              backend: 'codex',
              model: 'gpt-5',
              thinkingEffort: 'low',
            },
          ],
          quickPresetIds: ['p1'],
          roles: {
            agent: {
              backend: 'claude-code',
              model: 'sonnet',
              thinkingEffort: 'high',
            },
            summary: 'inherit',
          },
        },
      ]),
    ).toBeNull();
  });

  it('drops invalid entries, invalid bindings and duplicate ids', () => {
    expect(
      normalizeModelProfilesSetting([
        'nope',
        { id: '', name: 'Empty', roles: {} },
        {
          id: 'a',
          name: 'A',
          presets: ['nope', { id: 'p1', name: 'P1', backend: 'nope' }],
          quickPresetIds: ['p1'],
          roles: { agent: 'off', summary: 42, 'not-a-role': 'p1' },
        },
        { id: 'a', name: 'Duplicate', roles: {} },
        { id: 'b', name: 42, roles: null },
      ]),
    ).toEqual([
      {
        id: 'a',
        name: 'A',
        presets: [],
        quickPresetIds: [],
        roles: { agent: 'inherit', 'not-a-role': 'p1' },
      },
    ]);
  });

  it('preserves a legacy preset-id binding so the revision 1 migration can still resolve it', () => {
    expect(
      normalizeModelProfilesSetting([
        { id: 'a', name: 'A', roles: { agent: 'preset-1' } },
      ]),
    ).toEqual([
      {
        id: 'a',
        name: 'A',
        presets: [],
        quickPresetIds: [],
        roles: { agent: 'preset-1' },
      },
    ]);
  });

  it('keeps a preset-reference binding intact', () => {
    expect(
      normalizeModelProfilesSetting([
        {
          id: 'a',
          name: 'A',
          presets: [],
          quickPresetIds: [],
          roles: { summary: { presetId: 'fast' }, agent: 'inherit' },
        },
      ]),
    ).toBeNull();
  });

  it('keeps an image-model binding intact', () => {
    expect(
      normalizeModelProfilesSetting([
        {
          id: 'a',
          name: 'A',
          presets: [],
          quickPresetIds: [],
          roles: { 'project-logo': { imageModel: 'gpt-image-1' } },
        },
      ]),
    ).toBeNull();
  });

  it('normalizes a stored modelProfiles value through the repository', async () => {
    executeTakeFirst.mockResolvedValue({
      key: 'modelProfiles',
      value: JSON.stringify([
        { id: 'a', name: 'A', roles: { agent: 'off', summary: 'p1' } },
      ]),
      updatedAt: '2026-09-19T00:00:00.000Z',
    });
    insertExecute.mockResolvedValue(undefined);

    await expect(SettingsRepository.get('modelProfiles')).resolves.toEqual([
      {
        id: 'a',
        name: 'A',
        presets: [],
        quickPresetIds: [],
        roles: { agent: 'inherit', summary: 'p1' },
      },
    ]);
    expect(insertInto).toHaveBeenCalledWith('settings');
  });
});

describe('migrateProfilePresetIdBindings', () => {
  const GLOBAL_PRESETS = [
    {
      id: 'p-sonnet',
      name: 'Sonnet',
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'high',
    },
    {
      id: 'p-haiku',
      name: 'Haiku',
      backend: 'claude-code',
      model: 'haiku',
      thinkingEffort: 'default',
      showInQuickSwitcher: false,
    },
    {
      id: 'p-gpt5',
      name: 'GPT-5',
      backend: 'codex',
      model: 'gpt-5',
      thinkingEffort: 'low',
    },
  ];

  it('inlines each preset-id binding as that preset triple', () => {
    const migrated = migrateProfilePresetIdBindings({
      profiles: [
        {
          id: 'default',
          name: 'Default',
          roles: {
            agent: 'p-sonnet',
            summary: 'p-haiku',
            'pr-review': 'inherit',
            memory: 'off',
          },
        },
      ],
      presets: GLOBAL_PRESETS,
    });

    expect(migrated?.[0].roles).toEqual({
      agent: { backend: 'claude-code', model: 'sonnet', thinkingEffort: 'high' },
      summary: {
        backend: 'claude-code',
        model: 'haiku',
        thinkingEffort: 'default',
      },
      'pr-review': 'inherit',
      memory: 'off',
    });
  });

  it('drops a binding whose preset no longer exists', () => {
    const migrated = migrateProfilePresetIdBindings({
      profiles: [
        {
          id: 'default',
          name: 'Default',
          roles: { agent: 'p-sonnet', summary: 'p-deleted' },
        },
      ],
      presets: GLOBAL_PRESETS,
    });

    expect(migrated?.[0].roles).toEqual({
      agent: { backend: 'claude-code', model: 'sonnet', thinkingEffort: 'high' },
    });
  });

  it('copies the global presets into every profile and seeds the quick list', () => {
    const migrated = migrateProfilePresetIdBindings({
      profiles: [
        { id: 'a', name: 'A', roles: { agent: 'p-sonnet' } },
        { id: 'b', name: 'B', roles: { agent: 'p-gpt5' } },
      ],
      presets: GLOBAL_PRESETS,
    });

    for (const profile of migrated ?? []) {
      expect(profile.presets).toEqual([
        {
          id: 'p-sonnet',
          name: 'Sonnet',
          backend: 'claude-code',
          model: 'sonnet',
          thinkingEffort: 'high',
        },
        {
          id: 'p-haiku',
          name: 'Haiku',
          backend: 'claude-code',
          model: 'haiku',
          thinkingEffort: 'default',
        },
        {
          id: 'p-gpt5',
          name: 'GPT-5',
          backend: 'codex',
          model: 'gpt-5',
          thinkingEffort: 'low',
        },
      ]);
      // `p-haiku` had `showInQuickSwitcher: false`.
      expect(profile.quickPresetIds).toEqual(['p-sonnet', 'p-gpt5']);
    }
  });

  it('rewrites the forbidden agent: off binding to inherit', () => {
    const migrated = migrateProfilePresetIdBindings({
      profiles: [{ id: 'a', name: 'A', roles: { agent: 'off' } }],
      presets: GLOBAL_PRESETS,
    });

    expect(migrated?.[0].roles).toEqual({ agent: 'inherit' });
  });

  it('is idempotent: a profile already in revision 1 is untouched', () => {
    const once = migrateProfilePresetIdBindings({
      profiles: [
        { id: 'a', name: 'A', roles: { agent: 'p-sonnet', summary: 'off' } },
      ],
      presets: GLOBAL_PRESETS,
    });

    expect(once).not.toBeNull();
    expect(
      migrateProfilePresetIdBindings({
        profiles: once,
        presets: GLOBAL_PRESETS,
      }),
    ).toBeNull();
  });

  it('returns null for a non-array value', () => {
    expect(
      migrateProfilePresetIdBindings({ profiles: null, presets: [] }),
    ).toBeNull();
  });
});
