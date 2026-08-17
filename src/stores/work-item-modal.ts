import { create } from 'zustand';

type WorkItemModalState = {
  target: { projectId: string; workItemId: number } | null;
  open: (target: { projectId: string; workItemId: number }) => void;
  close: () => void;
};

export const useWorkItemModalStore = create<WorkItemModalState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
