// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { AgentBackendType } from '@shared/agent-backend-types';
import type { ModelProfile } from '@shared/model-profiles';

import { api } from '@/lib/api';

import { useRateLimitFallback } from './use-rate-limit-fallback';

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

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * Captures the renderer-side rate-limit listener so a test can fire a real
 * limit event without going through IPC.
 */
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

async function render(
  client: QueryClient,
  Harness: () => null,
): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(Harness)),
    );
  });
}

function seed(client: QueryClient) {
  client.setQueryData(['settings', 'modelProfiles'], PROFILES);
  client.setQueryData(['settings', 'activeModelProfileId'], 'anthropic');
}

describe('useRateLimitFallback', () => {
  it('activates the fallback exactly once per limit event', async () => {
    const events = mockLimitEvents();
    const react = vi.spyOn(api.rateLimitSwap, 'react').mockResolvedValue({
      backend: 'codex' as AgentBackendType,
      swapped: true,
      skippedDueToRateLimit: true,
      profileId: 'codex',
    });
    vi.spyOn(api.rateLimitSwap, 'resolve').mockResolvedValue({
      backend: 'codex' as AgentBackendType,
      swapped: true,
    });

    const client = makeQueryClient();
    seed(client);

    let result: ReturnType<typeof useRateLimitFallback> | undefined;
    await render(client, function Harness() {
      result = useRateLimitFallback({ projectId: 'project-1' });
      return null;
    });

    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
      events.emit({ from: 'claude-code', to: 'codex' });
    });
    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
    });

    expect(react).toHaveBeenCalledTimes(1);
    expect(react).toHaveBeenCalledWith({
      backend: 'claude-code',
      projectId: 'project-1',
    });
    expect(result?.state).toMatchObject({
      kind: 'swapped',
      fromBackend: 'claude-code',
      toBackend: 'codex',
      previousProfileId: 'anthropic',
    });
    expect(result?.targetLabel).toBe('Codex fallback');
    expect(result?.sourceLabel).toBe('Claude');
  });

  it('reverts to the previous profile on manual revert', async () => {
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

    const client = makeQueryClient();
    seed(client);

    let result: ReturnType<typeof useRateLimitFallback> | undefined;
    await render(client, function Harness() {
      result = useRateLimitFallback({ projectId: 'project-1' });
      return null;
    });

    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
    });
    expect(result?.state.kind).toBe('swapped');

    await act(async () => {
      await result?.revert();
    });

    expect(activate).toHaveBeenCalledWith('anthropic', 'project-1');
    expect(result?.state.kind).toBe('idle');
  });

  it('auto-reverts when the quota resets', async () => {
    const events = mockLimitEvents();
    vi.spyOn(api.rateLimitSwap, 'react').mockResolvedValue({
      backend: 'codex' as AgentBackendType,
      swapped: true,
      skippedDueToRateLimit: true,
      profileId: 'codex',
    });
    const resolve = vi
      .spyOn(api.rateLimitSwap, 'resolve')
      .mockResolvedValueOnce({
        backend: 'codex' as AgentBackendType,
        swapped: true,
      })
      // Quota reset: the backend is no longer rate-limited.
      .mockResolvedValue({
        backend: 'claude-code' as AgentBackendType,
        swapped: false,
      });
    const activate = vi
      .spyOn(api.modelProfiles, 'activate')
      .mockResolvedValue(PROFILES[0]);

    const client = makeQueryClient();
    seed(client);

    let result: ReturnType<typeof useRateLimitFallback> | undefined;
    await render(client, function Harness() {
      result = useRateLimitFallback({ projectId: 'project-1' });
      return null;
    });

    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
    });
    expect(result?.state.kind).toBe('swapped');
    expect(resolve).toHaveBeenCalled();

    await act(async () => {
      await client.refetchQueries({
        queryKey: ['rate-limit-fallback', 'quota'],
      });
    });

    await act(async () => {
      await vi.waitFor(() => expect(result?.state.kind).toBe('idle'));
    });
    expect(activate).toHaveBeenCalledWith('anthropic', 'project-1');
  });

  // The real service returns `{ swapped: false, skippedDueToRateLimit: true }`
  // once the fallback profile is active and no further candidate exists —
  // which is the NORMAL state after a swap in a two-profile fallback order.
  // Reading that as "quota recovered" reverted onto the still-limited backend
  // within a tick, then re-swapped on the next event: a flip-flop.
  it('stays swapped while the backend is still limited with no candidate left', async () => {
    const events = mockLimitEvents();
    vi.spyOn(api.rateLimitSwap, 'react').mockResolvedValue({
      backend: 'codex' as AgentBackendType,
      swapped: true,
      skippedDueToRateLimit: true,
      profileId: 'codex',
    });
    vi.spyOn(api.rateLimitSwap, 'resolve').mockResolvedValue({
      backend: 'claude-code' as AgentBackendType,
      swapped: false,
      skippedDueToRateLimit: true,
    });
    const activate = vi
      .spyOn(api.modelProfiles, 'activate')
      .mockResolvedValue(PROFILES[0]);

    const client = makeQueryClient();
    seed(client);

    let result: ReturnType<typeof useRateLimitFallback> | undefined;
    await render(client, function Harness() {
      result = useRateLimitFallback({ projectId: 'project-1' });
      return null;
    });

    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
    });
    expect(result?.state.kind).toBe('swapped');

    // Let the quota probe actually settle, then give the revert effect the
    // same number of turns the auto-revert test needs to fire.
    await act(async () => {
      await vi.waitFor(() =>
        expect(api.rateLimitSwap.resolve).toHaveBeenCalled(),
      );
    });
    await act(async () => {
      await client.refetchQueries({
        queryKey: ['rate-limit-fallback', 'quota'],
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result?.state.kind).toBe('swapped');
    expect(activate).not.toHaveBeenCalledWith('anthropic');
  });

  it('blocks instead of switching for an enforce project', async () => {
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
    const resolve = vi.spyOn(api.rateLimitSwap, 'resolve');
    const activate = vi.spyOn(api.modelProfiles, 'activate');

    const client = makeQueryClient();
    seed(client);

    let result: ReturnType<typeof useRateLimitFallback> | undefined;
    await render(client, function Harness() {
      result = useRateLimitFallback({ projectId: 'enforced-project' });
      return null;
    });

    await act(async () => {
      events.emit({ from: 'claude-code', to: 'codex' });
    });

    expect(result?.state).toMatchObject({
      kind: 'blocked',
      fromBackend: 'claude-code',
      message:
        'claude-code is rate limited, but this project only permits claude-code.',
    });
    expect(activate).not.toHaveBeenCalled();
    // No fallback is in effect, so there is nothing to poll for a reset.
    expect(resolve).not.toHaveBeenCalled();
  });
});
