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

  it('detects absolute file paths without a working dir', () => {
    expect(splitLogTextLinks('at /Users/me/app/src/a.ts:12:3')).toEqual([
      { type: 'text', text: 'at ' },
      {
        type: 'file',
        text: '/Users/me/app/src/a.ts:12:3',
        path: '/Users/me/app/src/a.ts',
        line: 12,
      },
    ]);
  });

  it('ignores relative paths when no working dir is known', () => {
    expect(splitLogTextLinks('ERR src/a.ts:4')).toEqual([
      { type: 'text', text: 'ERR src/a.ts:4' },
    ]);
  });

  it('detects relative paths when a working dir is known', () => {
    expect(
      splitLogTextLinks('ERR ./src/a.ts:4', { hasWorkingDir: true }),
    ).toEqual([
      { type: 'text', text: 'ERR ' },
      { type: 'file', text: './src/a.ts:4', path: './src/a.ts', line: 4 },
    ]);
  });

  it('ignores word pairs, dates and repo slugs', () => {
    for (const noise of [
      'use and/or here',
      'built 2024/01/02 ok',
      'cloning org/repo now',
      'set key/value pairs',
    ]) {
      expect(splitLogTextLinks(noise, { hasWorkingDir: true })).toEqual([
        { type: 'text', text: noise },
      ]);
    }
  });

  it('links bracketed relative paths and keeps punctuation outside', () => {
    expect(
      splitLogTextLinks('[vite] (src/a.ts)', { hasWorkingDir: true }),
    ).toEqual([
      { type: 'text', text: '[vite] (' },
      { type: 'file', text: 'src/a.ts', path: 'src/a.ts' },
      { type: 'text', text: ')' },
    ]);
  });

  it('detects home-relative paths without a working dir', () => {
    expect(splitLogTextLinks('cfg ~/notes/a.ts')).toEqual([
      { type: 'text', text: 'cfg ' },
      { type: 'file', text: '~/notes/a.ts', path: '~/notes/a.ts' },
    ]);
  });

  it('does not treat URL paths as file paths', () => {
    expect(
      splitLogTextLinks('see https://example.com/a/b.ts', {
        hasWorkingDir: true,
      }),
    ).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'link',
        text: 'https://example.com/a/b.ts',
        url: 'https://example.com/a/b.ts',
      },
    ]);
  });
});
