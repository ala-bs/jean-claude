import { randomUUID } from 'crypto';

import type {
  UsageDisplayData,
  UsageProviderMap,
  UsageProviderType,
  UsageResult,
} from '@shared/usage-types';

import { SettingsRepository } from '../database/repositories/settings';
import { UsageSnapshotRepository } from '../database/repositories/usage-snapshots';

import type { BackendUsageProvider } from './usage-providers/types';
import { ClaudeUsageProvider } from './usage-providers/claude-usage-provider';
import { CodexBarUsageProvider } from './usage-providers/codexbar-usage-provider';
import { CodexUsageProvider } from './usage-providers/codex-usage-provider';
import { CopilotUsageProvider } from './usage-providers/copilot-usage-provider';
import { encryptionService } from './encryption-service';
import { GeminiUsageProvider } from './usage-providers/gemini-usage-provider';


class AgentUsageService {
  private providers = new Map<string, BackendUsageProvider>();
  private cache = new Map<string, { value: UsageResult; cachedAt: number }>();
  private inFlight = new Map<string, Promise<UsageResult>>();
  private cacheVersions = new Map<string, number>();
  private lastCleanupAt = 0;

  private static readonly DEFAULT_CACHE_TTL_MS = 2 * 60 * 1000;
  private static readonly CLAUDE_CACHE_TTL_MS = 7 * 60 * 1000;
  private static readonly RETENTION_DAYS = 90;
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  async getUsage(
    providerTypes: UsageProviderType[],
  ): Promise<UsageProviderMap> {
    if (providerTypes.length === 0) return {};

    const results = await Promise.allSettled(
      providerTypes.map(async (providerType) => {
        const result = await this.getUsageForProvider(providerType);
        return [providerType, result] as const;
      }),
    );

    const usageMap: UsageProviderMap = {};

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const [providerType, usageResult] = result.value;
        usageMap[providerType] = usageResult;
      }
    }

    return usageMap;
  }

  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
    this.cache.clear();
    this.inFlight.clear();
    this.cacheVersions.clear();
  }

  invalidate(providerType?: UsageProviderType): void {
    if (providerType) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${providerType}:`)) {
          this.bumpCacheVersion(key);
          this.cache.delete(key);
        }
      }
      for (const key of this.inFlight.keys()) {
        if (key.startsWith(`${providerType}:`)) {
          this.bumpCacheVersion(key);
          this.inFlight.delete(key);
        }
      }
      for (const [key, provider] of this.providers) {
        if (key.startsWith(`${providerType}:`)) {
          this.bumpCacheVersion(key);
          provider.dispose();
          this.providers.delete(key);
        }
      }
      return;
    }
    for (const key of new Set([
      ...this.cache.keys(),
      ...this.inFlight.keys(),
      ...this.providers.keys(),
    ])) {
      this.bumpCacheVersion(key);
    }
    this.cache.clear();
    this.inFlight.clear();
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
  }

  private async getUsageForProvider(
    providerType: UsageProviderType,
  ): Promise<UsageResult> {
    const now = Date.now();
    const usageSettings = await SettingsRepository.get('usageDisplay');
    const useCodexBar = usageSettings.useCodexBar ?? false;
    const providerKey = this.getProviderCacheKey(providerType, useCodexBar);
    const cached = this.cache.get(providerKey);
    const cacheTtlMs = this.getCacheTtlMs(providerType);

    if (cached && now - cached.cachedAt < cacheTtlMs) {
      return cached.value;
    }

    const existingRequest = this.inFlight.get(providerKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async () => {
      const provider = this.getOrCreateProvider(providerType, useCodexBar);
      const requestVersion = this.cacheVersions.get(providerKey) ?? 0;
      const value = await provider.getUsage();

      if ((this.cacheVersions.get(providerKey) ?? 0) !== requestVersion) {
        return this.getUsageForProvider(providerType);
      }

      if (value.data) {
        this.cache.set(providerKey, { value, cachedAt: Date.now() });
      }

      if (value.data) {
        this.persistSnapshots(providerType, value.data).catch((err) => {
          console.warn('[usage-snapshots] Failed to persist:', err);
        });
        this.maybeCleanupOldSnapshots();
      }

      return value;
    })();

    this.inFlight.set(providerKey, request);

    try {
      return await request;
    } finally {
      if (this.inFlight.get(providerKey) === request) {
        this.inFlight.delete(providerKey);
      }
    }
  }

  private getCacheTtlMs(providerType: UsageProviderType): number {
    if (providerType === 'claude-code') {
      return AgentUsageService.CLAUDE_CACHE_TTL_MS;
    }

    return AgentUsageService.DEFAULT_CACHE_TTL_MS;
  }

  private getOrCreateProvider(
    providerType: UsageProviderType,
    useCodexBar: boolean,
  ): BackendUsageProvider {
    const providerKey = this.getProviderCacheKey(providerType, useCodexBar);
    let provider = this.providers.get(providerKey);
    if (!provider) {
      provider = this.createProvider(providerType, useCodexBar);
      this.providers.set(providerKey, provider);
    }
    return provider;
  }

  private getProviderCacheKey(
    providerType: UsageProviderType,
    useCodexBar: boolean,
  ): string {
    return `${providerType}:${useCodexBar ? 'codexbar' : 'native'}`;
  }

  private bumpCacheVersion(key: string): void {
    this.cacheVersions.set(key, (this.cacheVersions.get(key) ?? 0) + 1);
  }

  private async persistSnapshots(
    provider: UsageProviderType,
    data: UsageDisplayData,
  ): Promise<void> {
    const now = new Date().toISOString();
    const snapshots = data.limits.map((limit) => ({
      id: randomUUID(),
      provider,
      limitKey: limit.key,
      utilization: limit.range.utilization,
      resetsAt: limit.range.resetsAt.toISOString(),
      recordedAt: now,
    }));
    await UsageSnapshotRepository.record(snapshots);
  }

  private maybeCleanupOldSnapshots(): void {
    const now = Date.now();
    if (now - this.lastCleanupAt < AgentUsageService.CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanupAt = now;

    const cutoff = new Date(
      now - AgentUsageService.RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    UsageSnapshotRepository.deleteOlderThan(cutoff).catch((err) => {
      console.warn('[usage-snapshots] Failed to cleanup:', err);
    });
  }

  private createProvider(
    providerType: UsageProviderType,
    useCodexBar: boolean,
  ): BackendUsageProvider {
    if (useCodexBar) {
      return new CodexBarUsageProvider(providerType);
    }

    switch (providerType) {
      case 'claude-code':
        return new ClaudeUsageProvider();
      case 'codex':
        return new CodexUsageProvider();
      case 'gemini':
        return new GeminiUsageProvider();
      case 'copilot':
        return new CopilotUsageProvider({
          getToken: async () => {
            const setting = await SettingsRepository.get('usageDisplay');
            return setting.copilotToken
              ? encryptionService.decrypt(setting.copilotToken)
              : null;
          },
        });
      case 'opencode':
        return {
          getUsage: async () => ({
            data: null,
            error: {
              type: 'api_error',
              message: 'OpenCode usage requires CodexBar source to be enabled.',
            },
          }),
          dispose: () => {},
        };
      default: {
        const _exhaustive: never = providerType;
        throw new Error(`Unknown usage provider: ${_exhaustive}`);
      }
    }
  }
}

export const agentUsageService = new AgentUsageService();
