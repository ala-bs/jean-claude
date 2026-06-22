import { describe, expect, it } from 'vitest';

import { splitLogTextLinks } from '@/features/common/interactive-log/utils-log-links';

describe('splitLogTextLinks', () => {
  it('detects http and https URLs in log text', () => {
    expect(
      splitLogTextLinks(
        'Open http://localhost:3000 or https://example.com/path?q=1',
      ),
    ).toEqual([
      { type: 'text', text: 'Open ' },
      {
        type: 'link',
        text: 'http://localhost:3000',
        url: 'http://localhost:3000',
      },
      { type: 'text', text: ' or ' },
      {
        type: 'link',
        text: 'https://example.com/path?q=1',
        url: 'https://example.com/path?q=1',
      },
    ]);
  });

  it('leaves trailing sentence punctuation outside the URL', () => {
    expect(splitLogTextLinks('Preview: https://example.com/app).')).toEqual([
      { type: 'text', text: 'Preview: ' },
      {
        type: 'link',
        text: 'https://example.com/app',
        url: 'https://example.com/app',
      },
      { type: 'text', text: ').' },
    ]);
  });
});
