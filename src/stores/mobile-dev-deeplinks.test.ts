import { beforeEach, describe, expect, it } from 'vitest';

import {
  MOBILE_DEV_DEEPLINK_HISTORY_LIMIT,
  normalizeUrls,
  useMobileDevDeeplinksStore,
} from './mobile-dev-deeplinks';

describe('useMobileDevDeeplinksStore', () => {
  beforeEach(() => {
    useMobileDevDeeplinksStore.setState({ recentUrls: [] });
  });

  it('records the most recent deeplink first and trims whitespace', () => {
    const { recordOpened } = useMobileDevDeeplinksStore.getState();
    recordOpened('myapp://a');
    recordOpened('  myapp://b  ');

    expect(useMobileDevDeeplinksStore.getState().recentUrls).toEqual([
      'myapp://b',
      'myapp://a',
    ]);
  });

  it('dedupes by moving an existing url back to the top', () => {
    const { recordOpened } = useMobileDevDeeplinksStore.getState();
    recordOpened('myapp://a');
    recordOpened('myapp://b');
    recordOpened('myapp://a');

    expect(useMobileDevDeeplinksStore.getState().recentUrls).toEqual([
      'myapp://a',
      'myapp://b',
    ]);
  });

  it('ignores empty urls', () => {
    useMobileDevDeeplinksStore.getState().recordOpened('   ');
    expect(useMobileDevDeeplinksStore.getState().recentUrls).toEqual([]);
  });

  it('caps the history', () => {
    const { recordOpened } = useMobileDevDeeplinksStore.getState();
    for (let i = 0; i < MOBILE_DEV_DEEPLINK_HISTORY_LIMIT + 5; i += 1) {
      recordOpened(`myapp://${i}`);
    }

    const { recentUrls } = useMobileDevDeeplinksStore.getState();
    expect(recentUrls).toHaveLength(MOBILE_DEV_DEEPLINK_HISTORY_LIMIT);
    expect(recentUrls[0]).toBe(
      `myapp://${MOBILE_DEV_DEEPLINK_HISTORY_LIMIT + 4}`,
    );
  });

  // `normalizeUrls` backs the persist `merge` option: the only sanitizer
  // between untrusted localStorage and the rendered history list.
  describe('normalizeUrls (rehydration)', () => {
    it('falls back to an empty list for corrupt payloads', () => {
      expect(normalizeUrls(null)).toEqual([]);
      expect(normalizeUrls('nope')).toEqual([]);
      expect(normalizeUrls(undefined)).toEqual([]);
      expect(normalizeUrls({})).toEqual([]);
    });

    it('drops non-string and blank entries', () => {
      expect(
        normalizeUrls(['myapp://a', 42, null, '  ', 'myapp://b']),
      ).toEqual(['myapp://a', 'myapp://b']);
    });

    it('dedupes and caps already-persisted entries', () => {
      const urls = normalizeUrls([
        'myapp://a',
        'myapp://a',
        ...Array.from({ length: 40 }, (_, i) => `myapp://${i}`),
      ]);
      expect(urls).toHaveLength(MOBILE_DEV_DEEPLINK_HISTORY_LIMIT);
      expect(new Set(urls).size).toBe(urls.length);
      expect(urls[0]).toBe('myapp://a');
    });
  });

  it('removes a single entry', () => {
    const { recordOpened, remove } = useMobileDevDeeplinksStore.getState();
    recordOpened('myapp://a');
    recordOpened('myapp://b');
    remove('myapp://a');

    expect(useMobileDevDeeplinksStore.getState().recentUrls).toEqual([
      'myapp://b',
    ]);
  });
});
