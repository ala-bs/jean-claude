import { describe, expect, it, vi } from 'vitest';

import { CopilotUsageProvider } from './copilot-usage-provider';

describe('CopilotUsageProvider', () => {
  it('maps premium and chat quota snapshots', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          quota_snapshots: {
            premium_interactions: { percent_remaining: 30 },
            chat: { percent_remaining: 75 },
          },
          quota_reset_date: '2026-07-01T00:00:00Z',
        }),
        { status: 200 },
      ),
    );

    const result = await new CopilotUsageProvider({
      getToken: () => 'copilot-token',
      fetchImpl,
      now: () => new Date('2026-06-09T00:00:00Z'),
    }).getUsage();

    expect(result.error).toBeNull();
    expect(result.data?.limits.map((limit) => limit.key)).toEqual([
      'premium',
      'chat',
    ]);
    expect(result.data?.limits[0]?.range.utilization).toBe(70);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('token copilot-token');
    expect(init.headers['User-Agent']).toBe('GitHubCopilotChat/0.26.7');
  });

  it('uses monthly quota fallback when quota snapshots are absent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          monthly_quotas: { completions: 100, chat: 200 },
          limited_user_quotas: { completions: 25, chat: 150 },
        }),
        { status: 200 },
      ),
    );

    const result = await new CopilotUsageProvider({
      getToken: () => 'copilot-token',
      fetchImpl,
      now: () => new Date('2026-06-09T00:00:00Z'),
    }).getUsage();

    expect(result.error).toBeNull();
    expect(result.data?.limits[0]?.range.utilization).toBe(75);
    expect(result.data?.limits[1]?.range.utilization).toBe(25);
  });

  it('returns no_token when token is missing', async () => {
    const result = await new CopilotUsageProvider().getUsage();

    expect(result.data).toBeNull();
    expect(result.error?.type).toBe('no_token');
  });

  it('returns visible errors when stored token cannot be read', async () => {
    const result = await new CopilotUsageProvider({
      getToken: () => {
        throw new Error('Token decrypt failed');
      },
    }).getUsage();

    expect(result.data).toBeNull();
    expect(result.error?.type).toBe('api_error');
    expect(result.error?.message).toBe('Token decrypt failed');
  });
});
