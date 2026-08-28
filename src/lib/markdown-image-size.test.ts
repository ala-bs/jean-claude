import { describe, expect, it } from 'vitest';

import {
  getPromptImageMarkdownSize,
  markdownImagePlaceholderPattern,
  replaceMarkdownImageUrl,
  stripUnresolvedImagePlaceholders,
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

describe('stripUnresolvedImagePlaceholders', () => {
  it('leaves markdown without placeholders untouched', () => {
    const text = 'Fixes the thing\n\n![shipped](https://x/a.png =640x)';
    expect(stripUnresolvedImagePlaceholders(text)).toEqual({ text, removed: 0 });
  });

  it('removes an unresolved placeholder and reports the count', () => {
    const result = stripUnresolvedImagePlaceholders(
      'Intro\n\n![a](jc-image://1 =640x)\n\nOutro',
    );

    expect(result.removed).toBe(1);
    expect(result.text).toBe('Intro\n\nOutro');
  });

  it('collapses the blank-line run left by a stripped placeholder', () => {
    const result = stripUnresolvedImagePlaceholders(
      'Intro\n\n![a](jc-image://1)\n\n![b](jc-image://2)\n\nOutro',
    );

    expect(result.removed).toBe(2);
    expect(result.text).toBe('Intro\n\nOutro');
    expect(result.text).not.toContain('\n\n\n');
  });

  it('keeps resolved images while dropping only the unresolved ones', () => {
    const result = stripUnresolvedImagePlaceholders(
      '![ok](https://x/a.png =640x)\n\n![bad](jc-image://7 =420x)',
    );

    expect(result.removed).toBe(1);
    expect(result.text).toBe('![ok](https://x/a.png =640x)');
    expect(result.text).not.toContain('jc-image://');
  });

  it('handles a description that was nothing but a placeholder', () => {
    expect(
      stripUnresolvedImagePlaceholders('![a](jc-image://1 =640x)'),
    ).toEqual({ text: '', removed: 1 });
  });
});
