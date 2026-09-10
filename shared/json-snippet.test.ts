import { describe, expect, it } from 'vitest';

import {
  describeJson,
  describeJsonBlockProp,
  detectJson,
  formatJsonSize,
  MAX_JSON_LENGTH,
  planJsonPasteInsertion,
  summarizeJsonText,
} from './json-snippet';

describe('detectJson', () => {
  it('detects a JSON object and stores it compactly', () => {
    const result = detectJson('{ "name": "jean", "tags": ["a", "b"] }');

    expect(result).not.toBeNull();
    expect(result?.kind).toBe('object');
    expect(result?.entryCount).toBe(2);
    expect(result?.json).toBe('{"name":"jean","tags":["a","b"]}');
    expect(result?.preview).toBe('name, tags');
  });

  it('detects a JSON array', () => {
    const result = detectJson('[{"id":1},{"id":2},{"id":3}]');

    expect(result?.kind).toBe('array');
    expect(result?.entryCount).toBe(3);
  });

  it('ignores plain text, scalars and invalid JSON', () => {
    expect(detectJson('just some note text here, nothing json')).toBeNull();
    expect(detectJson('"a fairly long quoted string value"')).toBeNull();
    expect(detectJson('1234567890123456789012345')).toBeNull();
    expect(detectJson('{ this is not really json at all }')).toBeNull();
  });

  it('ignores tiny payloads so short text is never hijacked', () => {
    expect(detectJson('{"a":1}')).toBeNull();
  });

  it('ignores payloads above the size cap', () => {
    const huge = JSON.stringify({ blob: 'x'.repeat(MAX_JSON_LENGTH) });
    expect(huge.length).toBeGreaterThan(MAX_JSON_LENGTH);
    expect(detectJson(huge)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(detectJson('\n  {"alpha": 1, "beta": 2}\n ')).not.toBeNull();
  });

  it('truncates long previews with an ellipsis', () => {
    const result = detectJson(
      JSON.stringify(Object.fromEntries([...Array(30).keys()].map((i) => [`key${i}`, i]))),
    );

    expect(result?.preview).toHaveLength(80);
    expect(result?.preview.endsWith('…')).toBe(true);
  });
});

describe('describeJson', () => {
  it('pluralizes based on kind and count', () => {
    expect(describeJson({ kind: 'object', entryCount: 1, preview: '' })).toBe(
      'JSON object · 1 key',
    );
    expect(describeJson({ kind: 'object', entryCount: 4, preview: '' })).toBe(
      'JSON object · 4 keys',
    );
    expect(describeJson({ kind: 'array', entryCount: 1, preview: '' })).toBe(
      'JSON array · 1 item',
    );
    expect(describeJson({ kind: 'array', entryCount: 9, preview: '' })).toBe(
      'JSON array · 9 items',
    );
  });
});

describe('summarizeJsonText', () => {
  it('summarizes stored JSON and rejects anything else', () => {
    expect(summarizeJsonText('{"a":1,"b":2}')).toMatchObject({
      kind: 'object',
      entryCount: 2,
    });
    expect(summarizeJsonText('not json')).toBeNull();
    expect(summarizeJsonText('"scalar"')).toBeNull();
    expect(summarizeJsonText(undefined)).toBeNull();
    expect(summarizeJsonText(42)).toBeNull();
  });
});

describe('describeJsonBlockProp', () => {
  it('falls back to a generic label for missing or broken payloads', () => {
    expect(describeJsonBlockProp('{"a":1,"b":2,"c":3}')).toBe(
      '{ } JSON object · 3 keys',
    );
    expect(describeJsonBlockProp('[1,2]')).toBe('{ } JSON array · 2 items');
    expect(describeJsonBlockProp('broken')).toBe('{ } JSON');
    expect(describeJsonBlockProp(undefined)).toBe('{ } JSON');
  });
});

describe('planJsonPasteInsertion', () => {
  const text = (value: string) => [{ type: 'text', text: value }];

  it('replaces a genuinely empty paragraph', () => {
    expect(
      planJsonPasteInsertion({
        block: { type: 'paragraph', content: [] },
        hasSelectedText: false,
      }),
    ).toBe('replace');
    expect(
      planJsonPasteInsertion({
        block: { type: 'paragraph', content: text('   ') },
        hasSelectedText: false,
      }),
    ).toBe('replace');
  });

  it('never drops a block that still holds content', () => {
    expect(
      planJsonPasteInsertion({
        block: { type: 'paragraph', content: text('notes') },
        hasSelectedText: false,
      }),
    ).toBe('after');

    // Multi-segment content whose first segment is blank.
    expect(
      planJsonPasteInsertion({
        block: {
          type: 'paragraph',
          content: [...text('  '), ...text('hello')],
        },
        hasSelectedText: false,
      }),
    ).toBe('after');

    // A link has no top-level `text` — it must not read as empty.
    expect(
      planJsonPasteInsertion({
        block: {
          type: 'paragraph',
          content: [{ type: 'link', href: 'https://x.dev', content: text('x') }],
        },
        hasSelectedText: false,
      }),
    ).toBe('after');
  });

  it('never drops non-inline blocks whose payload lives in props', () => {
    for (const type of ['image', 'table', 'jsonSnippet']) {
      expect(
        planJsonPasteInsertion({
          block: { type, content: undefined },
          hasSelectedText: false,
        }),
      ).toBe('after');
    }
  });

  it('never drops an empty parent that still has children', () => {
    expect(
      planJsonPasteInsertion({
        block: {
          type: 'bulletListItem',
          content: [],
          children: [{ type: 'paragraph' }],
        },
        hasSelectedText: false,
      }),
    ).toBe('after');
  });

  it('declines to intercept code blocks and selection replacement', () => {
    expect(
      planJsonPasteInsertion({
        block: { type: 'codeBlock', content: text('') },
        hasSelectedText: false,
      }),
    ).toBeNull();
    expect(
      planJsonPasteInsertion({
        block: { type: 'paragraph', content: text('picked') },
        hasSelectedText: true,
      }),
    ).toBeNull();
  });
});

describe('formatJsonSize', () => {
  it('formats bytes and kilobytes', () => {
    expect(formatJsonSize(512)).toBe('512 B');
    expect(formatJsonSize(2048)).toBe('2.0 KB');
  });
});
