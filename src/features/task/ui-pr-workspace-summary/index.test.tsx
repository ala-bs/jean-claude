// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { formatRefName, PrWorkspaceSummary } from '.';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  pullRequest: undefined as unknown,
  isLoading: false,
}));

vi.mock('@/hooks/use-pull-requests', () => ({
  usePullRequest: () => ({
    data: mocks.pullRequest,
    isLoading: mocks.isLoading,
  }),
}));

vi.mock('@/features/common/ui-azure-html-content', () => ({
  AzureMarkdownContent: ({ markdown }: { markdown: string }) => (
    <div data-testid="markdown">{markdown}</div>
  ),
}));

describe('PrWorkspaceSummary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.pullRequest = undefined;
    mocks.isLoading = false;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  async function render() {
    await act(async () => {
      root.render(
        <PrWorkspaceSummary
          projectId="project-1"
          pullRequestId="10533"
          providerId="provider-1"
        />,
      );
    });
  }

  it('strips ref prefixes', () => {
    expect(formatRefName('refs/heads/feature')).toBe('feature');
    expect(formatRefName(undefined)).toBe('');
    // Only the leading prefix is stripped.
    expect(formatRefName('refs/heads/feat/refs/heads/x')).toBe(
      'feat/refs/heads/x',
    );
  });

  it('shows a loading state before the pull request resolves', async () => {
    mocks.isLoading = true;
    await render();

    expect(container.textContent).toContain('Loading pull request');
  });

  it('renders title, branches, draft badge, and description markdown', async () => {
    mocks.pullRequest = {
      title: 'Fix workspace access',
      description: 'Some **details** here',
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
      isDraft: true,
    };
    await render();

    expect(container.textContent).toContain('Fix workspace access');
    expect(container.textContent).toContain('feature');
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('Draft');
    expect(
      container.querySelector('[data-testid="markdown"]')?.textContent,
    ).toBe('Some **details** here');
  });

  it('falls back to a no-description hint', async () => {
    mocks.pullRequest = {
      title: 'No body PR',
      description: '   ',
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
      isDraft: false,
    };
    await render();

    expect(container.textContent).toContain('No description');
    expect(container.querySelector('[data-testid="markdown"]')).toBeNull();
    expect(container.textContent).not.toContain('Draft');
  });
});
