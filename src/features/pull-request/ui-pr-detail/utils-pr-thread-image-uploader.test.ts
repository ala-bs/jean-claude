import { describe, expect, it, vi } from 'vitest';

import { getPrThreadImageUploader } from './utils-pr-thread-image-uploader';

describe('getPrThreadImageUploader', () => {
  it('keeps existing PR thread uploads available in task-comment mode', () => {
    const uploadImage = vi.fn();

    expect(
      getPrThreadImageUploader({
        readOnly: false,
        activeCommentMode: 'task',
        uploadImage,
      }),
    ).toBe(uploadImage);
  });

  it('suppresses existing PR thread uploads in read-only mode', () => {
    const uploadImage = vi.fn();

    expect(
      getPrThreadImageUploader({
        readOnly: true,
        activeCommentMode: 'pr',
        uploadImage,
      }),
    ).toBeUndefined();
    expect(
      getPrThreadImageUploader({
        readOnly: true,
        activeCommentMode: 'task',
        uploadImage,
      }),
    ).toBeUndefined();
  });
});
