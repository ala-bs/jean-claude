import { describe, expect, it } from 'vitest';

import {
  splitLogTextLinks,
  splitLogTextLinkSpans,
} from '@/features/common/interactive-log/utils-log-links';

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

describe('splitLogTextLinkSpans', () => {
  it('reports the character range of each segment in the source text', () => {
    // Vite renders `➜  Local:   http://localhost:5800/` with the port bolded,
    // so the URL spans several ANSI segments. Detection runs on the whole line
    // and the ranges let the renderer nest styling inside the single link.
    const text = ' ➜  Local:   http://localhost:5800/';
    const spans = splitLogTextLinkSpans(text);

    expect(spans).toEqual([
      { type: 'text', text: ' ➜  Local:   ', start: 0, end: 13 },
      {
        type: 'link',
        text: 'http://localhost:5800/',
        url: 'http://localhost:5800/',
        start: 13,
        end: 35,
      },
    ]);
  });

  it('produces contiguous ranges that tile the source text exactly', () => {
    const text = 'see src/a.ts and http://localhost:5800/ now';
    const spans = splitLogTextLinkSpans(text, { hasWorkingDir: true });

    let expectedStart = 0;
    for (const span of spans) {
      expect(span.start).toBe(expectedStart);
      expect(text.slice(span.start, span.end)).toBe(span.text);
      expectedStart = span.end;
    }
    expect(expectedStart).toBe(text.length);
  });
});

describe('whole-line detection does not glue adjacent tokens', () => {
  it('does not swallow a box-drawing border into the URL', () => {
    // Boxed output: `│ http://localhost:5173/│` with the border styled
    // separately. The border must not become part of the href.
    expect(splitLogTextLinks('│ http://localhost:5173/│')).toEqual([
      { type: 'text', text: '│ ' },
      {
        type: 'link',
        text: 'http://localhost:5173/',
        url: 'http://localhost:5173/',
      },
      { type: 'text', text: '│' },
    ]);
  });

  it('does not swallow a bullet or em-dash following a URL', () => {
    expect(splitLogTextLinks('https://a.com•')).toEqual([
      { type: 'link', text: 'https://a.com', url: 'https://a.com' },
      { type: 'text', text: '•' },
    ]);
  });

  it('keeps two adjacent URLs separate', () => {
    expect(splitLogTextLinks('http://a.comhttp://b.com')).toEqual([
      { type: 'link', text: 'http://a.com', url: 'http://a.com' },
      { type: 'link', text: 'http://b.com', url: 'http://b.com' },
    ]);
  });

  it('linkifies a path prefixed by a box-drawing or bullet glyph', () => {
    expect(splitLogTextLinks('│src/a.ts', { hasWorkingDir: true })).toEqual([
      { type: 'text', text: '│' },
      { type: 'file', text: 'src/a.ts', path: 'src/a.ts' },
    ]);
    expect(splitLogTextLinks('➜src/a.ts', { hasWorkingDir: true })).toEqual([
      { type: 'text', text: '➜' },
      { type: 'file', text: 'src/a.ts', path: 'src/a.ts' },
    ]);
  });

  it('does not linkify a path glued to a preceding colon', () => {
    // `:` is a separator in terminal output far more often than a prefix, so
    // these must stay plain rather than become bogus clickable files.
    expect(
      splitLogTextLinks('To github.com:owner/repo.git', {
        hasWorkingDir: true,
      }),
    ).toEqual([{ type: 'text', text: 'To github.com:owner/repo.git' }]);

    expect(splitLogTextLinks('ETA 00:01/00:02', { hasWorkingDir: true })).toEqual(
      [{ type: 'text', text: 'ETA 00:01/00:02' }],
    );
  });

  it('still rejects a path glued to the tail of a preceding path', () => {
    // `prev` is `/`, a plausible path continuation, so this is not a new link.
    expect(
      splitLogTextLinks('a/b.tssrc/c.ts', { hasWorkingDir: true }),
    ).toEqual([{ type: 'file', text: 'a/b.tssrc/c.ts', path: 'a/b.tssrc/c.ts' }]);
  });

  it('keeps non-ASCII URLs intact rather than truncating them', () => {
    // Truncating yields a link to a real but WRONG page, with no visible clue.
    for (const url of [
      'https://ja.wikipedia.org/wiki/日本語',
      'https://example.com/café/menu',
      'https://example.com/path?q=🎉&x=1',
      'https://example.com/~user/a+b',
    ]) {
      expect(splitLogTextLinks(url)).toEqual([{ type: 'link', text: url, url }]);
    }
  });

  it('keeps a nested URL in a query param as one link', () => {
    const url = 'https://auth.example.com/login?next=http://localhost:3000/cb';
    expect(splitLogTextLinks(url)).toEqual([{ type: 'link', text: url, url }]);
  });

  it('keeps a balanced closing paren inside the URL', () => {
    const url = 'https://en.wikipedia.org/wiki/Mercury_(planet)';
    expect(splitLogTextLinks(url)).toEqual([{ type: 'link', text: url, url }]);

    // ...but an unbalanced one is still prose punctuation.
    expect(splitLogTextLinks('(see https://a.com)')).toEqual([
      { type: 'text', text: '(see ' },
      { type: 'link', text: 'https://a.com', url: 'https://a.com' },
      { type: 'text', text: ')' },
    ]);
  });

  it('keeps columns separated by cursor-forward padding apart', () => {
    // `\x1b[4C` is column padding; ansi-line converts it to spaces so the two
    // columns do not run together into `builtdist/index.js`.
    expect(
      splitLogTextLinks('built    dist/index.js', { hasWorkingDir: true }),
    ).toEqual([
      { type: 'text', text: 'built    ' },
      { type: 'file', text: 'dist/index.js', path: 'dist/index.js' },
    ]);
  });
});
