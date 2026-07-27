import { describe, expect, it } from 'vitest';

import { getAttachmentFileName } from './image-utils';

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
