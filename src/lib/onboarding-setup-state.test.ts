import { describe, expect, it } from 'vitest';

import { buildInitialModelProfileSetup } from '@/routes/onboarding/setup';
import { resolveSetupState } from './onboarding-setup-state';

const configuredBackends = {
  enabledBackends: ['claude-code' as const],
  defaultBackend: 'claude-code' as const,
};
const emptyBackends = { enabledBackends: [], defaultBackend: null };

describe('resolveSetupState', () => {
  it('stays unknown while backends settings are still loading', () => {
    expect(
      resolveSetupState({
        projects: [{}],
        backendsSetting: undefined,
        setupBackendSelected: false,
        queriesFailed: false,
      }),
    ).toEqual({ isUnknown: true, setupRequired: false });
  });

  it('stays unknown while projects are still loading', () => {
    expect(
      resolveSetupState({
        projects: undefined,
        backendsSetting: configuredBackends,
        setupBackendSelected: false,
        queriesFailed: false,
      }),
    ).toEqual({ isUnknown: true, setupRequired: false });
  });

  it('does not require setup for a configured user', () => {
    expect(
      resolveSetupState({
        projects: [{}],
        backendsSetting: configuredBackends,
        setupBackendSelected: false,
        queriesFailed: false,
      }),
    ).toEqual({ isUnknown: false, setupRequired: false });
  });

  it('requires setup on a fresh install', () => {
    expect(
      resolveSetupState({
        projects: [],
        backendsSetting: emptyBackends,
        setupBackendSelected: false,
        queriesFailed: false,
      }),
    ).toEqual({ isUnknown: false, setupRequired: true });
  });

  it('requires setup when projects exist but no backend is enabled', () => {
    expect(
      resolveSetupState({
        projects: [{}],
        backendsSetting: emptyBackends,
        setupBackendSelected: false,
        queriesFailed: false,
      }),
    ).toEqual({ isUnknown: false, setupRequired: true });
  });

  it('honours a backend picked during the wizard before settings persist', () => {
    expect(
      resolveSetupState({
        projects: [{}],
        backendsSetting: emptyBackends,
        setupBackendSelected: true,
        queriesFailed: false,
      }),
    ).toEqual({ isUnknown: false, setupRequired: false });
  });

  it('ignores the removed defaultBackend field entirely', () => {
    expect(
      resolveSetupState({
        projects: [{}],
        backendsSetting: { enabledBackends: ['codex'] },
        setupBackendSelected: false,
        queriesFailed: false,
      }),
    ).toEqual({ isUnknown: false, setupRequired: false });
  });

  it('never blocks or redirects when a query fails', () => {
    expect(
      resolveSetupState({
        projects: undefined,
        backendsSetting: undefined,
        setupBackendSelected: false,
        queriesFailed: true,
      }),
    ).toEqual({ isUnknown: false, setupRequired: false });
  });
});

describe('buildInitialModelProfileSetup', () => {
  let counter = 0;
  const createId = () => `id-${++counter}`;

  const run = (params: Parameters<typeof buildInitialModelProfileSetup>[0]) =>
    buildInitialModelProfileSetup({ createId, ...params });

  const CLAUDE_DEFAULT = {
    backend: 'claude-code',
    model: 'default',
    thinkingEffort: 'default',
  } as const;

  it('does nothing while no backend is enabled yet', () => {
    expect(
      run({ enabledBackends: [], profiles: [], activeProfileId: null }),
    ).toBeNull();
  });

  // Revision 1: the profile owns its presets and the `agent` role holds an
  // inline triple, so a fresh install must come out self-contained.
  it('creates an active profile holding an inline agent triple', () => {
    counter = 0;
    const result = run({
      enabledBackends: ['claude-code'],
      profiles: [],
      activeProfileId: null,
    });

    expect(result).not.toBeNull();
    expect(result!.profiles).toEqual([
      {
        id: 'id-2',
        name: 'Default',
        presets: [{ id: 'id-1', name: 'Claude Code', ...CLAUDE_DEFAULT }],
        quickPresetIds: ['id-1'],
        roles: { agent: { ...CLAUDE_DEFAULT } },
      },
    ]);
    expect(result!.activeProfileId).toBe('id-2');
  });

  it('uses the first enabled backend for the agent triple', () => {
    counter = 0;
    const result = run({
      enabledBackends: ['codex', 'claude-code'],
      profiles: [],
      activeProfileId: null,
    });

    expect(result!.profiles[0].roles.agent).toMatchObject({
      backend: 'codex',
    });
  });

  it('reuses a matching preset on the profile instead of duplicating it', () => {
    counter = 0;
    const existing = {
      id: 'preset-existing',
      name: 'Mine',
      ...CLAUDE_DEFAULT,
    };
    const result = run({
      enabledBackends: ['claude-code'],
      profiles: [
        {
          id: 'p1',
          name: 'Mine',
          presets: [existing],
          quickPresetIds: ['preset-existing'],
          roles: {},
        },
      ],
      activeProfileId: null,
    });

    expect(result!.profiles[0].presets).toEqual([existing]);
    expect(result!.profiles[0].roles.agent).toEqual({ ...CLAUDE_DEFAULT });
  });

  it('binds and activates an existing unbound profile rather than adding one', () => {
    counter = 0;
    const result = run({
      enabledBackends: ['claude-code'],
      profiles: [
        { id: 'p1', name: 'Mine', presets: [], quickPresetIds: [], roles: {} },
      ],
      activeProfileId: null,
    });

    expect(result!.profiles).toHaveLength(1);
    expect(result!.profiles[0].roles.agent).toEqual({ ...CLAUDE_DEFAULT });
    expect(result!.activeProfileId).toBe('p1');
  });

  // A role may bind to one of the profile's presets by reference. Checking
  // only for an inline triple would read that as "unconfigured" and overwrite
  // the user's agent binding on next launch.
  it('leaves a profile whose agent follows a preset untouched', () => {
    expect(
      run({
        enabledBackends: ['claude-code'],
        profiles: [
          {
            id: 'p1',
            name: 'Mine',
            presets: [
              { id: 'preset-1', name: 'Sonnet', ...CLAUDE_DEFAULT },
            ],
            quickPresetIds: ['preset-1'],
            roles: { agent: { presetId: 'preset-1' } },
          },
        ],
        activeProfileId: 'p1',
      }),
    ).toBeNull();
  });

  it('leaves an already usable active profile untouched', () => {
    expect(
      run({
        enabledBackends: ['claude-code'],
        profiles: [
          {
            id: 'p1',
            name: 'Mine',
            presets: [],
            quickPresetIds: [],
            roles: {
              agent: {
                backend: 'claude-code',
                model: 'sonnet',
                thinkingEffort: 'default',
              },
            },
          },
        ],
        activeProfileId: 'p1',
      }),
    ).toBeNull();
  });

  // A stale preset-id string is not a triple, so it must be repaired rather
  // than left as an unusable binding.
  it('repairs an active profile whose binding is a stale preset id', () => {
    counter = 0;
    const result = run({
      enabledBackends: ['claude-code'],
      profiles: [
        {
          id: 'p1',
          name: 'Mine',
          presets: [],
          quickPresetIds: [],
          roles: { agent: 'deleted' as never },
        },
      ],
      activeProfileId: 'p1',
    });

    expect(result!.profiles[0].roles.agent).toEqual({ ...CLAUDE_DEFAULT });
    expect(result!.activeProfileId).toBe('p1');
  });
});
