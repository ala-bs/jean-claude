// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';

import {
  useMobilePreviewDeviceSelection,
  useNavigationStore,
} from './navigation';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('mobile preview device selection migration', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    useNavigationStore.setState({
      mobilePreviewSelectedDeviceByKey: {},
      mobilePreviewVisibleDeviceIdsByPlatform: { android: null, ios: null },
    });
  });

  it('falls back to legacy values and lazily copies both preference groups', async () => {
    const legacyKey = 'project-1:apps/mobile';
    const taskKey = 'task-1:apps/mobile';
    const selectedDevice = { platform: 'ios' as const, deviceId: 'ios-1' };
    const visibleDeviceIdsByPlatform = {
      android: ['android-1'],
      ios: ['ios-1'],
    };
    useNavigationStore.setState({
      mobilePreviewSelectedDeviceByKey: {
        [legacyKey]: selectedDevice,
      },
      mobilePreviewVisibleDeviceIdsByPlatform: visibleDeviceIdsByPlatform,
    });
    let observed:
      | ReturnType<typeof useMobilePreviewDeviceSelection>
      | undefined;
    function Harness() {
      observed = useMobilePreviewDeviceSelection({
        key: taskKey,
        legacyKey,
      });
      return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(Harness)));

    expect(observed?.selectedDevice).toEqual(selectedDevice);
    expect(observed?.visibleDeviceIdsByPlatform).toEqual(
      visibleDeviceIdsByPlatform,
    );
    const state = useNavigationStore.getState();
    expect(state.mobilePreviewSelectedDeviceByKey[taskKey]).toEqual(
      selectedDevice,
    );
    expect(state.mobilePreviewSelectedDeviceByKey[legacyKey]).toEqual(
      selectedDevice,
    );
    expect(state.mobilePreviewVisibleDeviceIdsByPlatform).toEqual(
      visibleDeviceIdsByPlatform,
    );

    await act(async () => root.unmount());
  });
});
