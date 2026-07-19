import { describe, expect, it } from 'vitest';

import { getWorkItemSummaryExcerpt } from '@shared/work-item-summary';

import { canShowWorkItemSummary } from './work-item-summary';

describe('canShowWorkItemSummary', () => {
  it('requires complete local project and Azure identity', () => {
    expect(
      canShowWorkItemSummary({
        projectId: 'project-1',
        providerId: 'provider-1',
        projectName: 'Azure Project',
        workItemId: 42,
      }),
    ).toBe(true);
    expect(
      canShowWorkItemSummary({
        projectId: null,
        providerId: 'provider-1',
        projectName: 'Azure Project',
        workItemId: 42,
      }),
    ).toBe(false);
  });
});

describe('getWorkItemSummaryExcerpt', () => {
  it('returns first prose sentence after non-text Markdown', () => {
    expect(
      getWorkItemSummaryExcerpt(`
# Checkout flow

![Screenshot](checkout.png)

\`\`\`mermaid
flowchart LR
  Cart --> Payment
\`\`\`

<img src="another.png" />

**Saved-card payments fail** across browsers. Customers can still use a new card.
`),
    ).toBe('Saved-card payments fail across browsers.');
  });

  it('supports lists, links, inline code, and collapsed whitespace', () => {
    expect(
      getWorkItemSummaryExcerpt(
        '- Retry [`POST /orders`](https://example.test) only  once\n  after a timeout',
      ),
    ).toBe('Retry POST /orders only once after a timeout');
  });

  it('does not end the excerpt at a common abbreviation', () => {
    expect(
      getWorkItemSummaryExcerpt(
        'Use e.g. Visa when reproducing checkout failures. Then retry.',
      ),
    ).toBe('Use e.g. Visa when reproducing checkout failures.');
    expect(
      getWorkItemSummaryExcerpt(
        'Use Visa, etc. when reproducing checkout failures. Then retry.',
      ),
    ).toBe('Use Visa, etc. when reproducing checkout failures.');
    expect(
      getWorkItemSummaryExcerpt(
        'The U.S. checkout flow fails for saved cards. Then retry.',
      ),
    ).toBe('The U.S. checkout flow fails for saved cards.');
    expect(
      getWorkItemSummaryExcerpt(
        'Service is available in the U.S. Customers can retry.',
      ),
    ).toBe('Service is available in the U.S.');
    expect(
      getWorkItemSummaryExcerpt('Supported cards include Visa, etc. Retry later.'),
    ).toBe('Supported cards include Visa, etc.');
  });

  it('skips ASCII and other fenced code', () => {
    expect(
      getWorkItemSummaryExcerpt(
        '~~~text\nClient -> API\n~~~\n\n## Behavior\nActual user-facing context',
      ),
    ).toBe('Actual user-facing context');
  });

  it('skips indented CommonMark code', () => {
    expect(
      getWorkItemSummaryExcerpt(
        '    const hidden = "not prose";\n\nVisible after indented code. More context.',
      ),
    ).toBe('Visible after indented code.');
  });

  it('skips same-line HTML containers, scripts, styles, lists, and headings', () => {
    expect(
      getWorkItemSummaryExcerpt(`
<p>Hidden paragraph.</p>
<script>window.alert('Hidden script.')</script>
<style>.hidden { display: none; }</style>
<pre>Hidden preformatted text.</pre>
<ul><li>Hidden list item.</li></ul>
<h2>Hidden heading.</h2>
<custom-card>Hidden custom element.</custom-card>
<img src="hidden.png" />

Visible Markdown sentence. Another sentence.
`),
    ).toBe('Visible Markdown sentence.');
  });

  it('skips multiline HTML blocks and comments before following Markdown', () => {
    expect(
      getWorkItemSummaryExcerpt(`
<!--
Hidden comment sentence.
-->
<section class="hidden">
  <p>Hidden nested paragraph.</p>
</section>
<div>
Hidden div content.
</div>

Next meaningful Markdown sentence. More context.
`),
    ).toBe('Next meaningful Markdown sentence.');
  });

  it('uses Markdown following an HTML block', () => {
    expect(
      getWorkItemSummaryExcerpt(
        '<aside>Hidden aside.</aside>\n\nVisible Markdown after the block. More context.',
      ),
    ).toBe('Visible Markdown after the block.');
  });

  it('omits inline HTML tags while preserving sibling text', () => {
    expect(getWorkItemSummaryExcerpt('<kbd>Cmd</kbd> opens search')).toBe(
      'Cmd opens search',
    );
    expect(getWorkItemSummaryExcerpt('Before <br> after')).toBe('Before after');
  });

  it('skips URL autolinks without hiding following Markdown', () => {
    expect(
      getWorkItemSummaryExcerpt(
        '<https://example.test>\n\nVisible sentence after URL. More context.',
      ),
    ).toBe('Visible sentence after URL.');
  });

  it('skips email autolinks without hiding following Markdown', () => {
    expect(
      getWorkItemSummaryExcerpt(
        '<user@example.com> Visible sentence after email. More context.',
      ),
    ).toBe('Visible sentence after email.');
  });

  it('skips GFM bare URL and email autolinks but preserves link labels', () => {
    expect(
      getWorkItemSummaryExcerpt(
        'https://example.test user@example.com\n\nRead the [checkout guide](https://example.test/guide) before retrying.',
      ),
    ).toBe('Read the checkout guide before retrying.');
  });

  it('skips GFM www autolinks but preserves ordinary www link labels', () => {
    expect(
      getWorkItemSummaryExcerpt(
        'www.example.test\n\nOpen the [www guide](https://example.test/guide) to continue.',
      ),
    ).toBe('Open the www guide to continue.');
  });

  it('caps long excerpts cleanly near 180 characters', () => {
    const excerpt = getWorkItemSummaryExcerpt(
      Array.from({ length: 40 }, (_, index) => `word${index}`).join(' '),
    );

    expect(excerpt).toMatch(/\u2026$/);
    expect(excerpt!.length).toBeLessThanOrEqual(180);
    expect(excerpt).toMatch(/word\d+\u2026$/);
  });

  it('returns null when Markdown has no meaningful prose', () => {
    expect(
      getWorkItemSummaryExcerpt('# Heading\n\n```ts\nconst value = 1;\n```'),
    ).toBeNull();
  });
});
