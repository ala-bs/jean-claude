import { describe, expect, it, vi } from 'vitest';

const { transcodeBase64ImageSpy } = vi.hoisted(() => ({
  transcodeBase64ImageSpy: vi.fn(),
}));

vi.mock('./image-compression', () => ({
  compressImage: vi.fn(),
  transcodeBase64Image: transcodeBase64ImageSpy,
}));

import {
  getAttachmentFileName,
  getAttachmentPayload,
  getAzureAttachmentPayload,
} from './image-utils';

describe('getAzureAttachmentPayload', () => {
  it('transcodes WebP agent bytes to PNG', async () => {
    transcodeBase64ImageSpy.mockResolvedValue({
      dataBase64: 'png-bytes',
      mimeType: 'image/png',
    });

    await expect(
      getAzureAttachmentPayload({
        data: 'webp-bytes',
        mimeType: 'image/webp',
        storageData: 'avif-bytes',
        storageMimeType: 'image/avif',
      }),
    ).resolves.toEqual({ dataBase64: 'png-bytes', mimeType: 'image/png' });

    expect(transcodeBase64ImageSpy).toHaveBeenCalledWith({
      dataBase64: 'webp-bytes',
      sourceMimeType: 'image/webp',
      targetMimeType: 'image/png',
    });
  });

  it('keeps GIF storage bytes without re-encoding', async () => {
    transcodeBase64ImageSpy.mockClear();

    await expect(
      getAzureAttachmentPayload({
        data: 'webp-bytes',
        mimeType: 'image/webp',
        storageData: 'gif-bytes',
        storageMimeType: 'image/gif',
      }),
    ).resolves.toEqual({ dataBase64: 'gif-bytes', mimeType: 'image/gif' });
    expect(transcodeBase64ImageSpy).not.toHaveBeenCalled();
  });

  it('passes PNG bytes through untouched', async () => {
    transcodeBase64ImageSpy.mockClear();

    await expect(
      getAzureAttachmentPayload({ data: 'png-bytes', mimeType: 'image/png' }),
    ).resolves.toEqual({ dataBase64: 'png-bytes', mimeType: 'image/png' });
    expect(transcodeBase64ImageSpy).not.toHaveBeenCalled();
  });
});

describe('getAttachmentPayload', () => {
  const agent = { data: 'webp-bytes', mimeType: 'image/webp' };

  it('falls back to the agent variant when storage is AVIF', () => {
    expect(
      getAttachmentPayload({
        ...agent,
        storageData: 'avif-bytes',
        storageMimeType: 'image/avif',
      }),
    ).toEqual({ dataBase64: 'webp-bytes', mimeType: 'image/webp' });
  });

  it('keeps original GIF storage bytes so animation survives', () => {
    expect(
      getAttachmentPayload({
        ...agent,
        storageData: 'gif-bytes',
        storageMimeType: 'image/gif',
      }),
    ).toEqual({ dataBase64: 'gif-bytes', mimeType: 'image/gif' });
  });

  it('uses the agent variant when there is no storage variant', () => {
    expect(getAttachmentPayload(agent)).toEqual({
      dataBase64: 'webp-bytes',
      mimeType: 'image/webp',
    });
  });

  it('ignores a storage variant with missing bytes', () => {
    expect(
      getAttachmentPayload({ ...agent, storageMimeType: 'image/gif' }),
    ).toEqual({ dataBase64: 'webp-bytes', mimeType: 'image/webp' });
  });
});

describe('getAttachmentFileName', () => {
  it('rewrites the extension to match re-encoded bytes', () => {
    expect(getAttachmentFileName('screenshot.png', 'image/avif')).toBe(
      'screenshot.avif',
    );
    expect(getAttachmentFileName('photo.jpeg', 'image/webp')).toBe(
      'photo.webp',
    );
  });

  it('keeps the name when the extension already matches', () => {
    expect(getAttachmentFileName('demo.gif', 'image/gif')).toBe('demo.gif');
  });

  it('handles names without an extension and unknown mime types', () => {
    expect(getAttachmentFileName('capture', 'image/avif')).toBe(
      'capture.avif',
    );
    expect(getAttachmentFileName('file.bin', 'application/octet-stream')).toBe(
      'file.bin',
    );
    expect(getAttachmentFileName('.png', 'image/png')).toBe('image.png');
  });
});
