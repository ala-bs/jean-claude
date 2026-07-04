import type {
  UsageDisplayData,
  UsageProviderType,
  UsageResult,
} from '@shared/usage-types';

import { runCodexBarCli } from '../codexbar-cli';

import type { BackendUsageProvider } from './types';
import { formatTimeUntil } from './utils';

const PROVIDER_TO_CODEXBAR_ID: Record<UsageProviderType, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
  copilot: 'copilot',
  opencode: 'opencode',
};

const PROVIDER_LABELS: Record<UsageProviderType, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};

type CodexBarWindow = {
  usedPercent?: number;
  windowMinutes?: number | null;
  resetsAt?: string | null;
};

type CodexBarUsagePayload = {
  provider?: string;
  usage?: {
    primary?: CodexBarWindow | null;
    secondary?: CodexBarWindow | null;
    tertiary?: CodexBarWindow | null;
  };
};

export class CodexBarUsageProvider implements BackendUsageProvider {
  constructor(private readonly providerType: UsageProviderType) {}

  async getUsage(): Promise<UsageResult> {
    try {
      const payload = await this.runCodexBar();
      return { data: this.transformPayload(payload), error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          type: 'api_error',
          message: this.formatError(err),
        },
      };
    }
  }

  dispose(): void {}

  private formatError(err: unknown): string {
    const provider = PROVIDER_TO_CODEXBAR_ID[this.providerType];
    const label = PROVIDER_LABELS[this.providerType];
    const detail = err instanceof Error ? err.message : 'Unknown error';

    if (detail.includes('was not found')) {
      return 'CodexBar CLI not found. Install CodexBar, then click Refresh in Usage Display settings.';
    }

    if (detail.toLowerCase().includes('no available fetch strategy')) {
      if (this.providerType === 'copilot') {
        return 'CodexBar Copilot is not signed in. Sign in via CodexBar Settings > Providers > Copilot, or set a token with `printf \'%s\' "$COPILOT_API_TOKEN" | codexbar config set-api-key --provider copilot --stdin`.';
      }

      return `CodexBar has no configured fetch method for ${label}. Open CodexBar Settings > Providers and configure ${label}.`;
    }

    return `CodexBar could not fetch ${label} usage. Try running \`codexbar --provider ${provider} --format json --json-only\` in Terminal. ${detail}`;
  }

  private runCodexBar(): Promise<CodexBarUsagePayload> {
    const provider = PROVIDER_TO_CODEXBAR_ID[this.providerType];
    return runCodexBarCli(
      ['--provider', provider, '--format', 'json', '--json-only'],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    ).then(({ stdout }) => {
      try {
        const parsed = JSON.parse(stdout) as
          | CodexBarUsagePayload
          | CodexBarUsagePayload[];
        return Array.isArray(parsed) ? parsed[0] : parsed;
      } catch (parseError) {
        throw new Error(
          parseError instanceof Error
            ? `Failed to parse CodexBar JSON: ${parseError.message}`
            : 'Failed to parse CodexBar JSON',
        );
      }
    });
  }

  private transformPayload(payload: CodexBarUsagePayload): UsageDisplayData {
    const windows = [
      ['primary', 'Primary', true, payload.usage?.primary] as const,
      ['secondary', 'Secondary', false, payload.usage?.secondary] as const,
      ['tertiary', 'Tertiary', false, payload.usage?.tertiary] as const,
    ];

    const limits = windows.flatMap(([key, label, isPrimary, window]) => {
      if (
        !window ||
        typeof window.usedPercent !== 'number' ||
        typeof window.windowMinutes !== 'number' ||
        typeof window.resetsAt !== 'string'
      ) {
        return [];
      }

      const resetsAt = new Date(window.resetsAt);
      if (Number.isNaN(resetsAt.getTime())) return [];

      return [
        {
          key,
          label,
          isPrimary,
          range: {
            utilization: window.usedPercent,
            resetsAt,
            timeUntilReset: formatTimeUntil(resetsAt),
            windowDurationMs: window.windowMinutes * 60 * 1000,
          },
        },
      ];
    });

    if (limits.length === 0) {
      throw new Error('CodexBar response did not include usage windows');
    }

    return { limits };
  }
}
