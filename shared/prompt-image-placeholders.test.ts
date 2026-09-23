import { describe, expect, it } from 'vitest';

import {
  buildPromptImagePlaceholder,
  createPromptImageToken,
  removePromptImagePlaceholder,
  renderPromptImagePlaceholders,
  splitPromptTextByImages,
  stripPromptImagePlaceholders,
} from './prompt-image-placeholders';
import type { PromptImagePart } from './agent-backend-types';

function image(
  token: string | undefined,
  filename = `${token}.png`,
): PromptImagePart {
  return {
    type: 'image',
    data: `data-${token}`,
    mimeType: 'image/png',
    filename,
    placeholderToken: token,
  };
}

describe('buildPromptImagePlaceholder', () => {
  it('includes a display-width hint from the image dimensions', () => {
    expect(
      buildPromptImagePlaceholder({
        token: 'abc123',
        filename: 'shot.png',
        width: 1600,
        height: 400,
      }),
    ).toBe('![shot.png](jc-image://abc123 =640x)');
  });

  it('neutralises markdown syntax in the filename', () => {
    expect(buildPromptImagePlaceholder({ token: 'a', filename: '](evil)' })).toBe(
      '![__evil_](jc-image://a)',
    );
  });
});

describe('splitPromptTextByImages', () => {
  it('places each image where its placeholder sits in the text', () => {
    const a = image('aaa');
    const b = image('bbb');
    const { blocks, trailing } = splitPromptTextByImages({
      text: '1. fix header\n![aaa.png](jc-image://aaa)\n2. fix modal\n![bbb.png](jc-image://bbb)',
      images: [a, b],
    });

    expect(blocks).toEqual([
      { type: 'text', text: '1. fix header\n' },
      { type: 'image', image: a },
      { type: 'text', text: '\n2. fix modal\n' },
      { type: 'image', image: b },
    ]);
    expect(trailing).toEqual([]);
  });

  it('trails images that have no placeholder in the text', () => {
    const a = image('aaa');
    const legacy = image(undefined, 'legacy.png');
    const deleted = image('ddd');

    const { blocks, trailing } = splitPromptTextByImages({
      text: 'look ![aaa.png](jc-image://aaa =420x) here',
      images: [a, legacy, deleted],
    });

    expect(blocks).toEqual([
      { type: 'text', text: 'look ' },
      { type: 'image', image: a },
      { type: 'text', text: ' here' },
    ]);
    expect(trailing).toEqual([legacy, deleted]);
  });

  it('reduces an unresolvable placeholder to its label, never a dead link', () => {
    const { blocks, trailing } = splitPromptTextByImages({
      text: 'before ![x.png](jc-image://zzz) after',
      images: [image('aaa')],
    });

    // One merged run: the label must not split the sentence into blocks.
    expect(blocks).toEqual([
      { type: 'text', text: 'before [image: x.png] after' },
    ]);
    expect(blocks[0]).not.toHaveProperty('text', expect.stringContaining('jc-image'));
    expect(trailing).toHaveLength(1);
  });

  it('labels the copy when a user duplicates a line containing a marker', () => {
    const a = image('aaa');
    const { blocks } = splitPromptTextByImages({
      text: 'A![aaa.png](jc-image://aaa)B![aaa.png](jc-image://aaa)C',
      images: [a],
    });

    expect(blocks).toEqual([
      { type: 'text', text: 'A' },
      { type: 'image', image: a },
      { type: 'text', text: 'B[image: aaa.png]C' },
    ]);
  });

  it('labels every marker when a whole prompt is copied with no images', () => {
    // Copying a previous prompt's text into a new task brings its markers but
    // none of its attachments.
    const { blocks, trailing } = splitPromptTextByImages({
      text: '1. header\n![a.png](jc-image://aaa =420x)\n2. modal',
      images: [],
    });

    expect(blocks).toEqual([
      { type: 'text', text: '1. header\n[image: a.png]\n2. modal' },
    ]);
    expect(trailing).toEqual([]);
  });

  it('passes text through untouched when no image carries a token', () => {
    const legacy = image(undefined);
    expect(
      splitPromptTextByImages({ text: 'hello', images: [legacy] }),
    ).toEqual({
      blocks: [{ type: 'text', text: 'hello' }],
      trailing: [legacy],
    });
  });
});

describe('renderPromptImagePlaceholders', () => {
  it('substitutes rendered images in place', () => {
    expect(
      renderPromptImagePlaceholders({
        text: 'one ![aaa.png](jc-image://aaa) two',
        images: [image('aaa')],
        render: (img) => `[image: ${img.filename}]`,
      }).text,
    ).toBe('one [image: aaa.png] two');
  });
});

describe('removePromptImagePlaceholder', () => {
  it('drops the placeholder and collapses the blank line it left behind', () => {
    expect(
      removePromptImagePlaceholder(
        '1. fix header\n![aaa.png](jc-image://aaa =420x)\n2. fix modal',
        'aaa',
      ),
    ).toBe('1. fix header\n2. fix modal');
  });

  it('leaves other images alone', () => {
    expect(
      removePromptImagePlaceholder(
        '![a](jc-image://aaa) ![b](jc-image://bbb)',
        'aaa',
      ),
    ).toBe(' ![b](jc-image://bbb)');
  });
});

describe('stripPromptImagePlaceholders', () => {
  it('removes markers regardless of token, leaving surrounding text', () => {
    expect(
      stripPromptImagePlaceholders(
        'a ![x.png](jc-image://aaa) b ![y.png](jc-image://bbb =280x) c',
      ),
    ).toBe('a  b  c');
  });

  it('leaves text with no markers untouched', () => {
    expect(stripPromptImagePlaceholders('![real](https://x/y.png)')).toBe(
      '![real](https://x/y.png)',
    );
  });
});

describe('createPromptImageToken', () => {
  it('never returns a token already taken', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = createPromptImageToken(taken);
      expect(token).not.toBe('');
      expect(taken.has(token)).toBe(false);
      taken.add(token);
    }
  });

  it('produces a token the placeholder regex can match back out', () => {
    const token = createPromptImageToken();
    const marker = buildPromptImagePlaceholder({ token, filename: 'a.png' });
    const { blocks } = splitPromptTextByImages({
      text: marker,
      images: [
        {
          type: 'image',
          data: 'd',
          mimeType: 'image/png',
          filename: 'a.png',
          placeholderToken: token,
        },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'image' });
  });
});
