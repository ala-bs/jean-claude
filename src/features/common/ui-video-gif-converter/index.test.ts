// @vitest-environment happy-dom

import { act, createElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import {
  getFilmstripLayout,
  getGifConversionLimitError,
  MAX_FILMSTRIP_CANVAS_HEIGHT,
  MAX_FILMSTRIP_CANVAS_PIXELS,
  MAX_FILMSTRIP_CANVAS_WIDTH,
  MAX_FILMSTRIP_FRAME_COUNT,
  MAX_VIDEO_SIZE,
  VideoGifConverter,
} from './index';
import type {
  GifEncoderWorkerRequest,
  GifEncoderWorkerResponse,
} from './gif-encoder-worker';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
const SUPPORTS_ARRAY_BUFFER_TRANSFER = (() => {
  const buffer = new ArrayBuffer(1);
  structuredClone(buffer, { transfer: [buffer] });
  return buffer.byteLength === 0;
})();

class MockWorker {
  static holdFrames = false;
  static instances: MockWorker[] = [];

  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<GifEncoderWorkerResponse>) => void) | null =
    null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  pendingFrames: Extract<
    GifEncoderWorkerRequest,
    { type: 'encode-frame' }
  >[] = [];
  posted: { message: GifEncoderWorkerRequest; transfer: Transferable[] }[] = [];
  terminated = false;

  constructor() {
    MockWorker.instances.push(this);
  }

  static reset() {
    MockWorker.holdFrames = false;
    MockWorker.instances = [];
  }

  postMessage(message: GifEncoderWorkerRequest, transfer: Transferable[] = []) {
    const sourceTransfer = [...transfer];
    const deliveredMessage = SUPPORTS_ARRAY_BUFFER_TRANSFER
      ? structuredClone(message, { transfer })
      : message;
    this.posted.push({ message: deliveredMessage, transfer: sourceTransfer });
    if (deliveredMessage.type === 'initialize') {
      this.respond({ type: 'initialized' });
      return;
    }
    if (deliveredMessage.type === 'encode-frame') {
      if (MockWorker.holdFrames) {
        this.pendingFrames.push(deliveredMessage);
      } else {
        this.respondFrame(deliveredMessage);
      }
      return;
    }
    this.respond({
      type: 'finished',
      bytes: new Uint8Array([71, 73, 70]).buffer,
    });
  }

  respondNextFrame() {
    const frame = this.pendingFrames.shift();
    if (!frame) throw new Error('No pending worker frame');
    this.respondFrame(frame);
  }

  terminate() {
    this.terminated = true;
  }

  private respondFrame(
    frame: Extract<GifEncoderWorkerRequest, { type: 'encode-frame' }>,
  ) {
    this.respond({
      type: 'frame-encoded',
      frameIndex: frame.frameIndex,
      sizeBytes: 128 * (frame.frameIndex + 1),
    });
  }

  private respond(response: GifEncoderWorkerResponse) {
    queueMicrotask(() => {
      if (!this.terminated) {
        this.onmessage?.({ data: response } as MessageEvent);
      }
    });
  }
}

function setVideoMetadata(
  video: HTMLVideoElement,
  { duration, width, height }: { duration: number; width: number; height: number },
) {
  Object.defineProperties(video, {
    duration: { configurable: true, value: duration },
    videoWidth: { configurable: true, value: width },
    videoHeight: { configurable: true, value: height },
    readyState: { configurable: true, value: 2 },
  });
  video.dispatchEvent(new Event('loadedmetadata'));
}

function findButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`${label} button not found`);
  return button;
}

describe('GIF conversion limits', () => {
  it('enforces dimensions, per-frame pixels, frame count, and total pixels', () => {
    expect(
      getGifConversionLimitError({ width: 100, height: 100, frames: 361 }),
    ).toContain('360 frames');
    expect(
      getGifConversionLimitError({ width: 1281, height: 100, frames: 1 }),
    ).toContain('1280px');
    expect(
      getGifConversionLimitError({ width: 1001, height: 1000, frames: 1 }),
    ).toContain('1 million pixels');
    expect(
      getGifConversionLimitError({ width: 1000, height: 1000, frames: 151 }),
    ).toContain('too much pixel processing');
  });

  it('allows default 50% 1080p work despite a high content-blind estimate', () => {
    expect(
      getGifConversionLimitError({ width: 960, height: 540, frames: 144 }),
    ).toBeNull();
  });

  it.each([
    { sourceWidth: 1, sourceHeight: 100_000 },
    { sourceWidth: 100_000, sourceHeight: 1 },
  ])('bounds filmstrip work for extreme $sourceWidth x $sourceHeight video', (size) => {
    const layout = getFilmstripLayout({
      timelineWidth: 100_000,
      ...size,
    });

    expect(layout.frameCount).toBeLessThanOrEqual(MAX_FILMSTRIP_FRAME_COUNT);
    expect(layout.canvasWidth).toBeLessThanOrEqual(MAX_FILMSTRIP_CANVAS_WIDTH);
    expect(layout.canvasHeight).toBeLessThanOrEqual(MAX_FILMSTRIP_CANVAS_HEIGHT);
    expect(layout.canvasWidth * layout.canvasHeight).toBeLessThanOrEqual(
      MAX_FILMSTRIP_CANVAS_PIXELS,
    );
  });
});

