import { afterEach, describe, expect, it, vi } from 'vitest';

import { decompressFrame, parseGIF } from 'gifuct-js';

import {
  calculateGifFrameMemoryBytes,
  composeGifFrameRgba,
  decodeGifFrames,
  getGifBackgroundColor,
  validateGifFrameDescriptor,
  validateGifFrameMemory,
} from './gif-decoder-core';
import {
  createGifFrameCache,
  decodeGifFrameImages,
  loadGifArrayBuffer,
  readGifResponse,
} from './gif-frame-decoder';
import {
  MAX_GIF_ESTIMATED_PEAK_MEMORY_BYTES,
  MAX_GIF_RETAINED_FRAME_MEMORY_BYTES,
  MAX_GIF_SOURCE_MEMORY_BYTES,
} from './gif-decoder-limits';

const OLD_GIF_SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;

function gifSkeleton({
  width,
  height,
  frames,
}: {
  width: number;
  height: number;
  frames: Array<{ left?: number; top?: number; width: number; height: number }>;
}): ArrayBuffer {
  const bytes = [
    ...Array.from('GIF89a', (character) => character.charCodeAt(0)),
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0,
  ];
  for (const frame of frames) {
    const left = frame.left ?? 0;
    const top = frame.top ?? 0;
    bytes.push(
      0x2c,
      left & 0xff,
      left >> 8,
      top & 0xff,
      top >> 8,
      frame.width & 0xff,
      frame.width >> 8,
      frame.height & 0xff,
      frame.height >> 8,
      0,
      2,
      1,
      0,
      0,
    );
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes).buffer;
}

