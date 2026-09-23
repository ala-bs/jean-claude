import { describe, expect, it } from 'vitest';

import {
  buildAgentPromptMarkdown,
  buildPromptActivityText,
  buildTaskCreationActivityText,
  getPromptDisplayText,
  interleavePromptParts,
  sanitizeAttachedFilesXml,
} from './prompt-utils';
import type { PromptImagePart, PromptPart } from '@shared/agent-backend-types';

describe('buildAgentPromptMarkdown', () => {
  it('serializes text and agent-facing image data as markdown', () => {
    const markdown = buildAgentPromptMarkdown([
      { type: 'text', text: 'Inspect this' },
      {
        type: 'image',
        data: 'webp-data',
        mimeType: 'image/webp',
        filename: 'screen[1].png',
        storageData: 'avif-data',
        storageMimeType: 'image/avif',
      },
    ]);

    expect(markdown).toBe(
      'Inspect this\n\n![screen_1_.png](data:image/webp;base64,webp-data)',
    );
  });

  it('keeps image-only prompts visible', () => {
    const markdown = buildAgentPromptMarkdown([
      {
        type: 'image',
        data: 'image-data',
        mimeType: 'image/png',
      },
    ]);

    expect(markdown).toBe('![image](data:image/png;base64,image-data)');
  });

  it('inlines a placeholder-anchored image where it was pasted', () => {
    const markdown = buildAgentPromptMarkdown([
      {
        type: 'text',
        text: '1. fix header\n![a.png](jc-image://aaa)\n2. fix modal',
      },
      {
        type: 'image',
        data: 'a-data',
        mimeType: 'image/png',
        filename: 'a.png',
        placeholderToken: 'aaa',
      },
    ]);

    expect(markdown).toBe(
      '1. fix header\n![a.png](data:image/png;base64,a-data)\n2. fix modal',
    );
  });

  it('appends images whose placeholder is gone', () => {
    const markdown = buildAgentPromptMarkdown([
      { type: 'text', text: '![a.png](jc-image://aaa)' },
      {
        type: 'image',
        data: 'a-data',
        mimeType: 'image/png',
        filename: 'a.png',
        placeholderToken: 'aaa',
      },
      {
        type: 'image',
        data: 'b-data',
        mimeType: 'image/png',
        filename: 'b.png',
        placeholderToken: 'bbb',
      },
    ]);

    expect(markdown).toBe(
      '![a.png](data:image/png;base64,a-data)\n\n![b.png](data:image/png;base64,b-data)',
    );
  });
});

describe('interleavePromptParts', () => {
  const anchored: PromptImagePart = {
    type: 'image',
    data: 'a-data',
    mimeType: 'image/png',
    filename: 'a.png',
    placeholderToken: 'aaa',
  };
  const loose: PromptImagePart = {
    type: 'image',
    data: 'b-data',
    mimeType: 'image/png',
    filename: 'b.png',
  };

  it('moves an anchored image into its placeholder slot', () => {
    expect(
      interleavePromptParts([
        { type: 'text', text: '1. header\n![a.png](jc-image://aaa)\n2. modal' },
        anchored,
      ]),
    ).toEqual([
      { type: 'text', text: '1. header\n' },
      anchored,
      { type: 'text', text: '\n2. modal' },
    ]);
  });

  it('leaves prompts without any placeholder byte-identical', () => {
    const parts: PromptPart[] = [{ type: 'text', text: 'hello' }, loose];
    expect(interleavePromptParts(parts)).toBe(parts);
  });

  it('keeps unanchored images and file parts trailing, in order', () => {
    expect(
      interleavePromptParts([
        { type: 'text', text: 'see ![a.png](jc-image://aaa)' },
        anchored,
        loose,
        { type: 'file', filePath: '/tmp/x.ts', filename: 'x.ts' },
      ]),
    ).toEqual([
      { type: 'text', text: 'see ' },
      anchored,
      loose,
      { type: 'file', filePath: '/tmp/x.ts', filename: 'x.ts' },
    ]);
  });

  it('never drops an image whose placeholder the user deleted', () => {
    const parts: PromptPart[] = [
      { type: 'text', text: 'no marker here' },
      anchored,
    ];
    expect(interleavePromptParts(parts)).toEqual([
      { type: 'text', text: 'no marker here' },
      anchored,
    ]);
  });
});

describe('getPromptDisplayText', () => {
  it('replaces placeholders with readable labels', () => {
    expect(
      getPromptDisplayText([
        { type: 'text', text: 'see ![a.png](jc-image://aaa) here' },
        {
          type: 'image',
          data: 'a-data',
          mimeType: 'image/png',
          filename: 'a.png',
          placeholderToken: 'aaa',
        },
      ]),
    ).toBe('see [image: a.png] here');
  });
});

describe('buildPromptActivityText', () => {
  it('keeps text and uses placeholders for non-text prompt parts', () => {
    expect(
      buildPromptActivityText([
        { type: 'text', text: 'Inspect this' },
        { type: 'image', data: 'image-data', mimeType: 'image/png' },
        { type: 'file', filePath: '/tmp/spec.md', filename: 'spec.md' },
      ]),
    ).toBe('Inspect this\n[image]\n[file: spec.md]');
  });

  it('sanitizes attached file XML blocks in text parts', () => {
    expect(
      buildPromptActivityText([
        {
          type: 'text',
          text: 'Review this\n\n<attached_files>\n  <file name="spec.md" path="/private/tmp/project/.jean-claude/tmp/spec.md" />\n  <file name="plan &amp; notes.txt" path="/private/tmp/project/.jean-claude/tmp/plan.txt" />\n</attached_files>',
        },
      ]),
    ).toBe('Review this\n\n[file: spec.md]\n[file: plan & notes.txt]');
  });

  it('sanitizes incomplete attached file XML fragments', () => {
    const sanitized = sanitizeAttachedFilesXml(
      'Review this\n<attached_files>\n  <file name="fixture.json" path="/var/folders/tmp/fixture.json"',
    );

    expect(sanitized).toContain('[file');
    expect(sanitized).not.toContain('/var/folders/tmp');
  });
});

describe('buildTaskCreationActivityText', () => {
  it('appends image placeholders to task creation prompt text', () => {
    expect(
      buildTaskCreationActivityText({
        prompt: 'Build this',
        images: [
          { type: 'image', data: 'image-data', mimeType: 'image/png' },
          {
            type: 'image',
            data: 'screen-data',
            mimeType: 'image/png',
            filename: 'screen.png',
          },
        ],
      }),
    ).toBe('Build this\n[image]\n[image: screen.png]');
  });

  it('sanitizes attached file XML blocks in task creation prompts', () => {
    expect(
      buildTaskCreationActivityText({
        prompt:
          'Build this\n\n<attached_files>\n  <file name="fixture.json" path="/var/folders/tmp/fixture.json" />\n</attached_files>',
      }),
    ).toBe('Build this\n\n[file: fixture.json]');
  });
});
