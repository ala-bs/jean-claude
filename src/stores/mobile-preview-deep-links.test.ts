import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe('mobile preview deep-link store', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorage());
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps project history bounded and promotes reopened links', async () => {
    const { useMobilePreviewDeepLinksStore } = await import(
      './mobile-preview-deep-links'
    );
    const store = useMobilePreviewDeepLinksStore.getState();

    for (let index = 0; index < 21; index += 1) {
      store.recordOpened('project-1', `app://${index}`);
    }
    store.recordOpened('project-1', 'app://0');

    const links = useMobilePreviewDeepLinksStore.getState().linksByProject[
      'project-1'
    ];
    expect(links).toHaveLength(20);
    expect(links[0]).toEqual({ url: 'app://0', pinned: false });
    expect(links.some((link) => link.url === 'app://1')).toBe(false);
  });

  it('keeps pinned links outside history limit', async () => {
    const { useMobilePreviewDeepLinksStore } = await import(
      './mobile-preview-deep-links'
    );
    const store = useMobilePreviewDeepLinksStore.getState();

    store.recordOpened('project-1', 'app://pinned');
    store.togglePinned('project-1', 'app://pinned');
    for (let index = 0; index < 20; index += 1) {
      store.recordOpened('project-1', `app://${index}`);
    }

    const links = useMobilePreviewDeepLinksStore.getState().linksByProject[
      'project-1'
    ];
    expect(links[0]).toEqual({ url: 'app://pinned', pinned: true });
    expect(links).toHaveLength(21);
  });
});
