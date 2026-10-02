// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MobilePlatform } from '@shared/mobile-simulator-types';
import { api } from '@/lib/api';
import { RootOverlay } from '@/common/context/overlay';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';

import { BuildStore } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function renderBuildStore(refreshToken = 0) {
  await act(async () => {
    root.render(
      <RootOverlay>
        <RootKeyboardBindings>
          <BuildStore
            projectPath="/repo"
            platform={'ios' as MobilePlatform}
            device={null}
            refreshToken={refreshToken}
          />
        </RootKeyboardBindings>
      </RootOverlay>,
    );
  });
}

describe('BuildStore', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(api.mobileBuildStore, 'list').mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('refreshes the list when a new build is stored', async () => {
    await renderBuildStore();
    const list = vi.mocked(api.mobileBuildStore.list);
    expect(list).toHaveBeenCalledTimes(1);

    await renderBuildStore(1);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({
      platform: 'ios',
      projectPath: '/repo',
    });
  });

});
