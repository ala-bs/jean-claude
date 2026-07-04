import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UsageDisplaySetting } from '@shared/types';
import type { UsageResult } from '@shared/usage-types';

const mocks = vi.hoisted(() => ({
  claudeGetUsage: vi.fn(),
  codexBarGetUsage: vi.fn(),
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: {
    get: vi.fn(),
  },
}));

vi.mock('../database/repositories/usage-snapshots', () => ({
  UsageSnapshotRepository: {
    record: vi.fn().mockResolvedValue(undefined),
    deleteOlderThan: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('./usage-providers/claude-usage-provider', () => ({
  ClaudeUsageProvider: vi.fn(() => ({
    getUsage: mocks.claudeGetUsage,
    dispose: vi.fn(),
  })),
}));

vi.mock('./usage-providers/codexbar-usage-provider', () => ({
  CodexBarUsageProvider: vi.fn(() => ({
    getUsage: mocks.codexBarGetUsage,
    dispose: vi.fn(),
  })),
}));

vi.mock('./usage-providers/codex-usage-provider', () => ({
  CodexUsageProvider: vi.fn(),
}));

vi.mock('./usage-providers/copilot-usage-provider', () => ({
  CopilotUsageProvider: vi.fn(),
}));

vi.mock('./usage-providers/gemini-usage-provider', () => ({
  GeminiUsageProvider: vi.fn(),
}));

import { SettingsRepository } from '../database/repositories/settings';

import { agentUsageService } from './agent-usage-service';

function makeUsage(utilization: number): UsageResult {
  return {
    data: {
      limits: [
        {
          key: 'primary',
          label: 'Primary',
          isPrimary: true,
          range: {
            utilization,
            resetsAt: new Date('2026-01-01T00:00:00.000Z'),
            timeUntilReset: '1h',
            windowDurationMs: 60 * 60 * 1000,
          },
        },
      ],
    },
    error: null,
  };
}

describe('agentUsageService', () => {
  let usageSetting: UsageDisplaySetting;

  beforeEach(() => {
    agentUsageService.dispose();
    mocks.claudeGetUsage.mockReset();
    mocks.codexBarGetUsage.mockReset();
    usageSetting = { enabledProviders: ['claude-code'], useCodexBar: false };
    vi.mocked(SettingsRepository.get).mockImplementation(async (key) => {
      if (key === 'usageDisplay') return usageSetting;
      throw new Error(`Unexpected settings key: ${key}`);
    });
  });

  it('keeps native and CodexBar usage caches separate', async () => {
    mocks.claudeGetUsage.mockResolvedValue(makeUsage(10));
    mocks.codexBarGetUsage.mockResolvedValue(makeUsage(20));

    const nativeUsage = await agentUsageService.getUsage(['claude-code']);
    usageSetting = { enabledProviders: ['claude-code'], useCodexBar: true };
    const codexBarUsage = await agentUsageService.getUsage(['claude-code']);

    expect(
      nativeUsage['claude-code']?.data?.limits[0]?.range.utilization,
    ).toBe(10);
    expect(
      codexBarUsage['claude-code']?.data?.limits[0]?.range.utilization,
    ).toBe(20);
    expect(mocks.claudeGetUsage).toHaveBeenCalledTimes(1);
    expect(mocks.codexBarGetUsage).toHaveBeenCalledTimes(1);
  });

  it('does not let invalidated requests overwrite newer cache entries', async () => {
    let resolveOldRequest: (value: UsageResult) => void = () => {};
    const oldRequest = new Promise<UsageResult>((resolve) => {
      resolveOldRequest = resolve;
    });
    mocks.claudeGetUsage
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(makeUsage(20));

    const firstUsage = agentUsageService.getUsage(['claude-code']);
    await vi.waitFor(() => {
      expect(mocks.claudeGetUsage).toHaveBeenCalledTimes(1);
    });
    agentUsageService.invalidate('claude-code');
    const secondUsage = await agentUsageService.getUsage(['claude-code']);
    resolveOldRequest(makeUsage(10));
    const resolvedFirstUsage = await firstUsage;
    const cachedUsage = await agentUsageService.getUsage(['claude-code']);

    expect(
      resolvedFirstUsage['claude-code']?.data?.limits[0]?.range.utilization,
    ).toBe(20);
    expect(
      secondUsage['claude-code']?.data?.limits[0]?.range.utilization,
    ).toBe(20);
    expect(
      cachedUsage['claude-code']?.data?.limits[0]?.range.utilization,
    ).toBe(20);
    expect(mocks.claudeGetUsage).toHaveBeenCalledTimes(2);
  });
});
