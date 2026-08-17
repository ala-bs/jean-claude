import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../../shared/media-limits';

const OLD_PROXY_LIMIT_BYTES = 20 * 1024 * 1024;

const { findById, getDecryptedToken } = vi.hoisted(() => ({
  findById: vi.fn(),
  getDecryptedToken: vi.fn(),
}));

vi.mock('../database/repositories', () => ({
  ProviderRepository: { findById },
  TokenRepository: { getDecryptedToken },
}));

vi.mock('./azure-devops-service', () => ({
  createAuthHeader: () => 'Basic token',
}));

import {
  fetchAuthenticatedImageStream,
  fetchImageAsBase64,
} from './azure-image-proxy-service';

function mockUpstreamResponse({
  chunks,
  contentLength,
  mimeType = 'image/png',
}: {
  chunks: Uint8Array[];
  contentLength?: number;
  mimeType?: string;
}) {
  const cancel = vi.fn().mockResolvedValue(undefined);
  const releaseLock = vi.fn();
  const read = vi.fn();
  for (const chunk of chunks) {
    read.mockResolvedValueOnce({ done: false, value: chunk });
  }
  read.mockResolvedValue({ done: true, value: undefined });
  const getReader = vi.fn(() => ({ read, cancel, releaseLock }));
  const bodyCancel = vi.fn().mockResolvedValue(undefined);
  const headers = new Headers({ 'content-type': mimeType });
  if (contentLength !== undefined) {
    headers.set('content-length', String(contentLength));
  }
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers,
    body: { getReader, cancel: bodyCancel },
  } as unknown as Response;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  return { bodyCancel, cancel, getReader, read, releaseLock };
}

function imageResponse(body: BodyInit = new Uint8Array([1])) {
  return new Response(body, { headers: { 'content-type': 'image/png' } });
}

function redirectResponse(location?: string) {
  return new Response(null, {
    status: 302,
    headers: location ? { location } : undefined,
  });
}

