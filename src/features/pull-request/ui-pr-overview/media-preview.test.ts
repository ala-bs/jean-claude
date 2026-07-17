import { describe, expect, it } from 'vitest';
import type { PromptImagePart } from '@shared/agent-backend-types';

import { descriptionPreviewMarkdown } from './media-preview';

function image(
  placeholderMarkdown: string,
  overrides: Partial<PromptImagePart> = {},
) {
  return {
    type: 'image' as const,
    mimeType: 'image/png',
    data: 'large-base64-payload',
    filename: 'diagram.png',
    placeholderMarkdown,
    ...overrides,
  };
}

describe('descriptionPreviewMarkdown', () => {
  it('replaces a local placeholder with its aligned Blob URL', () => {
    const placeholder = '![diagram.png](jc-image://1)';

    const result = descriptionPreviewMarkdown(
      `Before\n\n${placeholder}\n\nAfter`,
      [image(placeholder)],
      ['blob:description-preview'],
    );

    expect(result).toContain('![diagram.png](blob:description-preview)');
    expect(result).not.toContain('jc-image://');
    expect(result).not.toContain('large-base64-payload');
    expect(result).not.toContain('data:image');
  });

  it('preserves image width suffix when replacing URL', () => {
    const placeholder = '![diagram.png](jc-image://2 =420x)';

    expect(
      descriptionPreviewMarkdown(
        placeholder,
        [image(placeholder)],
        ['blob:sized-preview'],
      ),
    ).toBe('![diagram.png](blob:sized-preview =420x)');
  });

  it('uses a lightweight filename fallback while Blob URL is pending', () => {
    const placeholder = '![animation.gif](jc-image://3 =420x)';

    const result = descriptionPreviewMarkdown(
      placeholder,
      [
        image(placeholder, {
          mimeType: 'image/gif',
          filename: 'animation.gif',
        }),
      ],
      [undefined],
    );

    expect(result).toBe('_[Attached GIF: animation.gif]_');
    expect(result).not.toContain('large-base64-payload');
    expect(result).not.toContain('data:image');
  });
});