vi.mock('gifuct-js', () => ({
  decompressFrame: vi.fn(),
  parseGIF: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('GIF decoded-frame memory budget', () => {
  it('allows a typical converted GIF with composition headroom', () => {
    const params = {
      width: 244,
      height: 471,
      frameCount: 144,
      maxFramePatchPixels: 244 * 471,
      sourceBytes: 5 * 1024 * 1024,
      blockRecordCount: 20_000,
    };
    const memory = validateGifFrameMemory(params);

    expect(memory).toEqual(calculateGifFrameMemoryBytes(params));
    expect(memory.retainedBytes).toBeLessThan(
      MAX_GIF_RETAINED_FRAME_MEMORY_BYTES,
    );
    expect(memory.estimatedPeakBytes).toBeLessThan(
      MAX_GIF_ESTIMATED_PEAK_MEMORY_BYTES,
    );
  });

  it('rejects dangerous retained full-frame totals', () => {
    expect(() =>
      validateGifFrameMemory({
        width: 2_000,
        height: 2_000,
        frameCount: 10,
        maxFramePatchPixels: 1,
      }),
    ).toThrow('GIF retained frames exceed safe memory budget');
  });

  it('rejects dangerous transient peak estimates', () => {
    expect(() =>
      validateGifFrameMemory({
        width: 3_000,
        height: 3_000,
        frameCount: 1,
        maxFramePatchPixels: 4_000_000,
      }),
    ).toThrow('GIF estimated peak memory exceeds safe budget');
  });

  it('rejects near-cap compressed source combined with retained frames', () => {
    expect(() =>
      validateGifFrameMemory({
        width: 244,
        height: 471,
        frameCount: 144,
        maxFramePatchPixels: 244 * 471,
        sourceBytes: OLD_GIF_SOURCE_LIMIT_BYTES - 1,
        blockRecordCount: 82_000,
      }),
    ).toThrow('GIF estimated peak memory exceeds safe budget');
  });

  it('accounts for tiny-record parser metadata in peak memory', () => {
    const withoutRecords = calculateGifFrameMemoryBytes({
      width: 1,
      height: 1,
      frameCount: 1,
      maxFramePatchPixels: 1,
      sourceBytes: 200_000,
    });
    const withRecords = calculateGifFrameMemoryBytes({
      width: 1,
      height: 1,
      frameCount: 1,
      maxFramePatchPixels: 1,
      sourceBytes: 200_000,
      blockRecordCount: 90_000,
    });
    expect(withRecords.estimatedPeakBytes).toBeGreaterThan(
      withoutRecords.estimatedPeakBytes + 20 * 1024 * 1024,
    );
  });

  it('rejects the cited 2M-canvas and 4M-patch peak', () => {
    expect(() =>
      validateGifFrameMemory({
        width: 2_000,
        height: 1_000,
        frameCount: 1,
        maxFramePatchPixels: 4_000_000,
      }),
    ).toThrow('GIF estimated peak memory exceeds safe budget');
  });

  it('accepts a large in-bounds case below the peak limit', () => {
    const memory = validateGifFrameMemory({
      width: 2_000,
      height: 1_500,
      frameCount: 1,
      maxFramePatchPixels: 3_000_000,
    });

    expect(memory.estimatedPeakBytes).toBeLessThan(
      MAX_GIF_ESTIMATED_PEAK_MEMORY_BYTES,
    );
  });

  it('rejects oversized memory before frame decompression', () => {
    vi.mocked(parseGIF).mockReturnValue({
      gct: [],
      lsd: { width: 2_000, height: 2_000 },
      frames: Array.from({ length: 10 }, () => ({
        gce: {},
        image: { descriptor: { left: 0, top: 0, width: 1, height: 1 } },
      })),
    } as never);
    const source = gifSkeleton({
      width: 2_000,
      height: 2_000,
      frames: Array.from({ length: 10 }, () => ({ width: 1, height: 1 })),
    });
    expect(() => decodeGifFrames(source)).toThrow(
      'GIF retained frames exceed safe memory budget',
    );
    expect(parseGIF).not.toHaveBeenCalled();
    expect(decompressFrame).not.toHaveBeenCalled();
  });
});

describe('GIF frame descriptor validation', () => {
  it.each([
    { left: -1, top: 0, width: 1, height: 1 },
    { left: 0, top: -1, width: 1, height: 1 },
    { left: 0, top: 0, width: 0, height: 1 },
    { left: 0, top: 0, width: 1, height: 0 },
    { left: 3, top: 0, width: 2, height: 1 },
    { left: 0, top: 3, width: 1, height: 2 },
  ])('rejects malformed descriptor $left,$top $width x $height', (dims) => {
    expect(() =>
      validateGifFrameDescriptor({
        ...dims,
        logicalWidth: 4,
        logicalHeight: 4,
      }),
    ).toThrow('GIF frame lies outside logical screen');
  });

  it('rejects a 4M patch outside a 2M logical screen before decompression', () => {
    vi.mocked(parseGIF).mockReturnValue({
      gct: [],
      lsd: { width: 2_000, height: 1_000 },
      frames: [
        {
          image: {
            descriptor: { left: 0, top: 0, width: 2_000, height: 2_000 },
          },
        },
      ],
    } as never);
    const source = gifSkeleton({
      width: 2_000,
      height: 1_000,
      frames: [{ width: 2_000, height: 2_000 }],
    });
    expect(() => decodeGifFrames(source)).toThrow(
      'GIF frame lies outside logical screen',
    );
    expect(parseGIF).not.toHaveBeenCalled();
    expect(decompressFrame).not.toHaveBeenCalled();
  });
});

describe('GIF loading cancellation', () => {
  it('passes the abort signal to native fetch', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array(1)));
    vi.stubGlobal('fetch', fetchMock);

    await loadGifArrayBuffer('https://example.com/image.gif', controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/image.gif',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not parse data returned after cancellation', async () => {
    let resolveFetch: ((response: unknown) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const WorkerMock = vi.fn();
    vi.stubGlobal('Worker', WorkerMock);
    const decoded = decodeGifFrameImages(
      'https://example.com/late.gif',
      controller.signal,
    );

    controller.abort();
    resolveFetch?.({
      ok: true,
      headers: new Headers(),
      body: new Response(new Uint8Array(1)).body,
    });

    await expect(decoded).rejects.toThrow();
    expect(parseGIF).not.toHaveBeenCalled();
    expect(decompressFrame).not.toHaveBeenCalled();
    expect(WorkerMock).not.toHaveBeenCalled();
  });

  it('rejects an Azure proxy stream that arrives after cancellation', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const imageUrl = btoa('https://example.com/image.gif')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const controller = new AbortController();
    const loaded = loadGifArrayBuffer(
      `azure-image-proxy://provider/${imageUrl}`,
      controller.signal,
    );

    controller.abort();
    resolveFetch?.(new Response(new Uint8Array([1, 2, 3])));

    await expect(loaded).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('azure-image-proxy://'),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('reads sources declared above the old fixed limit', async () => {
    const controller = new AbortController();
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        'content-length': String(OLD_GIF_SOURCE_LIMIT_BYTES + 1),
      },
    });

    await expect(readGifResponse(response, controller)).resolves.toEqual(
      new Uint8Array([1, 2, 3]).buffer,
    );
    expect(controller.signal.aborted).toBe(false);
  });

  it('reads local/blob streams beyond the old fixed limit', async () => {
    const chunk = new Uint8Array(OLD_GIF_SOURCE_LIMIT_BYTES / 2);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: chunk })
      .mockResolvedValueOnce({ done: false, value: chunk })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(1) })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const controller = new AbortController();
    const response = {
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;

    await expect(readGifResponse(response, controller)).resolves.toHaveProperty(
      'byteLength',
      OLD_GIF_SOURCE_LIMIT_BYTES + 1,
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('streams Azure GIFs beyond the old fixed limit', async () => {
    const bytes = new Uint8Array(OLD_GIF_SOURCE_LIMIT_BYTES + 1);
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetchMock);
    const encodedUrl = btoa('https://example.com/image.gif')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');

    await expect(
      loadGifArrayBuffer(
        `azure-image-proxy://provider/${encodedUrl}`,
        new AbortController().signal,
      ),
    ).resolves.toHaveProperty(
      'byteLength',
      OLD_GIF_SOURCE_LIMIT_BYTES + 1,
    );
  });

  it('rejects sources that exceed the calculated memory budget', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const response = {
      headers: new Headers({
        'content-length': String(MAX_GIF_SOURCE_MEMORY_BYTES + 1),
      }),
      body: { cancel },
    } as unknown as Response;

    await expect(readGifResponse(response, controller)).rejects.toThrow(
      'safe memory budget',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
  });
});

