import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Global (not per-device, not per-project) history of deeplinks opened from the
 * mobile dev pane. Deeplinks are typically app-scheme URLs that a developer
 * reuses across devices and tasks, so scoping them narrower than "global" would
 * just hide the entry the user wants.
 */
export const MOBILE_DEV_DEEPLINK_HISTORY_LIMIT = 15;

type MobileDevDeeplinkState = {
  recentUrls: string[];
  recordOpened: (url: string) => void;
  remove: (url: string) => void;
  clear: () => void;
};

/**
 * Sanitizes a persisted payload. Exported for tests: this is the only guard
 * between untrusted localStorage and the rendered history list.
 */
export function normalizeUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const url = entry.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
    if (result.length >= MOBILE_DEV_DEEPLINK_HISTORY_LIMIT) break;
  }
  return result;
}

export const useMobileDevDeeplinksStore = create<MobileDevDeeplinkState>()(
  persist(
    (set) => ({
      recentUrls: [],
      recordOpened: (rawUrl) => {
        const url = rawUrl.trim();
        if (!url) return;
        set((state) => ({
          recentUrls: [
            url,
            ...state.recentUrls.filter((entry) => entry !== url),
          ].slice(0, MOBILE_DEV_DEEPLINK_HISTORY_LIMIT),
        }));
      },
      remove: (url) =>
        set((state) => ({
          recentUrls: state.recentUrls.filter((entry) => entry !== url),
        })),
      clear: () => set({ recentUrls: [] }),
    }),
    {
      name: 'mobile-dev-deeplinks',
      version: 1,
      partialize: (state) => ({ recentUrls: state.recentUrls }),
      merge: (persisted, current) => ({
        ...current,
        recentUrls: normalizeUrls(
          persisted && typeof persisted === 'object'
            ? (persisted as { recentUrls?: unknown }).recentUrls
            : null,
        ),
      }),
    },
  ),
);
