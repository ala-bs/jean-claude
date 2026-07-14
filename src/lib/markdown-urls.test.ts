import { describe, expect, it } from 'vitest';

import { sanitizeMarkdownUrl } from './markdown-urls';

describe('sanitizeMarkdownUrl', () => {
  it('rejects Blob URLs by default', () => {
    expect(sanitizeMarkdownUrl('blob:local-preview')).toBe('');
  });

  it('accepts Blob URLs only with explicit opt-in', () => {
    expect(
      sanitizeMarkdownUrl('blob:local-preview', { allowBlob: true }),
    ).toBe('blob:local-preview');
  });
});
