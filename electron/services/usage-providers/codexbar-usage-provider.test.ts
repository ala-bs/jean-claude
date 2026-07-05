import { execFile } from 'child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexBarUsageProvider } from './codexbar-usage-provider';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

describe('CodexBarUsageProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockCodexBar(stdout: string) {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, stdout, '');
      return {} as ReturnType<typeof execFile>;
    });
  }

  it('maps CodexBar usage JSON to display data', async () => {
    mockCodexBar(
      JSON.stringify({
        provider: 'codex',
        usage: {
          primary: {
            usedPercent: 28,
            windowMinutes: 300,
            resetsAt: '2026-07-04T19:15:00Z',
          },
          secondary: {
            usedPercent: 59,
            windowMinutes: 10080,
            resetsAt: '2026-07-05T17:00:00Z',
          },
        },
      }),
    );

    const result = await new CodexBarUsageProvider('codex').getUsage();

    expect(execFile).toHaveBeenCalledWith(
      'codexbar',
      ['--provider', 'codex', '--format', 'json', '--json-only'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(result.error).toBeNull();
    expect(result.data?.limits).toHaveLength(2);
    expect(result.data?.limits[0].range.utilization).toBe(28);
    expect(result.data?.limits[0].range.windowDurationMs).toBe(
      300 * 60 * 1000,
    );
  });

  it('maps Jean-Claude Claude provider to CodexBar claude id', async () => {
    mockCodexBar(
      JSON.stringify({
        usage: {
          primary: {
            usedPercent: 10,
            windowMinutes: 300,
            resetsAt: '2026-07-04T19:15:00Z',
          },
        },
      }),
    );

    await new CodexBarUsageProvider('claude-code').getUsage();

    expect(execFile).toHaveBeenCalledWith(
      'codexbar',
      ['--provider', 'claude', '--format', 'json', '--json-only'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('falls back to common macOS install paths when PATH lookup fails', async () => {
    vi.mocked(execFile)
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1) as (
          error: NodeJS.ErrnoException,
          stdout: string,
          stderr: string,
        ) => void;
        const error = new Error('not found') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        callback(error, '', '');
        return {} as ReturnType<typeof execFile>;
      })
      .mockImplementationOnce((...args: unknown[]) => {
        const callback = args.at(-1) as (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        callback(
          null,
          JSON.stringify({
            usage: {
              primary: {
                usedPercent: 10,
                windowMinutes: 300,
                resetsAt: '2026-07-04T19:15:00Z',
              },
            },
          }),
          '',
        );
        return {} as ReturnType<typeof execFile>;
      });

    const result = await new CodexBarUsageProvider('codex').getUsage();

    expect(result.error).toBeNull();
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      'codexbar',
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      '/opt/homebrew/bin/codexbar',
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('shows install guidance when CodexBar CLI is missing everywhere', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: NodeJS.ErrnoException,
        stdout: string,
        stderr: string,
      ) => void;
      const error = new Error('spawn codexbar ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      callback(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await new CodexBarUsageProvider('codex').getUsage();

    expect(result.error?.message).toBe(
      'CodexBar CLI not found. Install CodexBar, then click Refresh in Usage Display settings.',
    );
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('shows an actionable provider-specific error when CodexBar exits without stderr', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error & { code: number },
        stdout: string,
        stderr: string,
      ) => void;
      const error = Object.assign(
        new Error(
          'Command failed: codexbar --provider copilot --format json --json-only',
        ),
        { code: 1 },
      );
      callback(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await new CodexBarUsageProvider('copilot').getUsage();

    expect(result.error?.message).toContain(
      'CodexBar could not fetch Copilot usage.',
    );
    expect(result.error?.message).toContain(
      'codexbar --provider copilot --format json --json-only',
    );
    expect(result.error?.message).not.toContain('Command failed:');
  });

  it('shows Copilot setup guidance when CodexBar has no fetch strategy', async () => {
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error,
        stdout: string,
        stderr: string,
      ) => void;
      callback(new Error('No available fetch strategy for copilot.'), '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await new CodexBarUsageProvider('copilot').getUsage();

    expect(result.error?.message).toContain(
      'CodexBar Copilot is not signed in.',
    );
    expect(result.error?.message).toContain(
      'codexbar config set-api-key --provider copilot --stdin',
    );
  });
});
