import { describe, expect, it, vi } from 'vitest';

import { setAppSetting } from './set-app-setting';

const EURECIA_SETTING = {
  baseUrl: 'https://tenant.example',
  axis1Label: 'Project',
  axis2Label: 'Activity',
  axis3Label: 'Role',
};

describe('setAppSetting', () => {
  it('invalidates Eurecia only after persistence succeeds', async () => {
    let finishPersist!: () => void;
    const persist = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPersist = resolve;
        }),
    );
    const invalidateEureciaSession = vi.fn();
    const setting = setAppSetting({
      key: 'eurecia',
      value: EURECIA_SETTING,
      persist,
      invalidateEureciaSession,
    });

    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(invalidateEureciaSession).not.toHaveBeenCalled();

    finishPersist();
    await setting;

    expect(invalidateEureciaSession).toHaveBeenCalledOnce();
  });

  it('does not invalidate Eurecia when persistence fails', async () => {
    const invalidateEureciaSession = vi.fn();

    await expect(
      setAppSetting({
        key: 'eurecia',
        value: EURECIA_SETTING,
        persist: vi.fn(async () => {
          throw new Error('write failed');
        }),
        invalidateEureciaSession,
      }),
    ).rejects.toThrow('write failed');

    expect(invalidateEureciaSession).not.toHaveBeenCalled();
  });

  it('does not invalidate Eurecia for another setting', async () => {
    const invalidateEureciaSession = vi.fn();

    await setAppSetting({
      key: 'workActivity',
      value: { enabled: true },
      persist: vi.fn(async () => {}),
      invalidateEureciaSession,
    });

    expect(invalidateEureciaSession).not.toHaveBeenCalled();
  });
});
