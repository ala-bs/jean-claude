// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { useImagePreviewUrls } from './use-image-preview-urls';

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function base64(value: string): string {
  return btoa(value);
}

function image(overrides: Partial<PromptImagePart> = {}): PromptImagePart {
  return {
    type: 'image',
    data: base64('original'),
    mimeType: 'image/png',
    ...overrides,
  };
}

describe('useImagePreviewUrls', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestUrls: (string | undefined)[] = [];
  let nextUrl = 0;
  const createObjectUrl = vi.fn(
    (_blob: Blob) => `blob:preview-${++nextUrl}`,
  );
  const revokeObjectUrl = vi.fn();

  function Harness({ images }: { images: PromptImagePart[]; tick?: number }) {
    latestUrls = useImagePreviewUrls(images);
    return null;
  }

  async function render(images: PromptImagePart[], tick = 0) {
    await act(async () => {
      root.render(createElement(Harness, { images, tick }));
    });
  }

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latestUrls = [];
    nextUrl = 0;
    createObjectUrl.mockClear();
    revokeObjectUrl.mockClear();
    vi.stubGlobal('URL', {
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates typed Blobs from preferred storage and fallback source payloads', async () => {
    await render([
      image({
        storageData: base64('storage'),
        storageMimeType: 'image/avif',
      }),
      image({ data: base64('source'), mimeType: 'image/jpeg' }),
    ]);

    const storageBlob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    const sourceBlob = createObjectUrl.mock.calls[1]?.[0] as Blob;
    expect(await storageBlob.text()).toBe('storage');
    expect(storageBlob.type).toBe('image/avif');
    expect(await sourceBlob.text()).toBe('source');
    expect(sourceBlob.type).toBe('image/jpeg');
    expect(latestUrls).toEqual(['blob:preview-1', 'blob:preview-2']);
  });

  it('tags GIF preview URLs while retaining the raw URL for revocation', async () => {
    await render([image({ mimeType: 'image/gif' })]);

    expect(latestUrls).toEqual([
      'blob:preview-1#jc-mime=image%2Fgif',
    ]);

    await act(async () => root.unmount());
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview-1');
    root = createRoot(container);
  });

  it('stays pending and yields while decoding a multi-chunk payload', async () => {
    vi.useFakeTimers();
    const largePayload = base64('x'.repeat(100_000));

    await render([image({ data: largePayload })]);

    expect(latestUrls).toEqual([undefined]);
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const blob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(blob.size).toBe(100_000);
    expect(latestUrls).toEqual(['blob:preview-1']);
  });

  it('keeps pending results stable across unrelated rerenders', async () => {
    vi.useFakeTimers();
    const images = [image({ data: base64('x'.repeat(100_000)) })];

    await render(images);
    const firstResult = latestUrls;
    await render(images, 1);

    expect(latestUrls).toBe(firstResult);

    await act(async () => {
      await vi.runAllTimersAsync();
    });
  });

  it('cancels stale multi-chunk conversion before creating its URL', async () => {
    vi.useFakeTimers();
    const staleImages = [image({ data: base64('x'.repeat(100_000)) })];
    const currentImages = [image({ data: base64('current') })];

    await render(staleImages);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await render(currentImages);

    expect(latestUrls).toEqual(['blob:preview-1']);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(latestUrls).toEqual(['blob:preview-1']);
  });

  it('clears a pending decoder yield when unmounted', async () => {
    vi.useFakeTimers();
    const images = [
      image({ data: base64('x'.repeat(100_000)) }),
      image({ data: base64('y'.repeat(100_000)) }),
    ];

    await render(images);
    expect(vi.getTimerCount()).toBe(2);

    await act(async () => root.unmount());

    expect(vi.getTimerCount()).toBe(0);
    expect(createObjectUrl).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it('revokes generated URLs when images change and on unmount', async () => {
    await render([image()]);
    await render([image({ data: base64('replacement') })]);

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview-1');
    expect(latestUrls).toEqual(['blob:preview-2']);

    await act(async () => root.unmount());

    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:preview-2');
    root = createRoot(container);
  });

  it('returns undefined for invalid base64 without an unhandled rejection', async () => {
    await render([image({ data: 'not valid base64 %%%' })]);

    expect(latestUrls).toEqual([undefined]);
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it('accepts a decoded preview exactly at the attachment limit', async () => {
    vi.useFakeTimers();
    const encoded = `${'A'.repeat(Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 - 2)}==`;

    await render([image({ data: encoded })]);
    await act(async () => vi.runAllTimersAsync());

    const blob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(blob.size).toBe(MAX_PREVIEW_BYTES);
  });

  it('accepts a GIF preview above the image attachment limit', async () => {
    vi.useFakeTimers();
    const atobSpy = vi.spyOn(globalThis, 'atob');
    const encoded = 'A'.repeat(Math.ceil((MAX_PREVIEW_BYTES + 1) / 3) * 4);

    await render([
      image({ data: encoded, mimeType: 'Image/GIF; charset=binary' }),
    ]);
    await act(async () => vi.runAllTimersAsync());

    expect(latestUrls).toEqual(['blob:preview-1#jc-mime=image%2Fgif']);
    expect(atobSpy).toHaveBeenCalled();
    const blob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(blob.size).toBeGreaterThan(MAX_PREVIEW_BYTES);
  });

  it.each(['AAAA=', 'AA=A', 'A==='])(
    'rejects malformed base64 padding in %s',
    async (data) => {
      const atobSpy = vi.spyOn(globalThis, 'atob');

      await render([image({ data })]);

      expect(latestUrls).toEqual([undefined]);
      expect(atobSpy).not.toHaveBeenCalled();
    },
  );

  it('creates previews when fetch is unavailable under renderer CSP', async () => {
    vi.stubGlobal('fetch', undefined);

    await render([image({ data: base64('works without fetch') })]);

    const blob = createObjectUrl.mock.calls[0]?.[0] as Blob;
    expect(await blob.text()).toBe('works without fetch');
    expect(latestUrls).toEqual(['blob:preview-1']);
  });
});
