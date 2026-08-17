import { describe, expect, it } from 'vitest';

import { synthesizeFileCommentsPrompt } from './composer-file-comments';

describe('composer file comment Agent Memory capture', () => {
  it('serializes stable identity and selected file context into submitted XML', () => {
    const prompt = synthesizeFileCommentsPrompt(
      [{
        id: 'cfc-stable',
        body: 'Preserve this branch',
        anchor: {
          filePath: 'src/app.ts',
          lineStart: 8,
          lineEnd: 9,
          selectedText: 'if (ready) return;',
        },
        createdAt: 1,
      }],
      '/project',
    );

    expect(prompt?.[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(
        '<comment index="1" comment_id="cfc-stable" type="file" file_path="src/app.ts" line_range="L8-9">',
      ),
    });
    expect(prompt?.[0]).toMatchObject({
      text: expect.stringContaining('<instruction>\nPreserve this branch'),
    });
  });
});
