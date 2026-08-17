// @vitest-environment happy-dom
/* eslint-disable sort-imports */

import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decodeGifFrameImages = vi.hoisted(() => vi.fn());

vi.mock('./gif-frame-decoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./gif-frame-decoder')>()),
  decodeGifFrameImages,
}));

import { GifFrameScrubber } from '.';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('GIF scrubber lease handoff', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    decodeGifFrameImages.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
  });

  it('ignores old completion after a second scrubber synchronously takes lease', async () => {
    const oldDecode = deferred<{
      images: ImageData[];
      width: number;
      height: number;
    }>();
    const newDecode = deferred<{
      images: ImageData[];
      width: number;
      height: number;
    }>();
    decodeGifFrameImages
      .mockReturnValueOnce(oldDecode.promise)
      .mockReturnValueOnce(newDecode.promise);

    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(GifFrameScrubber, {
            src: 'old.gif',
            alt: 'Old GIF',
            interactive: false,
            onOpen: vi.fn(),
          }),
          createElement(GifFrameScrubber, {
            src: 'new.gif',
            alt: 'New GIF',
            interactive: false,
            onOpen: vi.fn(),
          }),
        ),
      );
    });

    const buttons = container.querySelectorAll<HTMLElement>('[role="button"]');
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    await act(async () => {
      oldDecode.resolve({
        images: [new ImageData(1, 1), new ImageData(1, 1)],
        width: 1,
        height: 1,
      });
      await oldDecode.promise;
    });

    expect(container.textContent).not.toContain('1/2');
    expect(container.querySelector('img[alt="Old GIF"]')).not.toBeNull();

    await act(async () => {
      newDecode.resolve({
        images: [new ImageData(1, 1), new ImageData(1, 1)],
        width: 1,
        height: 1,
      });
      await newDecode.promise;
    });

    expect(container.textContent).toContain('1/2');
    expect(container.querySelector('img[alt="Old GIF"]')).not.toBeNull();
    expect(container.querySelector('canvas[aria-label="New GIF"]')).not.toBeNull();
  });
});
