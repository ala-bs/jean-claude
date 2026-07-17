/**
 * Azure Image Proxy Service
 *
 * Fetches images from Azure DevOps with PAT authentication.
 * Used by the azure-image-proxy:// protocol handler to proxy
 * authenticated requests for images in work item descriptions.
 */

import { ProviderRepository, TokenRepository } from '../database/repositories';
import { dbg } from '../lib/debug';
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../../shared/media-limits';

import { createAuthHeader } from './azure-devops-service';

const MAX_AUTHENTICATED_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseAllowedAzureImageUrl(imageUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    return null;
  }

  const isAllowedHost =
    url.hostname === 'dev.azure.com' ||
    url.hostname.endsWith('.visualstudio.com');
  if (
    url.protocol !== 'https:' ||
    !isAllowedHost ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) {
    return null;
  }

  return url;
}

async function fetchWithValidatedRedirects(params: {
  imageUrl: string;
  authorization: string;
  signal?: AbortSignal;
}): Promise<Response> {
  let url = parseAllowedAzureImageUrl(params.imageUrl);
  if (!url) throw new Error('Disallowed Azure DevOps image URL');

  const visited = new Set<string>();
  for (let redirectCount = 0; ; redirectCount += 1) {
    const normalizedUrl = url.href;
    if (visited.has(normalizedUrl)) {
      throw new Error('Azure DevOps image redirect loop');
    }
    visited.add(normalizedUrl);

    const response = await fetch(normalizedUrl, {
      signal: params.signal,
      redirect: 'manual',
      headers: { Authorization: params.authorization },
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    if (redirectCount >= MAX_AUTHENTICATED_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Too many Azure DevOps image redirects');
    }

    const location = response.headers.get('location');
    if (!location) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Azure DevOps image redirect missing Location');
    }

    let destination: URL;
    try {
      destination = new URL(location, url);
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Invalid Azure DevOps image redirect');
    }
    const allowedDestination = parseAllowedAzureImageUrl(destination.href);
    if (!allowedDestination) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Disallowed Azure DevOps image redirect');
    }

    await response.body?.cancel().catch(() => undefined);
    url = allowedDestination;
  }
}

/**
 * Validates URL and resolves provider credentials for an Azure DevOps image fetch.
 * Returns the authenticated Response on success, or an error string on failure.
 */
async function fetchAuthenticated(params: {
  providerId: string;
  imageUrl: string;
  signal?: AbortSignal;
}): Promise<
  { response: Response; mimeType: string } | { error: string; status: number }
> {
  const { providerId, imageUrl, signal } = params;

  if (!parseAllowedAzureImageUrl(imageUrl)) {
    dbg.azureImageProxy('Invalid URL: %s', imageUrl);
    return { error: 'Only Azure DevOps URLs are allowed', status: 403 };
  }

  // Get provider and token
  const provider = await ProviderRepository.findById(providerId);
  if (!provider?.tokenId) {
    dbg.azureImageProxy('Provider or token not found: %s', providerId);
    return { error: 'Provider or token not found', status: 401 };
  }

  const token = await TokenRepository.getDecryptedToken(provider.tokenId);
  if (!token) {
    dbg.azureImageProxy('Token not found for provider: %s', providerId);
    return { error: 'Token not found', status: 401 };
  }

  try {
    const response = await fetchWithValidatedRedirects({
      imageUrl,
      authorization: createAuthHeader(token),
      signal,
    });

    if (!response.ok) {
      dbg.azureImageProxy(
        'Failed to fetch image: %d %s',
        response.status,
        response.statusText,
      );
      return {
        error: 'Failed to fetch image from Azure DevOps',
        status: response.status,
      };
    }

    const mimeType =
      response.headers.get('content-type') || 'application/octet-stream';

    return { response, mimeType };
  } catch (error) {
    dbg.azureImageProxy('Error fetching image: %O', error);
    return { error: 'Error fetching image', status: 502 };
  }
}

/**
 * Fetches an image from Azure DevOps with PAT authentication and returns
 * a streaming Response. This streams the image data directly without
 * buffering the entire image in memory.
 */
