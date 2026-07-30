import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const MOBILE_PREVIEW_DEEP_LINK_HISTORY_LIMIT = 20;

export type MobilePreviewDeepLink = {
  url: string;
  pinned: boolean;
};

type MobilePreviewDeepLinkState = {
  linksByProject: Record<string, MobilePreviewDeepLink[]>;
  recordOpened: (projectId: string, url: string) => void;
  togglePinned: (projectId: string, url: string) => void;
  remove: (projectId: string, url: string) => void;
};

function normalizeLinks(value: unknown): Record<string, MobilePreviewDeepLink[]> {
  if (!value || typeof value !== 'object') return {};

  const result: Record<string, MobilePreviewDeepLink[]> = {};
  for (const [projectId, links] of Object.entries(value)) {
    if (!Array.isArray(links)) continue;
    const validLinks = links.filter(
      (link): link is MobilePreviewDeepLink =>
        !!link &&
        typeof link === 'object' &&
        typeof link.url === 'string' &&
        link.url.trim().length > 0 &&
        typeof link.pinned === 'boolean',
    );
    const pinned = validLinks.filter((link) => link.pinned);
    const history = validLinks.filter((link) => !link.pinned).slice(0, MOBILE_PREVIEW_DEEP_LINK_HISTORY_LIMIT);
    result[projectId] = [...pinned, ...history];
  }
  return result;
}

function orderLinks(links: MobilePreviewDeepLink[]) {
  const pinned = links.filter((link) => link.pinned);
  const history = links
    .filter((link) => !link.pinned)
    .slice(0, MOBILE_PREVIEW_DEEP_LINK_HISTORY_LIMIT);
  return [...pinned, ...history];
}

export const useMobilePreviewDeepLinksStore = create<MobilePreviewDeepLinkState>()(
  persist(
    (set) => ({
      linksByProject: {},
      recordOpened: (projectId, rawUrl) => {
        const url = rawUrl.trim();
        if (!url) return;
        set((state) => {
          const links = state.linksByProject[projectId] ?? [];
          const existing = links.find((link) => link.url === url);
          const next = [
            { url, pinned: existing?.pinned ?? false },
            ...links.filter((link) => link.url !== url),
          ];
          return {
            linksByProject: {
              ...state.linksByProject,
              [projectId]: orderLinks(next),
            },
          };
        });
      },
      togglePinned: (projectId, url) =>
        set((state) => {
          const links = state.linksByProject[projectId] ?? [];
          const next = links.map((link) =>
            link.url === url ? { ...link, pinned: !link.pinned } : link,
          );
          return {
            linksByProject: {
              ...state.linksByProject,
              [projectId]: orderLinks(next),
            },
          };
        }),
      remove: (projectId, url) =>
        set((state) => ({
          linksByProject: {
            ...state.linksByProject,
            [projectId]: (state.linksByProject[projectId] ?? []).filter(
              (link) => link.url !== url,
            ),
          },
        })),
    }),
    {
      name: 'mobile-preview-deep-links',
      version: 1,
      partialize: (state) => ({ linksByProject: state.linksByProject }),
      merge: (persisted, current) => ({
        ...current,
        linksByProject: normalizeLinks(
          persisted && typeof persisted === 'object'
            ? (persisted as { linksByProject?: unknown }).linksByProject
            : null,
        ),
      }),
    },
  ),
);
