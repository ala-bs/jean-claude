import { describe, expect, it, vi } from 'vitest';

import { CopilotDeviceFlowService } from './copilot-device-flow-service';

describe('CopilotDeviceFlowService', () => {
  it('requests and maps GitHub device code', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          verification_uri_complete:
            'https://github.com/login/device?user_code=ABCD-1234',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200 },
      ),
    );

    const result = await new CopilotDeviceFlowService({
      fetchImpl,
    }).requestDeviceCode();

    expect(result).toEqual({
      deviceCode: 'device-code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      verificationUriComplete:
        'https://github.com/login/device?user_code=ABCD-1234',
      expiresIn: 900,
      interval: 5,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.body.get('client_id')).toBe('Ov23liD2Rcz6mV6cr83G');
    expect(init.body.get('scope')).toBe('read:user');
  });

  it('polls until GitHub returns access token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'authorization_pending' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'github-token' }), {
          status: 200,
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 0;

    const result = await new CopilotDeviceFlowService({
      fetchImpl,
      sleep,
      now: () => now++,
    }).pollForToken({
      deviceCode: 'device-code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });

    expect(result).toBe('github-token');
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('backs off when GitHub returns slow_down', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'slow_down' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'github-token' }), {
          status: 200,
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    let now = 0;

    await new CopilotDeviceFlowService({
      fetchImpl,
      sleep,
      now: () => now++,
    }).pollForToken({
      deviceCode: 'device-code',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });

    expect(sleep).toHaveBeenNthCalledWith(1, 5000);
    expect(sleep).toHaveBeenNthCalledWith(2, 10000);
  });

  it('throws useful errors for failed login', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'access_denied',
          error_description: 'User denied request',
        }),
        { status: 200 },
      ),
    );

    await expect(
      new CopilotDeviceFlowService({
        fetchImpl,
        sleep: vi.fn().mockResolvedValue(undefined),
      }).pollForToken({
        deviceCode: 'device-code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      }),
    ).rejects.toThrow('User denied request');
  });
});
