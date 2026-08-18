// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import type { FeedItem } from '@shared/feed-types';
import type { AzureDevOpsPolicyEvaluation } from '@shared/azure-devops-types';

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

import { countRailCiStatuses, FeedItemCard } from './feed-item-card';

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

  it('shows a Draft badge for pr-review tasks whose PR is a draft', async () => {
    await act(() =>
      root.render(
        <FeedItemCard item={{ ...item('pr-review'), isDraft: true }} />,
      ),
    );
    expect(container.querySelector('[aria-label="Draft"]')?.textContent).toBe(
      'Draft',
    );

    await act(() =>
      root.render(
        <FeedItemCard item={{ ...item('pr-review'), isDraft: false }} />,
      ),
    );
    expect(container.querySelector('[aria-label="Draft"]')).toBeNull();
  });
});

describe('countRailCiStatuses', () => {
  function evaluation(
    overrides: Partial<AzureDevOpsPolicyEvaluation> = {},
  ): AzureDevOpsPolicyEvaluation {
    return {
      evaluationId: 'eval-1',
      status: 'queued',
      isBlocking: true,
      configuration: {
        id: 1,
        isEnabled: true,
        isBlocking: true,
        type: { id: 'build', displayName: 'Build' },
        settings: { buildDefinitionId: 123, displayName: 'CI' },
      },
      ...overrides,
    };
  }

  it('counts an expired evaluation as expired, not running', () => {
    // Azure keeps status=queued and the stale buildId on expiry — the old
    // `queued && buildId` heuristic made these spin forever.
    const counts = countRailCiStatuses([
      evaluation({ context: { buildId: 42, isExpired: true } }),
    ]);
    expect(counts).toEqual({ running: 0, pending: 0, failed: 0, expired: 1 });
  });

  it('still counts a live queued build with a buildId as running', () => {
    const counts = countRailCiStatuses([
      evaluation({ context: { buildId: 42 } }),
    ]);
    expect(counts.running).toBe(1);
    expect(counts.expired).toBe(0);
  });

  it('keeps a rejected evaluation failed even once it expires', () => {
    const counts = countRailCiStatuses([
      evaluation({ status: 'rejected', context: { isExpired: true } }),
    ]);
    expect(counts.failed).toBe(1);
    expect(counts.expired).toBe(0);
  });

  it('counts a queued evaluation with no build as pending', () => {
    expect(countRailCiStatuses([evaluation()]).pending).toBe(1);
  });

  it('ignores non-build policies', () => {
    const counts = countRailCiStatuses([
      evaluation({
        context: { isExpired: true },
        configuration: {
          id: 2,
          isEnabled: true,
          isBlocking: true,
          type: { id: 'work-item-linking', displayName: 'Work items' },
          settings: { displayName: 'Work items' },
        },
      }),
    ]);
    expect(counts).toEqual({ running: 0, pending: 0, failed: 0, expired: 0 });
  });
});
