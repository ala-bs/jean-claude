import { describe, expect, it, vi } from 'vitest';

import { createPromptImageUploadCache } from './prompt-image-upload-cache';
import type { PromptImagePart } from '@shared/agent-backend-types';

function image(overrides: Partial<PromptImagePart> = {}): PromptImagePart {
  return {
    type: 'image',
    data: 'payload',
    mimeType: 'image/png',
    storageData: 'storage-payload',
    storageMimeType: 'image/avif',
    filename: 'image.png',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('prompt image upload cache', () => {
  it('compares payload fields without coercing or serializing them', async () => {
    const sentinel = Object.assign(new String('large-sentinel'), {
      toJSON: () => {
        throw new Error('payload serialized');
      },
      [Symbol.toPrimitive]: () => {
        throw new Error('payload coerced');
      },
    }) as unknown as string;
    const source = image({ data: sentinel, storageData: sentinel });
    const upload = vi.fn().mockResolvedValue('https://example.test/image.png');
    const cache = createPromptImageUploadCache();

    await cache.resolve({ image: source, fileName: 'image.png', upload });
    await cache.resolve({ image: source, fileName: 'image.png', upload });

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('retains successful siblings and invalidates direct field changes', async () => {
    const first = image({ filename: 'first.png' });
    const second = image({ filename: 'second.png', data: 'second' });
    const cache = createPromptImageUploadCache();
    const firstUpload = vi.fn().mockResolvedValue('first-url');
    const secondUpload = vi
      .fn()
      .mockRejectedValueOnce(new Error('upload failed'))
      .mockResolvedValue('second-url');

    await cache.resolve({ image: first, fileName: 'first.png', upload: firstUpload });
    await expect(
      cache.resolve({ image: second, fileName: 'second.png', upload: secondUpload }),
    ).rejects.toThrow('upload failed');
    await cache.resolve({ image: first, fileName: 'first.png', upload: firstUpload });
    await cache.resolve({ image: second, fileName: 'second.png', upload: secondUpload });

    first.data = 'changed';
    await cache.resolve({ image: first, fileName: 'first.png', upload: firstUpload });
    await cache.resolve({ image: second, fileName: 'renamed.png', upload: secondUpload });

    expect(firstUpload).toHaveBeenCalledTimes(2);
    expect(secondUpload).toHaveBeenCalledTimes(3);
  });

  it('does not repopulate after clearing an in-flight upload', async () => {
    let resolveUpload!: (url: string) => void;
    const source = image();
    const cache = createPromptImageUploadCache();
    const upload = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveUpload = resolve;
        }),
    );

    const pending = cache.resolve({ image: source, fileName: 'image.png', upload });
    cache.clear();
    resolveUpload('first-url');
    await pending;

    upload.mockResolvedValueOnce('second-url');
    await cache.resolve({ image: source, fileName: 'image.png', upload });

    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('reuses a pending sibling when another upload fails', async () => {
    const first = image({ filename: 'first.png' });
    const second = image({ filename: 'second.png' });
    const firstUpload = deferred<string>();
    const uploadFirst = vi.fn(() => firstUpload.promise);
    const uploadSecond = vi.fn().mockRejectedValue(new Error('second failed'));
    const cache = createPromptImageUploadCache();

    const pendingFirst = cache.resolve({
      image: first,
      fileName: 'first.png',
      upload: uploadFirst,
    });
    await expect(
      cache.resolve({
        image: second,
        fileName: 'second.png',
        upload: uploadSecond,
      }),
    ).rejects.toThrow('second failed');
    const retriedFirst = cache.resolve({
      image: first,
      fileName: 'first.png',
      upload: uploadFirst,
    });

    expect(uploadFirst).toHaveBeenCalledTimes(1);
    firstUpload.resolve('first-url');
    await expect(Promise.all([pendingFirst, retriedFirst])).resolves.toEqual([
      'first-url',
      'first-url',
    ]);
  });

  it('starts a new upload after pending payload mutation without stale overwrite', async () => {
    const source = image();
    const oldUpload = deferred<string>();
    const newUpload = deferred<string>();
    const uploadOld = vi.fn(() => oldUpload.promise);
    const uploadNew = vi.fn(() => newUpload.promise);
    const cache = createPromptImageUploadCache();

    const oldPending = cache.resolve({
      image: source,
      fileName: 'image.png',
      upload: uploadOld,
    });
    source.data = 'mutated-payload';
    const newPending = cache.resolve({
      image: source,
      fileName: 'image.png',
      upload: uploadNew,
    });

    newUpload.resolve('new-url');
    await expect(newPending).resolves.toBe('new-url');
    oldUpload.resolve('old-url');
    await expect(oldPending).resolves.toBe('old-url');
    await expect(
      cache.resolve({
        image: source,
        fileName: 'image.png',
        upload: uploadNew,
      }),
    ).resolves.toBe('new-url');

    expect(uploadOld).toHaveBeenCalledTimes(1);
    expect(uploadNew).toHaveBeenCalledTimes(1);
  });

  it('does not delete a replacement entry when a stale upload rejects', async () => {
    const source = image();
    const oldUpload = deferred<string>();
    const newUpload = deferred<string>();
    const cache = createPromptImageUploadCache();

    const oldPending = cache.resolve({
      image: source,
      fileName: 'image.png',
      upload: () => oldUpload.promise,
    });
    source.filename = 'renamed.png';
    const newPending = cache.resolve({
      image: source,
      fileName: 'renamed.png',
      upload: () => newUpload.promise,
    });

    oldUpload.reject(new Error('stale failure'));
    await expect(oldPending).rejects.toThrow('stale failure');
    newUpload.resolve('new-url');
    await expect(newPending).resolves.toBe('new-url');

    const uploadAgain = vi.fn().mockResolvedValue('unexpected-url');
    await expect(
      cache.resolve({
        image: source,
        fileName: 'renamed.png',
        upload: uploadAgain,
      }),
    ).resolves.toBe('new-url');
    expect(uploadAgain).not.toHaveBeenCalled();
  });
});
