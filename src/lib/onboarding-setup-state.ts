import type { BackendsSetting } from '@shared/types';

/**
 * Decides whether the onboarding setup flow is required.
 *
 * `undefined` query data means "unknown yet" (loading or paused fetch) and must
 * never be read as "nothing configured" — that would bounce existing users into
 * onboarding on every launch. A hard query failure also stays out of onboarding
 * instead of blocking the app behind the setup gate forever — a genuine first run
 * whose queries fail then misses the wizard, which is preferable to trapping an
 * existing user in a blank shell.
 */
export function resolveSetupState({
  projects,
  backendsSetting,
  setupBackendSelected,
  queriesFailed,
}: {
  projects: unknown[] | undefined;
  backendsSetting: BackendsSetting | undefined;
  setupBackendSelected: boolean;
  queriesFailed: boolean;
}): { isUnknown: boolean; setupRequired: boolean } {
  if (queriesFailed) return { isUnknown: false, setupRequired: false };

  if (projects === undefined || backendsSetting === undefined) {
    return { isUnknown: true, setupRequired: false };
  }

  const backendReady =
    setupBackendSelected || backendsSetting.enabledBackends.length > 0;

  return {
    isUnknown: false,
    setupRequired: projects.length === 0 || !backendReady,
  };
}
