import { describe, expect, it, vi } from 'vitest';

import {
  invalidateAgentMemorySettingQueries,
  showAgentMemorySettingUpdateError,
} from './use-settings';

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
