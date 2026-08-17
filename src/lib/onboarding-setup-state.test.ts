import { describe, expect, it } from 'vitest';

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
