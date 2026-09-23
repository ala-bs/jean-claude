// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCache } from '@/cache/cache-store';
import { ingestProject } from '@/cache/domains/projects';
import { applyCacheEvent } from '@/cache/cache-events';
import { handleCacheEvent } from '@/cache/cache-listener';
import type { AzureDevOpsPullRequestDetails } from '@/lib/api';
import type { Project } from '@shared/types';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';

import { PrAutoComplete } from '.';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api', () => ({
  api: {
    projects: { findById: vi.fn(async () => undefined) },
    cache: { setSubscriptions: vi.fn(async () => undefined) },
  },
}));

vi.mock('@/hooks/use-pull-requests', async () => {
  const actual = await vi.importActual<
    typeof import('@/hooks/use-pull-requests')
  >('@/hooks/use-pull-requests');
  return {
    ...actual,
      useCurrentAzureUser: () => ({
      data: { id: 'user-1', emailAddress: 'me@example.com' },
    }),
    useSetAutoComplete: () => ({ mutate: vi.fn(), isAnyPending: false }),
    useRequeuePolicyEvaluation: () => ({ mutate: vi.fn() }),
    usePullRequestPolicyEvaluations: () => ({ data: [], isPending: false }),
    useInvalidatePullRequestDetails: () => vi.fn(),
  };
});

const project = (queuePrAutoComplete: boolean) =>
  ({
    id: 'project-1',
    name: 'Jean-Claude',
    path: '/repo',
    color: '#fff',
    queuePrAutoComplete,
  }) as unknown as Project;

const pr = {
  id: 17,
  title: 'Some PR',
  status: 'active',
  isDraft: false,
  autoCompleteSetBy: null,
  createdBy: { id: 'user-1', uniqueName: 'me@example.com' },
  reviewers: [],
} as unknown as AzureDevOpsPullRequestDetails;

describe('PrAutoComplete queue toggle sync', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('switches to queue mode as soon as the project setting flips on', async () => {
    ingestProject(project(false));

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <PrAutoComplete pr={pr} projectId="project-1" />
        </RootKeyboardBindings>,
      );
    });

    const button = container.querySelector('button');
    expect(button?.getAttribute('title')).toBeNull();

    await act(async () => {
      applyCacheEvent({ type: 'project.upsert', project: project(true) });
    });

    expect(container.querySelector('button')?.getAttribute('title')).toContain(
      'completion queue',
    );
  });

  // Stronger than the test above: this goes through `handleCacheEvent`, the
  // real renderer entry point, so it also exercises the `shouldApplyCacheEvent`
  // gate that decides whether an incoming project event is applied at all.
  it('applies an incoming project.upsert through the renderer cache listener', async () => {
    ingestProject(project(false));

    await act(async () => {
      root.render(
        <RootKeyboardBindings>
          <PrAutoComplete pr={pr} projectId="project-1" />
        </RootKeyboardBindings>,
      );
    });

    expect(container.querySelector('button')?.getAttribute('title')).toBeNull();

    await act(async () => {
      handleCacheEvent(
        { type: 'project.upsert', project: project(true) },
        { invalidateQueries: vi.fn() },
      );
    });

    expect(container.querySelector('button')?.getAttribute('title')).toContain(
      'completion queue',
    );
  });
});
