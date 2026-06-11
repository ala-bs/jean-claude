const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
// Public OAuth client ID for Jean-Claude's GitHub device login app. This is not
// secret; never ship a client secret in desktop app code.
const JEAN_CLAUDE_CLIENT_ID = 'Ov23liD2Rcz6mV6cr83G';

export interface CopilotDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface CopilotDeviceFlowOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export class CopilotDeviceFlowService {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: CopilotDeviceFlowOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  async requestDeviceCode(): Promise<CopilotDeviceCode> {
    const response = await this.fetchImpl(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: JEAN_CLAUDE_CLIENT_ID,
        scope: 'read:user',
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub device code request failed: ${response.status}`);
    }

    const body = (await response.json()) as DeviceCodeResponse;
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      verificationUriComplete: body.verification_uri_complete,
      expiresIn: body.expires_in,
      interval: body.interval ?? 5,
    };
  }

  async pollForToken(deviceCode: CopilotDeviceCode): Promise<string> {
    const expiresAt = this.now() + deviceCode.expiresIn * 1000;
    let intervalMs = deviceCode.interval * 1000;

    while (this.now() < expiresAt) {
      await this.sleep(intervalMs);
      const response = await this.fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: JEAN_CLAUDE_CLIENT_ID,
          device_code: deviceCode.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      if (!response.ok) {
        throw new Error(`GitHub token polling failed: ${response.status}`);
      }

      const body = (await response.json()) as AccessTokenResponse;
      if (body.access_token) return body.access_token;
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') {
        intervalMs += 5000;
        continue;
      }
      if (body.error === 'expired_token') break;
      throw new Error(
        body.error_description ?? body.error ?? 'GitHub login failed',
      );
    }

    throw new Error('GitHub device login expired. Try again.');
  }
}
