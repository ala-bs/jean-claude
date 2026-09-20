import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '@shared/types';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
}));

vi.mock('better-sqlite3', () => ({
  default: class FakeDatabase {
    pragma() {}
    close() {}
  },
}));

vi.mock('../lib/debug', () => ({
  dbg: { main: vi.fn(), dbMigration: vi.fn() },
}));

process.env.JEAN_CLAUDE_DB_PATH = ':memory:';

import {
  migrateLegacyModelSettings,
  migrateModelProfilesToRevision1,
  type ModelSettingsMigrationStore,
} from './index';

const LEGACY_SETTINGS: Record<string, unknown> = {
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
      codex: { default: 'default', 'gpt-5': 'low' },
    },
  },
};

function createStore(initial: Record<string, unknown>) {
  const values = { ...initial };
  const written: Record<string, unknown> = {};

  const store: ModelSettingsMigrationStore = {
    readRaw: vi.fn(async (key: string) => values[key]),
    write: vi.fn(async (key: keyof AppSettings, value: unknown) => {
      values[key] = value;
      written[key] = value;
    }),
  };

  return { store, values, written };
}

describe('migrateLegacyModelSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates profiles from legacy settings on first startup', async () => {
    const { store, written } = createStore(LEGACY_SETTINGS);

    await expect(migrateLegacyModelSettings(store)).resolves.toBe(true);

    expect(Object.keys(written).sort()).toEqual([
      'activeModelProfileId',
      'modelFallbackOrder',
      'modelProfiles',
    ]);
    const expectedPresets = [
      {
        id: 'legacy-claude-code-sonnet-high',
        name: 'Claude Code sonnet · high',
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      },
      {
        id: 'legacy-codex-gpt-5-low',
        name: 'Codex gpt-5 · low',
        backend: 'codex',
        model: 'gpt-5',
        thinkingEffort: 'low',
      },
    ];
    expect(written.modelProfiles).toEqual([
      {
        id: 'legacy-default',
        name: 'Default',
        presets: expectedPresets,
        quickPresetIds: expectedPresets.map((preset) => preset.id),
        roles: {
          agent: {
            backend: 'claude-code',
            model: 'sonnet',
            thinkingEffort: 'high',
          },
        },
      },
      {
        id: 'legacy-backend-codex',
        name: 'Codex',
        presets: expectedPresets,
        quickPresetIds: expectedPresets.map((preset) => preset.id),
        roles: {
          agent: { backend: 'codex', model: 'gpt-5', thinkingEffort: 'low' },
        },
      },
    ]);
    expect(written.backendModelPresets).toBeUndefined();
    expect(written.activeModelProfileId).toBe('legacy-default');
    expect(written.modelFallbackOrder).toEqual([]);
  });

  it('leaves everything unchanged on a second startup', async () => {
    const { store, values } = createStore(LEGACY_SETTINGS);
    await migrateLegacyModelSettings(store);
    const snapshot = JSON.parse(JSON.stringify(values));

    const second = createStore(values);
    await expect(migrateLegacyModelSettings(second.store)).resolves.toBe(false);

    expect(second.written).toEqual({});
    expect(second.values).toEqual(snapshot);
  });

  it('never overwrites profiles the user has edited', async () => {
    const userProfiles = [{ id: 'mine', name: 'Mine', roles: { agent: 'x' } }];
    const { store, written, values } = createStore({
      ...LEGACY_SETTINGS,
      modelProfiles: userProfiles,
      activeModelProfileId: 'mine',
    });

    await expect(migrateLegacyModelSettings(store)).resolves.toBe(false);

    expect(written).toEqual({});
    expect(values.modelProfiles).toEqual(userProfiles);
    expect(values.activeModelProfileId).toBe('mine');
  });

  it('is a no-op when no legacy setting was ever written', async () => {
    const { store, written } = createStore({});

    await expect(migrateLegacyModelSettings(store)).resolves.toBe(false);

    expect(written).toEqual({});
    expect(store.write).not.toHaveBeenCalled();
  });

  it('migrates when an empty modelProfiles array is already stored', async () => {
    const { store, written } = createStore({
      ...LEGACY_SETTINGS,
      modelProfiles: [],
    });

    await expect(migrateLegacyModelSettings(store)).resolves.toBe(true);
    expect(written.modelProfiles).toHaveLength(2);
  });

  it('reuses an existing preset with the same triple', async () => {
    const { store, written } = createStore({
      ...LEGACY_SETTINGS,
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

    await expect(migrateLegacyModelSettings(store)).resolves.toBe(true);
    const profiles = written.modelProfiles as {
      presets: { id: string }[];
      roles: { agent: unknown };
    }[];
    expect(profiles[0].presets).toEqual([
      {
        id: 'user-preset',
        name: 'My sonnet',
        backend: 'claude-code',
        model: 'sonnet',
        thinkingEffort: 'high',
      },
      {
        id: 'legacy-codex-gpt-5-low',
        name: 'Codex gpt-5 · low',
        backend: 'codex',
        model: 'gpt-5',
        thinkingEffort: 'low',
      },
    ]);
    expect(profiles[0].roles.agent).toEqual({
      backend: 'claude-code',
      model: 'sonnet',
      thinkingEffort: 'high',
    });
  });

  it('produces a usable revision 1 profile that the revision 1 migration leaves alone', async () => {
    const { store, values } = createStore(LEGACY_SETTINGS);
    await expect(migrateLegacyModelSettings(store)).resolves.toBe(true);

    // Pre-profiles upgrade path feeds straight into the revision 1 migration.
    await expect(migrateModelProfilesToRevision1(store)).resolves.toBe(false);

    const profiles = values.modelProfiles as {
      roles: { agent: { backend: string } };
    }[];
    expect(profiles[0].roles.agent.backend).toBe('claude-code');
  });
});

describe('migrateModelProfilesToRevision1', () => {
  const REVISION_0 = {
    backendModelPresets: [
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
    ],
    modelProfiles: [
      {
        id: 'default',
        name: 'Default',
        roles: { agent: 'p-sonnet', summary: 'p-haiku', memory: 'p-gone' },
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inlines preset ids as triples, moves presets in and seeds the quick list', async () => {
    const { store, written } = createStore(REVISION_0);

    await expect(migrateModelProfilesToRevision1(store)).resolves.toBe(true);

    expect(written.modelProfiles).toEqual([
      {
        id: 'default',
        name: 'Default',
        presets: [
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
        ],
        quickPresetIds: ['p-sonnet'],
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
          // `p-gone` referenced a deleted preset and is dropped.
        },
      },
    ]);
    expect(written.backendModelPresets).toBeUndefined();
  });

  it('is a no-op on a second startup', async () => {
    const { store, values } = createStore(REVISION_0);
    await migrateModelProfilesToRevision1(store);
    const snapshot = JSON.parse(JSON.stringify(values));

    const second = createStore(values);
    await expect(migrateModelProfilesToRevision1(second.store)).resolves.toBe(
      false,
    );
    expect(second.written).toEqual({});
    expect(second.values).toEqual(snapshot);
  });

  it('is a no-op when no profile is stored', async () => {
    const { store } = createStore({});

    await expect(migrateModelProfilesToRevision1(store)).resolves.toBe(false);
    expect(store.write).not.toHaveBeenCalled();
  });
});
