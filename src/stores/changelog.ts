import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ChangelogState {
  /** Hash of changelog content last seen by user */
  lastSeenHash: string | null;

  /** Whether the changelog modal is currently open */
  isOpen: boolean;

  /** Mark current changelog as seen */
  markSeen: (hash: string) => void;

  /** Open the changelog modal */
  open: () => void;

  /** Close the changelog modal */
  close: () => void;
}

export const useChangelogStore = create<ChangelogState>()(
  persist(
    (set) => ({
      lastSeenHash: null,
      isOpen: false,
      markSeen: (hash) => set({ lastSeenHash: hash }),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
    }),
    {
      name: 'changelog-store',
      partialize: (state) => ({ lastSeenHash: state.lastSeenHash }),
    },
  ),
);
