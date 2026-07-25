// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { FeedItem } from '@shared/feed-types';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/common/ui/dropdown', () => ({
  Dropdown: ({ trigger }: { trigger: (props: { triggerRef: { current: null } }) => React.ReactNode }) =>
    trigger({ triggerRef: { current: null } }),
  DropdownDivider: () => null,
  DropdownInfo: () => null,
  DropdownItem: () => null,
}));
vi.mock('@/hooks/use-pull-requests', () => ({
  useCachedPullRequest: () => ({ data: null }),
  usePullRequest: () => ({ data: null }),
  usePullRequestPolicyEvaluations: () => ({ data: null }),
}));
vi.mock('@/hooks/use-tasks', () => ({
  useCompleteTask: () => ({ mutate: vi.fn(), isPending: false }),
  useTask: () => ({ data: null }),
}));
vi.mock('@/features/task/ui-task-panel/complete-task-dialog', () => ({ CompleteTaskDialog: () => null }));
vi.mock('@/features/pull-request/ui-pr-auto-complete', () => ({ PrAutoComplete: () => null }));
vi.mock('@/features/project/ui-project-logo', () => ({ ProjectLogoBackground: () => null }));
vi.mock('@/stores/background-jobs', () => ({
  bgJobLabel: () => '',
  useRunningBackgroundJobsForTask: () => [],
}));
vi.mock('@/stores/review-comments', () => ({ useOpenReviewCommentCount: () => 0 }));
vi.mock('@/stores/feed', () => ({
  useFeedStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      pin: vi.fn(),
      unpin: vi.fn(),
      dismiss: vi.fn(),
      toggleLowPriority: vi.fn(),
      pinned: [],
      lowPriority: [],
    }),
}));
vi.mock('@/stores/new-task-draft', () => ({
  useNewTaskDraftStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ setSelectedProjectId: vi.fn(), setDraft: vi.fn() }),
}));
vi.mock('@/stores/overlays', () => ({
  useOverlaysStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ open: vi.fn() }),
}));
vi.mock('@/stores/task-messages', () => ({
  useTaskMessagesStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ runCommandRunning: {} }),
}));
vi.mock('./use-feed-item-project', () => ({
  useFeedItemProject: (item: FeedItem) => ({ name: item.projectName, color: item.projectColor }),
}));

import { FeedItemCard } from './feed-item-card';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function item(taskType?: string): FeedItem {
  return {
    id: 'task:1',
    source: 'task',
    attention: 'waiting',
    timestamp: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    projectName: 'Project',
    projectColor: '#fff',
    projectPriority: 'normal',
    title: 'Keep this title',
    taskId: 'task-1',
    taskType,
  };
}

describe('FeedItemCard PR workspace badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
  });

  it('shows a noninteractive PR Workspace badge only for pr-review tasks', async () => {
    await act(() => root.render(<FeedItemCard item={item('pr-review')} />));
    const badge = container.querySelector('[aria-label="PR Workspace"]');
    expect(badge?.textContent).toBe('PR Workspace');
    expect(badge?.tagName).toBe('SPAN');
    expect(badge?.className).toContain('text-[10px]');
    expect(container.textContent).toContain('Keep this title');

    await act(() => root.render(<FeedItemCard item={item('agent')} />));
    expect(container.querySelector('[aria-label="PR Workspace"]')).toBeNull();
  });
});
