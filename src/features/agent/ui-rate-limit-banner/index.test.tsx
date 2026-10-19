// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';

import type { AgentBackendType } from '@shared/agent-backend-types';
import type { ModelProfile } from '@shared/model-profiles';

import { api } from '@/lib/api';

import { RateLimitBanner } from './index';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

const PROFILES: ModelProfile[] = [
    {
    id: 'anthropic',
    name: 'Anthropic',
    presets: [],
    quickPresetIds: [],
    roles: { agent: { backend: 'claude-code', model: 'sonnet', thinkingEffort: 'high' } },
  },
    {
    id: 'codex',
    name: 'Codex fallback',
    presets: [],
    quickPresetIds: [],
    roles: { agent: { backend: 'opencode', model: 'gpt-5', thinkingEffort: 'low' } },
  },
];

function mockLimitEvents() {
  const listeners = new Set<
    (data: { from: string; to: string; model?: string }) => void
  >();
  vi.spyOn(api, 'onRateLimitSwap').mockImplementation((callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  });
  return {
    emit: (data: { from: string; to: string }) => {
      for (const listener of [...listeners]) listener(data);
    },
  };
}

async function render(projectId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(['settings', 'modelProfiles'], PROFILES);
  client.setQueryData(['settings', 'activeModelProfileId'], 'anthropic');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={client}>
        <RateLimitBanner projectId={projectId} />
      </QueryClientProvider>,
    );
  });
  return client;
}

describe('RateLimitBanner', () => {
  it('renders nothing while no rate limit is in effect', async () => {
    mockLimitEvents();
    await render('project-1');
    expect(container?.textContent).toBe('');
  });

  it('announces the swap and reverts on click', async () => {
    const events = mockLimitEvents();
    vi.spyOn(api.rateLimitSwap, 'react').mockResolvedValue({
      backend: 'codex' as AgentBackendType,
      swapped: true,
      skippedDueToRateLimit: true,
      profileId: 'codex',
    });
    vi.spyOn(api.rateLimitSwap, 'resolve').mockResolvedValue({
      backend: 'codex' as AgentBackendType,
      swapped: true,
    });
    const activate = vi
      .spyOn(api.modelProfiles, 'activate')
      .mockResolvedValue(PROFILES[0]);

    await render('project-1');

    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
    });

    expect(container?.textContent).toContain(
      'Claude limit reached — switched to Codex fallback',
    );

    const revert = container?.querySelector<HTMLButtonElement>(
      'button[data-testid="rate-limit-banner-revert"]',
    );
    expect(revert).toBeTruthy();
    await act(async () => {
      revert?.click();
    });

    expect(activate).toHaveBeenCalledWith('anthropic', 'project-1');
    expect(container?.textContent).toBe('');
  });

  it('shows a blocking error for an enforce project instead of switching', async () => {
    const events = mockLimitEvents();
    vi.spyOn(api.rateLimitSwap, 'react').mockResolvedValue({
      backend: 'claude-code' as AgentBackendType,
      swapped: false,
      skippedDueToRateLimit: true,
      blocked: {
        reason: 'backend-not-allowed',
        message:
          'claude-code is rate limited, but this project only permits claude-code.',
        allowedBackends: ['claude-code'] as AgentBackendType[],
      },
    });
    const activate = vi.spyOn(api.modelProfiles, 'activate');

    await render('enforced-project');

    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
    });

    expect(container?.textContent).toContain('Claude limit reached');
    expect(container?.textContent).toContain(
      'this project only permits claude-code',
    );
    expect(
      container?.querySelector('button[data-testid="rate-limit-banner-revert"]'),
    ).toBeNull();
    expect(activate).not.toHaveBeenCalled();
  });
});
