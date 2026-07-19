import { describe, expect, it } from 'vitest';

import { isSafeMermaidSource } from './mermaid-diagram';

describe('isSafeMermaidSource', () => {
  it('allows directive words inside node labels', () => {
    expect(
      isSafeMermaidSource(
        'flowchart LR\nA[Click Save] --> B[href value shown as text]',
      ),
    ).toBe(true);
  });

  it('rejects click and href at statement boundaries', () => {
    expect(
      isSafeMermaidSource(
        'flowchart LR; click A "https://example.test"',
      ),
    ).toBe(false);
    expect(
      isSafeMermaidSource('flowchart LR\nhref A "https://example.test"'),
    ).toBe(false);
  });
});