describe('Azure image URL security', () => {
  beforeEach(() => {
    findById.mockResolvedValue({ tokenId: 'token-1' });
    getDecryptedToken.mockResolvedValue('pat');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    'https://evilvisualstudio.com/image.png',
    'http://dev.azure.com/org/image.png',
    'https://dev.azure.com.evil.test/image.png',
    'https://user@dev.azure.com/org/image.png',
    'https://dev.azure.com:444/org/image.png',
  ])('rejects disallowed URL %s before fetching', async (imageUrl) => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(
      fetchImageAsBase64({ providerId: 'provider-1', imageUrl }),
    ).resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://dev.azure.com/org/image.png',
    'https://org.visualstudio.com/project/image.png',
    'https://media.org.visualstudio.com/image.png',
    'https://DEV.AZURE.COM/org/image.png',
  ])('allows Azure URL %s', async (imageUrl) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(imageResponse()));

    await expect(
      fetchImageAsBase64({ providerId: 'provider-1', imageUrl }),
    ).resolves.toEqual({ data: 'AQ==', mimeType: 'image/png' });
  });

  it('follows relative and allowlisted cross-host redirects with auth', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('/org/next.png'))
      .mockResolvedValueOnce(
        redirectResponse('https://org.visualstudio.com/final.png'),
      )
      .mockResolvedValueOnce(imageResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchImageAsBase64({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/start.png',
      }),
    ).resolves.toEqual({ data: 'AQ==', mimeType: 'image/png' });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://dev.azure.com/org/start.png',
      'https://dev.azure.com/org/next.png',
      'https://org.visualstudio.com/final.png',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        redirect: 'manual',
        headers: { Authorization: 'Basic token' },
      });
    }
  });

  it.each([
    'https://evilvisualstudio.com/stolen.png',
    'http://dev.azure.com/org/stolen.png',
  ])('rejects redirect to %s before sending auth', async (location) => {
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse(location));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchImageAsBase64({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/start.png',
      }),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: 'Basic token',
    });
  });

  it('rejects redirects without Location', async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirectResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchImageAsBase64({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/start.png',
      }),
    ).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows five redirects and rejects a sixth before fetching destination', async () => {
    const fetchMock = vi.fn();
    for (let index = 1; index <= 6; index += 1) {
      fetchMock.mockResolvedValueOnce(redirectResponse(`/org/${index}.png`));
    }
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchImageAsBase64({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/start.png',
      }),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('rejects redirect loops', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirectResponse('/org/two.png'))
      .mockResolvedValueOnce(redirectResponse('/org/start.png'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchAuthenticatedImageStream({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/start.png',
      }),
    ).resolves.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('fetchAuthenticatedImageStream', () => {
  beforeEach(() => {
    findById.mockResolvedValue({ tokenId: 'token-1' });
    getDecryptedToken.mockResolvedValue('pat');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('streams content declared above the old proxy limit', async () => {
    const upstream = mockUpstreamResponse({
      chunks: [new Uint8Array([1, 2, 3])],
      contentLength: OLD_PROXY_LIMIT_BYTES + 1,
    });

    const response = await fetchAuthenticatedImageStream({
      providerId: 'provider-1',
      imageUrl: 'https://dev.azure.com/org/image.png',
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body missing');
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(upstream.bodyCancel).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it('streams cumulative bytes beyond the old proxy limit', async () => {
    const half = new Uint8Array(OLD_PROXY_LIMIT_BYTES / 2);
    const upstream = mockUpstreamResponse({
      chunks: [half, half, new Uint8Array(1)],
    });
    const response = await fetchAuthenticatedImageStream({
      providerId: 'provider-1',
      imageUrl: 'https://dev.azure.com/org/image.png',
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Bounded response body missing');

    expect((await reader.read()).value?.byteLength).toBe(half.byteLength);
    expect((await reader.read()).value?.byteLength).toBe(half.byteLength);
    expect((await reader.read()).value?.byteLength).toBe(1);
    expect(await reader.read()).toEqual({ done: true, value: undefined });

    expect(upstream.cancel).not.toHaveBeenCalled();
    expect(upstream.releaseLock).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });

  it('preserves image headers', async () => {
    const boundary = new Uint8Array(3);
    const upstream = mockUpstreamResponse({
      chunks: [boundary],
      contentLength: boundary.byteLength,
      mimeType: 'image/gif',
    });
    const protocolController = new AbortController();
    const removeAbortListener = vi.spyOn(
      protocolController.signal,
      'removeEventListener',
    );
    const response = await fetchAuthenticatedImageStream({
      providerId: 'provider-1',
      imageUrl: 'https://dev.azure.com/org/image.gif',
      signal: protocolController.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Bounded response body missing');

    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(response.headers.get('content-length')).toBe(
      String(boundary.byteLength),
    );
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=3600',
    );
    expect((await reader.read()).value?.byteLength).toBe(
      boundary.byteLength,
    );
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(upstream.cancel).not.toHaveBeenCalled();
    expect(upstream.releaseLock).toHaveBeenCalledOnce();
    expect(removeAbortListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
  });

  it('cancels upstream and aborts fetch when downstream cancels', async () => {
    const upstream = mockUpstreamResponse({ chunks: [new Uint8Array(1)] });
    const response = await fetchAuthenticatedImageStream({
      providerId: 'provider-1',
      imageUrl: 'https://dev.azure.com/org/image.png',
    });

    await response.body?.cancel('consumer closed');

    expect(upstream.cancel).toHaveBeenCalledWith('consumer closed');
    expect(upstream.releaseLock).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('aborts a pending header fetch when the protocol request is cancelled', async () => {
    let rejectFetch: ((error: unknown) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectFetch = reject;
          }),
      ),
    );
    const protocolController = new AbortController();
    const removeAbortListener = vi.spyOn(
      protocolController.signal,
      'removeEventListener',
    );
    const responsePromise = fetchAuthenticatedImageStream({
      providerId: 'provider-1',
      imageUrl: 'https://dev.azure.com/org/image.png',
      signal: protocolController.signal,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const fetchSignal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;

    protocolController.abort(new DOMException('Protocol cancelled', 'AbortError'));
    const abortedBeforeHeaders = fetchSignal?.aborted;
    rejectFetch?.(fetchSignal?.reason);
    const response = await responsePromise;

    expect(abortedBeforeHeaders).toBe(true);
    expect(response.status).toBe(502);
    expect(removeAbortListener).toHaveBeenCalledWith(
      'abort',
      expect.any(Function),
    );
  });
});

describe('fetchImageAsBase64', () => {
  beforeEach(() => {
    findById.mockResolvedValue({ tokenId: 'token-1' });
    getDecryptedToken.mockResolvedValue('pat');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns image bytes as base64', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/gif', 'content-length': '3' },
        }),
      ),
    );

    await expect(
      fetchImageAsBase64({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/image.gif',
      }),
    ).resolves.toEqual({ data: 'AQID', mimeType: 'image/gif' });
  });

  it('rejects base64 content above the attachment memory limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            'content-type': 'image/gif',
            'content-length': String(MAX_IMAGE_ATTACHMENT_BYTES + 1),
          },
        }),
      ),
    );

    await expect(
      fetchImageAsBase64({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/image.gif',
      }),
    ).resolves.toBeNull();

    const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it('aborts chunked base64 content above the attachment memory limit', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES / 2);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 2) {
          controller.enqueue(chunk);
        } else {
          controller.enqueue(new Uint8Array(1));
          controller.close();
        }
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, { headers: { 'content-type': 'image/png' } }),
      ),
    );

    await expect(
      fetchImageAsBase64({
        providerId: 'provider-1',
        imageUrl: 'https://dev.azure.com/org/image.png',
      }),
    ).resolves.toBeNull();

    const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });
});
