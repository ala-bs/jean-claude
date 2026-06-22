import type { UsageDisplayData, UsageResult } from '@shared/usage-types';

import type { BackendUsageProvider } from './types';
import { formatTimeUntil } from './utils';

interface CopilotQuotaSnapshot {
  entitlement?: number | string;
  remaining?: number | string;
  percent_remaining?: number | string;
}

interface CopilotUsageResponse {
  quota_snapshots?: {
    premium_interactions?: CopilotQuotaSnapshot;
    chat?: CopilotQuotaSnapshot;
  };
  monthly_quotas?: {
    completions?: number | string;
    chat?: number | string;
  };
  limited_user_quotas?: {
    completions?: number | string;
    chat?: number | string;
  };
  quota_reset_date?: string;
}

interface CopilotUsageProviderOptions {
  fetchImpl?: typeof fetch;
  getToken?: () => Promise<string | null> | string | null;
  now?: () => Date;
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export class CopilotUsageProvider implements BackendUsageProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly getTokenValue: () => Promise<string | null> | string | null;
  private readonly now: () => Date;

  constructor(options: CopilotUsageProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.getTokenValue = options.getToken ?? (() => null);
    this.now = options.now ?? (() => new Date());
  }

  async getUsage(): Promise<UsageResult> {
    try {
      const token = await this.getToken();
      if (!token) {
        return {
          data: null,
          error: {
            type: 'no_token',
            message:
              'GitHub Copilot token not configured in Settings > General > Usage Display.',
          },
        };
      }

      const response = await this.fetchImpl(
        'https://api.github.com/copilot_internal/user',
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/json',
            'Editor-Version': 'vscode/1.96.2',
            'Editor-Plugin-Version': 'copilot-chat/0.26.7',
            'User-Agent': 'GitHubCopilotChat/0.26.7',
            'X-Github-Api-Version': '2025-04-01',
          },
        },
      );

      if (response.status === 401 || response.status === 403) {
        return {
          data: null,
          error: {
            type: 'api_error',
            message: 'GitHub Copilot token was rejected.',
            statusCode: response.status,
          },
        };
      }
      if (!response.ok) {
        return {
          data: null,
          error: {
            type: 'api_error',
            message: `GitHub Copilot usage API error: ${response.statusText}`,
            statusCode: response.status,
          },
        };
      }

      const usage = (await response.json()) as CopilotUsageResponse;
      return { data: this.transformUsage(usage), error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          type: 'api_error',
          message:
            err instanceof Error ? err.message : 'GitHub Copilot usage error',
        },
      };
    }
  }

  dispose(): void {}

  private async getToken(): Promise<string | null> {
    const token = await this.getTokenValue();
    const trimmed = token?.trim();
    return trimmed ? trimmed : null;
  }

  private transformUsage(usage: CopilotUsageResponse): UsageDisplayData {
    const resetDate = usage.quota_reset_date
      ? new Date(usage.quota_reset_date)
      : new Date(this.now().getTime() + MONTH_MS);
    const premium =
      this.percentRemaining(usage.quota_snapshots?.premium_interactions) ??
      this.percentFromMonthly(
        usage.monthly_quotas?.completions,
        usage.limited_user_quotas?.completions,
      );
    const chat =
      this.percentRemaining(usage.quota_snapshots?.chat) ??
      this.percentFromMonthly(
        usage.monthly_quotas?.chat,
        usage.limited_user_quotas?.chat,
      );

    const limits: UsageDisplayData['limits'] = [];
    if (premium !== null) {
      limits.push(this.toLimit('premium', 'Premium', true, premium, resetDate));
    }
    if (chat !== null) {
      limits.push(this.toLimit('chat', 'Chat', false, chat, resetDate));
    }
    if (limits.length === 0) {
      throw new Error(
        'GitHub Copilot usage response did not include quota data',
      );
    }
    return { limits };
  }

  private percentRemaining(snapshot?: CopilotQuotaSnapshot): number | null {
    if (!snapshot) return null;
    const explicit = this.numberValue(snapshot.percent_remaining);
    if (explicit !== null) return Math.max(0, Math.min(100, explicit));
    return this.percentFromMonthly(snapshot.entitlement, snapshot.remaining);
  }

  private percentFromMonthly(
    entitlement: number | string | undefined,
    remaining: number | string | undefined,
  ): number | null {
    const entitlementValue = this.numberValue(entitlement);
    const remainingValue = this.numberValue(remaining);
    if (!entitlementValue || remainingValue === null) return null;
    return Math.max(
      0,
      Math.min(100, (remainingValue / entitlementValue) * 100),
    );
  }

  private numberValue(value: number | string | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private toLimit(
    key: string,
    label: string,
    isPrimary: boolean,
    percentRemaining: number,
    resetsAt: Date,
  ): UsageDisplayData['limits'][number] {
    return {
      key,
      label,
      isPrimary,
      range: {
        utilization: 100 - percentRemaining,
        resetsAt,
        timeUntilReset: formatTimeUntil(resetsAt),
        windowDurationMs: MONTH_MS,
      },
    };
  }
}