describe('VideoGifConverter worker encoding', () => {
  let container: HTMLDivElement;
  let createdVideos: HTMLVideoElement[];
  let objectUrlCount: number;
  let preloadCreatedVideoMetadata: boolean;
  let root: Root;
  const onAttach = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    createdVideos = [];
    objectUrlCount = 0;
    preloadCreatedVideoMetadata = false;
    onAttach.mockReset();
    onClose.mockReset();
    MockWorker.reset();
    vi.stubGlobal('Worker', MockWorker);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(
      () => `blob:converter-${++objectUrlCount}`,
    );
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage: vi.fn(),
          fillRect: vi.fn(),
          getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
        }) as unknown as CanvasRenderingContext2D,
    );
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      const element = createElement(tagName, options);
      if (tagName.toLowerCase() === 'video') {
        let currentTime = 0;
        Object.defineProperties(element, {
          currentTime: {
            configurable: true,
            get: () => currentTime,
            set: (value: number) => {
              currentTime = value;
              queueMicrotask(() => element.dispatchEvent(new Event('seeked')));
            },
          },
          readyState: { configurable: true, value: 0 },
        });
        if (preloadCreatedVideoMetadata) {
          Object.defineProperties(element, {
            duration: { configurable: true, value: 0.2 },
            videoWidth: { configurable: true, value: 320 },
            videoHeight: { configurable: true, value: 180 },
            readyState: { configurable: true, value: 2 },
          });
        }
        createdVideos.push(element as HTMLVideoElement);
      }
      return element;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderConverter(fileName = 'recording.mp4', strictMode = false) {
    const converter = createElement(VideoGifConverter, {
      file: new File(['video'], fileName, { type: 'video/mp4' }),
      onAttach,
      onClose,
    });
    await act(async () => {
      root.render(strictMode ? createElement(StrictMode, null, converter) : converter);
    });
    const video = container.querySelector('video');
    if (!video) throw new Error('Preview video not found');
    return video;
  }

  it('rejects oversized input before creating a preview object URL', async () => {
    const file = new File(['video'], 'oversized.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: MAX_VIDEO_SIZE + 1 });

    await act(async () => {
      root.render(createElement(VideoGifConverter, { file, onAttach, onClose }));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'under 80 MB',
    );
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector('video')).toBeNull();
  });

  it('cancels pending filmstrip generation when closed', async () => {
    const toDataUrl = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,frame');
    const previewVideo = await renderConverter();
    await act(async () =>
      setVideoMetadata(previewVideo, { duration: 2, width: 320, height: 180 }),
    );
    const filmstripVideo = createdVideos.at(-1);
    if (!filmstripVideo || filmstripVideo === previewVideo) {
      throw new Error('Filmstrip video not found');
    }

    await act(async () => findButton(container, 'Cancel').click());
    await act(async () =>
      setVideoMetadata(filmstripVideo, { duration: 2, width: 320, height: 180 }),
    );

    expect(onClose).toHaveBeenCalledOnce();
    expect(toDataUrl).not.toHaveBeenCalled();
  });

  function getConversionVideo() {
    const video = createdVideos.find((candidate) =>
      candidate.src.endsWith('blob:converter-2'),
    );
    if (!video) throw new Error('Conversion video not found');
    return video;
  }

  async function startEncoding(duration = 0.2) {
    const video = await renderConverter();
    await act(async () =>
      setVideoMetadata(video, { duration, width: 320, height: 180 }),
    );
    await act(async () => findButton(container, '8').click());
    await act(async () => findButton(container, 'Convert to GIF').click());
    await act(async () =>
      setVideoMetadata(getConversionVideo(), {
        duration,
        width: 320,
        height: 180,
      }),
    );
    const worker = MockWorker.instances[0];
    if (!worker) throw new Error('Encoder worker not created');
    return worker;
  }

  it('transfers ordered frames with one-frame backpressure and returns GIF', async () => {
    MockWorker.holdFrames = true;
    const worker = await startEncoding();
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          worker.posted.filter(({ message }) => message.type === 'encode-frame'),
        ).toHaveLength(1),
      );
    });
    const firstFrame = worker.posted.find(
      ({ message }) => message.type === 'encode-frame',
    );
    if (!firstFrame || firstFrame.message.type !== 'encode-frame') {
      throw new Error('First transferred frame not found');
    }
    expect(firstFrame.transfer).toHaveLength(1);

    await act(async () => worker.respondNextFrame());
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          worker.posted.filter(({ message }) => message.type === 'encode-frame'),
        ).toHaveLength(2),
      );
    });
    expect(worker.posted.some(({ message }) => message.type === 'finish')).toBe(
      false,
    );

    await act(async () => worker.respondNextFrame());
    await act(async () => {
      await vi.waitFor(() => expect(onAttach).toHaveBeenCalledOnce());
    });

    expect(
      worker.posted.map(({ message }) =>
        message.type === 'encode-frame'
          ? `${message.type}:${message.frameIndex}`
          : message.type,
      ),
    ).toEqual(['initialize', 'encode-frame:0', 'encode-frame:1', 'finish']);
    expect(onAttach.mock.calls[0]?.[0]).toMatchObject({
      data: 'R0lG',
      filename: 'recording.gif',
      mimeType: 'image/gif',
      sizeBytes: 3,
      storageData: 'R0lG',
    });
    expect(worker.terminated).toBe(true);
  });

  it('converts when metadata loaded before the conversion listener attaches', async () => {
    const previewVideo = await renderConverter();
    await act(async () =>
      setVideoMetadata(previewVideo, { duration: 0.2, width: 320, height: 180 }),
    );
    await act(async () => findButton(container, '8').click());
    preloadCreatedVideoMetadata = true;

    await act(async () => findButton(container, 'Convert to GIF').click());
    await act(async () => {
      await vi.waitFor(() => expect(onAttach).toHaveBeenCalledOnce());
    });
  });

  it('attaches the completed GIF after StrictMode replays effects', async () => {
    const previewVideo = await renderConverter('strict.mp4', true);
    await act(async () =>
      setVideoMetadata(previewVideo, { duration: 0.2, width: 320, height: 180 }),
    );
    await act(async () => findButton(container, '8').click());
    await act(async () => findButton(container, 'Convert to GIF').click());
    const conversionVideo = createdVideos.at(-1);
    if (!conversionVideo || conversionVideo === previewVideo) {
      throw new Error('Conversion video not found');
    }
    await act(async () =>
      setVideoMetadata(conversionVideo, {
        duration: 0.2,
        width: 320,
        height: 180,
      }),
    );
    await act(async () => {
      await vi.waitFor(() => expect(onAttach).toHaveBeenCalledOnce());
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.skipIf(!SUPPORTS_ARRAY_BUFFER_TRANSFER)(
    'detaches transferred RGBA without reading it again on renderer',
    async () => {
      MockWorker.holdFrames = true;
      const worker = await startEncoding(0.1);
      await act(async () => {
        await vi.waitFor(() => expect(worker.pendingFrames).toHaveLength(1));
      });
      const frame = worker.posted.find(
        ({ message }) => message.type === 'encode-frame',
      );
      if (!frame || frame.message.type !== 'encode-frame') {
        throw new Error('Transferred frame not found');
      }

      expect((frame.transfer[0] as ArrayBuffer).byteLength).toBe(0);
      expect(frame.message.rgba.byteLength).toBe(4);

      await act(async () => worker.respondNextFrame());
      await act(async () => {
        await vi.waitFor(() => expect(onAttach).toHaveBeenCalledOnce());
      });
    },
  );

  it('terminates promptly when cancelled during an in-flight frame', async () => {
    MockWorker.holdFrames = true;
    const worker = await startEncoding();
    await act(async () => {
      await vi.waitFor(() => expect(worker.pendingFrames).toHaveLength(1));
    });

    await act(async () => findButton(container, 'Cancel').click());

    expect(worker.terminated).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAttach).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:converter-2');
  });

  it('keeps output estimate and modal accessibility behavior', async () => {
    const video = await renderConverter();
    await act(async () =>
      setVideoMetadata(video, { duration: 6, width: 1920, height: 1080 }),
    );
    const dialog = container.querySelector('[role="dialog"]');
    const closeButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Close GIF converter"]',
    );

    expect(findButton(container, 'Convert to GIF').disabled).toBe(false);
    expect(container.textContent).toContain('estimated output');
    expect(container.textContent).not.toContain('10 MB limit');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(document.activeElement).toBe(closeButton);
  });
});
