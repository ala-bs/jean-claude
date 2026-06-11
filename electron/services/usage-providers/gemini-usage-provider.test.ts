import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeminiUsageProvider } from './gemini-usage-provider';

let homeDirectory: string;

async function writeGeminiFile(name: string, data: unknown): Promise<void> {
  const dir = path.join(homeDirectory, '.gemini');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), JSON.stringify(data));
}

describe('GeminiUsageProvider', () => {
  beforeEach(async (context) => {
    homeDirectory = path.join('/tmp', `jc-gemini-test-${context.task.id}`);
    await mkdir(homeDirectory, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await rm(homeDirectory, { recursive: true, force: true });
  });

  it('maps Gemini quota buckets into Pro, Flash, and Flash Lite limits', async () => {
    await writeGeminiFile('settings.json', {
      security: { auth: { selectedType: 'oauth-personal' } },
    });
    await writeGeminiFile('oauth_creds.json', {
      access_token: 'gemini-token',
      expiry_date: new Date('2026-06-10T00:00:00Z').getTime(),
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          buckets: [
            {
              modelId: 'gemini-2.5-pro',
              remainingFraction: 0.25,
              resetTime: '2026-06-09T12:00:00Z',
            },
            {
              modelId: 'gemini-2.5-flash',
              remainingFraction: 0.8,
              resetTime: '2026-06-09T13:00:00Z',
            },
            {
              modelId: 'gemini-2.5-flash-lite',
              remainingFraction: 0.4,
              resetTime: '2026-06-09T14:00:00Z',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await new GeminiUsageProvider({
      homeDirectory,
      fetchImpl,
      now: () => new Date('2026-06-09T00:00:00Z'),
    }).getUsage();

    expect(result.error).toBeNull();
    expect(result.data?.limits.map((limit) => limit.key)).toEqual([
      'pro',
      'flash',
      'flash-lite',
    ]);
    expect(result.data?.limits[0]?.range.utilization).toBe(75);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer gemini-token');
  });

  it('rejects Gemini API key auth mode', async () => {
    await writeGeminiFile('settings.json', {
      security: { auth: { selectedType: 'api-key' } },
    });

    const result = await new GeminiUsageProvider({ homeDirectory }).getUsage();

    expect(result.data).toBeNull();
    expect(result.error?.message).toContain('api-key auth is not supported');
  });

  it('returns no_token when Gemini CLI credentials are missing', async () => {
    const result = await new GeminiUsageProvider({ homeDirectory }).getUsage();

    expect(result.data).toBeNull();
    expect(result.error?.type).toBe('no_token');
    expect(result.error?.message).toContain('Gemini CLI OAuth credentials');
  });
});
