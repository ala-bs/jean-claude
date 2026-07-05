import { describe, expect, it } from 'vitest';

import {
  getPromptImageMarkdownSize,
  markdownImagePlaceholderPattern,
  replaceMarkdownImageUrl,
} from './markdown-image-size';


describe('markdown image sizing', () => {
  it('uses dimension-aware default width caps', () => {
    expect(
      getPromptImageMarkdownSize({
        type: 'image',
        data: 'data',
        mimeType: 'image/png',
        width: 400,
        height: 800,
      }),
    ).toBe(' =280x');

    expect(
      getPromptImageMarkdownSize({
        type: 'image',
        data: 'data',
        mimeType: 'image/png',
        width: 800,
        height: 600,
      }),
    ).toBe(' =420x');

    expect(
      getPromptImageMarkdownSize({
        type: 'image',
        data: 'data',
        mimeType: 'image/png',
        width: 1200,
        height: 500,
      }),
    ).toBe(' =640x');
  });

  it('preserves edited placeholder size when replacing URL', () => {
    expect(replaceMarkdownImageUrl('![img](jc-image://1 =300x)', 'https://x/img.png')).toBe(
      '![img](https://x/img.png =300x)',
    );
  });

  it('omits size when user removed placeholder size', () => {
    expect(replaceMarkdownImageUrl('![img](jc-image://1)', 'https://x/img.png')).toBe(
      '![img](https://x/img.png)',
    );
  });

  it('matches placeholders with edited or removed size suffixes', () => {
    const pattern = markdownImagePlaceholderPattern('![img](jc-image://1 =420x)');

    expect('![img](jc-image://1 =320x)'.match(pattern!)).not.toBeNull();
    expect('![img](jc-image://1)'.match(pattern!)).not.toBeNull();
    expect('![img](jc-image://2 =320x)'.match(pattern!)).toBeNull();
  });
});