function frame({
  left,
  color,
  disposalType = 1,
}: {
  left: number;
  color: [number, number, number, number];
  disposalType?: number;
}) {
  return {
    dims: { left, top: 0, width: 1, height: 1 },
    disposalType,
    patch: new Uint8ClampedArray(color),
  } as never;
}

describe('GIF frame composition', () => {
  const transparent: [number, number, number, number] = [0, 0, 0, 0];
  const red: [number, number, number, number] = [255, 0, 0, 255];
  const green: [number, number, number, number] = [0, 255, 0, 255];
  const blue: [number, number, number, number] = [0, 0, 255, 255];

  it('composes frames in order and restores disposal type 2 background', () => {
    const screen = new Uint8ClampedArray(8);
    const first = composeGifFrameRgba({
      screen,
      frame: frame({ left: 0, color: red, disposalType: 2 }),
      backgroundColor: green,
      canvasWidth: 2,
    });
    const second = composeGifFrameRgba({
      screen,
      frame: frame({ left: 1, color: blue }),
      backgroundColor: green,
      canvasWidth: 2,
    });

    expect(Array.from(first)).toEqual([...red, ...transparent]);
    expect(Array.from(second)).toEqual([...green, ...blue]);
  });

  it('clears disposal type 2 when logical background is transparent', () => {
    const screen = new Uint8ClampedArray(4);
    composeGifFrameRgba({
      screen,
      frame: frame({ left: 0, color: red, disposalType: 2 }),
      backgroundColor: null,
      canvasWidth: 1,
    });

    expect(Array.from(screen)).toEqual(transparent);
  });

  it('restores the previous screen for disposal type 3', () => {
    const screen = new Uint8ClampedArray(8);
    composeGifFrameRgba({
      screen,
      frame: frame({ left: 0, color: red }),
      backgroundColor: null,
      canvasWidth: 2,
    });
    const temporary = composeGifFrameRgba({
      screen,
      frame: frame({ left: 0, color: blue, disposalType: 3 }),
      backgroundColor: null,
      canvasWidth: 2,
    });
    const next = composeGifFrameRgba({
      screen,
      frame: frame({ left: 1, color: green }),
      backgroundColor: null,
      canvasWidth: 2,
    });

    expect(Array.from(temporary)).toEqual([...blue, ...transparent]);
    expect(Array.from(next)).toEqual([...red, ...green]);
  });

  it('treats a global background index marked transparent as transparent', () => {
    const background = getGifBackgroundColor({
      colorTable: [[12, 34, 56]],
      backgroundColorIndex: 0,
      hasGlobalColorTable: true,
      frame: {
        gce: {
          extras: { transparentColorGiven: true },
          transparentColorIndex: 0,
        },
        image: { descriptor: { lct: { exists: false } } },
      } as never,
    });

    expect(background).toBeNull();
  });

  it('derives an opaque logical-screen background from the global table', () => {
    const background = getGifBackgroundColor({
      colorTable: [[12, 34, 56]],
      backgroundColorIndex: 0,
      hasGlobalColorTable: true,
      frame: {
        gce: {
          extras: { transparentColorGiven: false },
          transparentColorIndex: 0,
        },
        image: { descriptor: { lct: { exists: false } } },
      } as never,
    });

    expect(background).toEqual([12, 34, 56, 255]);
  });
});

