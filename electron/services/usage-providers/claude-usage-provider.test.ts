import { mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: execMock,
}));

import { ClaudeUsageProvider } from './claude-usage-provider';

let credentialsPath: string;
let homeDirectory: string;

function mockKeychainMiss(): void {
  execMock.mockImplementation((_command, _options, callback) => {
    callback(new Error('not found'));
  });
}

async function writeClaudeCredentials(token: string): Promise<void> {
  await mkdir(path.dirname(credentialsPath), { recursive: true });
  await writeFile(
    credentialsPath,
    JSON.stringify({ claudeAiOauth: { accessToken: token } }),
  );
}

describe('ClaudeUsageProvider', () => {
  beforeEach(async (context) => {
    homeDirectory = path.join('/tmp', `jc-claude-test-${context.task.id}`);
    await mkdir(homeDirectory, { recursive: true });
    credentialsPath = path.join(homeDirectory, '.claude', '.credentials.json');
    vi.restoreAllMocks();
    mockKeychainMiss();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    await rm(homeDirectory, {
      recursive: true,
      force: true,
    });
  });

  it('uses Claude credentials file when Keychain token is unavailable', async () => {
    await writeClaudeCredentials('file-token');
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 12, resets_at: '2026-06-09T12:00:00Z' },
        }),
        { status: 200 },
      ),
    );

    const provider = new ClaudeUsageProvider({ credentialsPath });
    const result = await provider.getUsage();

    expect(result.error).toBeNull();
    expect(result.data?.limits[0]?.key).toBe('five_hour');
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer file-token',
      'User-Agent': 'claude-code/2.1.0',
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });

  it('caches Claude usage API rate-limit responses', async () => {
    await writeClaudeCredentials('file-token');
    vi.mocked(fetch).mockResolvedValue(
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': '60' },
      }),
    );

    const provider = new ClaudeUsageProvider({ credentialsPath });
    const first = await provider.getUsage();
    const second = await provider.getUsage();

    expect(first.error).toMatchObject({ statusCode: 429 });
    expect(second.error).toMatchObject({ statusCode: 429 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
