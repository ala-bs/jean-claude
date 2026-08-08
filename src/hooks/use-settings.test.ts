// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { EureciaSetting } from '@shared/types';

import { api } from '@/lib/api';

import {
  invalidateAgentMemorySettingQueries,
  showAgentMemorySettingUpdateError,
  useUpdateEureciaSetting,
} from './use-settings';

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

describe('useUpdateEureciaSetting', () => {
  it('awaits setting invalidation before resetting all Eurecia timesheet queries', async () => {
    const setting: EureciaSetting = {
      baseUrl: 'https://tenant.example',
      axis1Label: 'Project',
      axis2Label: 'Activity',
      axis3Label: 'Role',
    };
    vi.spyOn(api.settings, 'set').mockResolvedValue();
    const queryClient = new QueryClient();
    const providerKey = ['timesheets', 'eurecia'] as const;
    queryClient.setQueryData([...providerKey, 'auth'], { authenticated: true });
    queryClient.setQueryData([...providerKey, 'sheets'], [{ id: 'stale-sheet' }]);
    queryClient.setQueryData([...providerKey, 'sheet', 'sheet-1'], {
      rows: ['stale-editor'],
    });

    let finishInvalidation: () => void = () => {};
    const invalidationGate = new Promise<void>((resolve) => {
      finishInvalidation = resolve;
    });
    const invalidateQueries = vi
      .spyOn(queryClient, 'invalidateQueries')
      .mockImplementation(async () => {
        await invalidationGate;
      });
    const resetQueries = vi.spyOn(queryClient, 'resetQueries');
    let result: ReturnType<typeof useUpdateEureciaSetting> | undefined;
    function Harness() {
      result = useUpdateEureciaSetting();
      return null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Harness),
        ),
      );
    });

    let mutation: Promise<unknown> | undefined;
    act(() => {
      mutation = result?.mutateAsync(setting);
    });
    await act(async () => {
      await vi.waitFor(() => expect(invalidateQueries).toHaveBeenCalledOnce());
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['settings', 'eurecia'],
    });
    expect(resetQueries).not.toHaveBeenCalled();

    await act(async () => {
      finishInvalidation();
      await mutation;
    });

    expect(resetQueries).toHaveBeenCalledWith({ queryKey: providerKey });
    expect(queryClient.getQueryData([...providerKey, 'auth'])).toBeUndefined();
    expect(queryClient.getQueryData([...providerKey, 'sheets'])).toBeUndefined();
    expect(
      queryClient.getQueryData([...providerKey, 'sheet', 'sheet-1']),
    ).toBeUndefined();
  });
});

describe('invalidateAgentMemorySettingQueries', () => {
  it('refreshes both setting and dashboard state after consent changes', async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);

    await invalidateAgentMemorySettingQueries({ invalidateQueries } as never);

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['settings', 'agentMemory'],
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['agent-memory-dashboard'],
    });
  });
});

describe('showAgentMemorySettingUpdateError', () => {
  it('shows an error toast when a setting update fails', () => {
    const addToast = vi.fn();

    showAgentMemorySettingUpdateError(addToast);

    expect(addToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'Failed to update Agent Memory setting',
    });
  });
});