export async function fetchAuthenticatedImageStream(params: {
  providerId: string;
  imageUrl: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const fetchController = new AbortController();
  let abortBoundedStream: ((reason: unknown) => Promise<void>) | undefined;
  const removeExternalAbortListener = () =>
    params.signal?.removeEventListener('abort', handleExternalAbort);
  const handleExternalAbort = () => {
    const reason =
      params.signal?.reason ??
      new DOMException('Protocol request cancelled', 'AbortError');
    if (abortBoundedStream) {
      void abortBoundedStream(reason);
    } else if (!fetchController.signal.aborted) {
      fetchController.abort(reason);
    }
  };

  if (params.signal?.aborted) {
    handleExternalAbort();
  } else {
    params.signal?.addEventListener('abort', handleExternalAbort, { once: true });
  }

  let result: Awaited<ReturnType<typeof fetchAuthenticated>>;
  try {
    result = await fetchAuthenticated({
      providerId: params.providerId,
      imageUrl: params.imageUrl,
      signal: fetchController.signal,
    });
  } catch (error) {
    removeExternalAbortListener();
    throw error;
  }

  if ('error' in result) {
    removeExternalAbortListener();
    return new Response(result.error, { status: result.status });
  }

  const { response, mimeType } = result;
  const contentLength = response.headers.get('content-length');

  const headers: Record<string, string> = {
    'Content-Type': mimeType,
    'Cache-Control': 'private, max-age=3600',
  };

  if (contentLength) {
    headers['Content-Length'] = contentLength;
  }

  if (!response.body) {
    removeExternalAbortListener();
    return new Response(null, { headers });
  }

  const reader = response.body.getReader();
  let stopped = false;
  let released = false;

  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
    removeExternalAbortListener();
  };

  const cancelUpstream = async (reason: unknown) => {
    if (stopped) return;
    stopped = true;
    if (!fetchController.signal.aborted) fetchController.abort(reason);
    try {
      await reader.cancel(reason);
    } catch {
      // Fetch abort may reject the pending read before cancellation completes.
    } finally {
      releaseReader();
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abortBoundedStream = async (reason) => {
        if (stopped) return;
        await cancelUpstream(reason);
        controller.error(reason);
      };
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          stopped = true;
          releaseReader();
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        if (stopped) return;
        await cancelUpstream(error);
        controller.error(error);
      }
    },
    cancel: cancelUpstream,
  });

  try {
    return new Response(body, { headers });
  } catch (error) {
    await cancelUpstream(error);
    throw error;
  }
}

/**
 * Fetches an image from Azure DevOps with PAT authentication and returns
 * it as a base64-encoded string with its MIME type.
 */
export async function fetchImageAsBase64(params: {
  providerId: string;
  imageUrl: string;
}): Promise<{ data: string; mimeType: string } | null> {
  const controller = new AbortController();
  const result = await fetchAuthenticated({ ...params, signal: controller.signal });

  if ('error' in result) {
    return null;
  }

  const { response, mimeType } = result;
  try {
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_IMAGE_ATTACHMENT_BYTES
    ) {
      controller.abort(new Error('Image exceeds attachment memory limit'));
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
          controller.abort(new Error('Image exceeds attachment memory limit'));
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const image = Buffer.allocUnsafe(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(
        image,
        offset,
      );
      offset += chunk.byteLength;
    }

    return { data: image.toString('base64'), mimeType };
  } catch (error) {
    dbg.azureImageProxy('Error buffering proxied image: %O', error);
    controller.abort(error);
    return null;
  }
}

/**
 * Encodes an image URL for use with the azure-image-proxy protocol.
 */
export function encodeProxyUrl(providerId: string, imageUrl: string): string {
  const encodedUrl = Buffer.from(imageUrl).toString('base64url');
  return `azure-image-proxy://${providerId}/${encodedUrl}`;
}

/**
 * Decodes a proxy URL back to providerId and original image URL.
 */
export function decodeProxyUrl(
  proxyUrl: string,
): { providerId: string; imageUrl: string } | null {
  try {
    const url = new URL(proxyUrl);
    if (url.protocol !== 'azure-image-proxy:') {
      return null;
    }

    const providerId = url.hostname;
    // pathname starts with /, so we slice it off
    const encodedUrl = url.pathname.slice(1);
    const imageUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');

    return { providerId, imageUrl };
  } catch {
    return null;
  }
}