describe('GIF frame cache', () => {
  it('aborts an abandoned in-flight decode', () => {
    const decode = vi.fn(
      (_src: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const cache = createGifFrameCache({ decode });
    const acquired = cache.acquire('one.gif');

    acquired.release();

    expect(decode.mock.calls[0][1].aborted).toBe(true);
    void acquired.promise.catch(() => undefined);
  });

  it('keeps shared decode alive until the last consumer releases it', () => {
    const decode = vi.fn(
      (_src: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const cache = createGifFrameCache({ decode });
    const first = cache.acquire('shared.gif');
    const second = cache.acquire('shared.gif');

    first.release();
    expect(decode.mock.calls[0][1].aborted).toBe(false);

    second.release();
    expect(decode.mock.calls[0][1].aborted).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
    void first.promise.catch(() => undefined);
  });

  it('reuses a completed entry while consumers remain active', async () => {
    const decode = vi.fn(async () => ({ images: [], width: 1, height: 1 }));
    const cache = createGifFrameCache({ decode });
    const first = cache.acquire('first.gif');
    await first.promise;
    const second = cache.acquire('first.gif');
    await second.promise;
    first.release();

    const third = cache.acquire('first.gif');
    await third.promise;
    expect(decode).toHaveBeenCalledTimes(1);

    second.release();
    third.release();
  });

  it('removes a completed entry after its last release', async () => {
    const decode = vi.fn(async () => ({ images: [], width: 1, height: 1 }));
    const cache = createGifFrameCache({ decode });
    const first = cache.acquire('first.gif');
    await first.promise;
    first.release();

    const firstAgain = cache.acquire('first.gif');
    await firstAgain.promise;
    firstAgain.release();

    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh decode after a Strict Mode-like abandoned acquire', () => {
    const decode = vi.fn(
      (_src: string, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const cache = createGifFrameCache({ decode });
    const first = cache.acquire('strict.gif');
    first.release();
    const second = cache.acquire('strict.gif');

    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls[0][1].aborted).toBe(true);
    expect(decode.mock.calls[1][1].aborted).toBe(false);

    second.release();
    void first.promise.catch(() => undefined);
    void second.promise.catch(() => undefined);
  });
});
