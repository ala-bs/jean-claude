import { describe, expect, it } from 'vitest';

import {
  containsAzureDevOpsMention,
  replaceAzureDevOpsMentions,
} from '@/lib/azure-devops-mentions';

describe('replaceAzureDevOpsMentions', () => {
  it('replaces Azure DevOps mention ids with display names', () => {
    const content =
      "@<09C05D5E-5817-4B65-B3F2-07F1C8047F52> For some reason snackbar isn't dismissing";

    expect(
      replaceAzureDevOpsMentions(content, {
        '09c05d5e-5817-4b65-b3f2-07f1c8047f52': 'Patrick Lin',
      }),
    ).toBe("@Patrick Lin For some reason snackbar isn't dismissing");
  });

  it('leaves unknown mentions unchanged', () => {
    const content = '@<09C05D5E-5817-4B65-B3F2-07F1C8047F52> hello';

    expect(replaceAzureDevOpsMentions(content, {})).toBe(content);
  });

  it('escapes markdown syntax in display names', () => {
    const content = '@<09C05D5E-5817-4B65-B3F2-07F1C8047F52> hello';

    expect(
      replaceAzureDevOpsMentions(content, {
        '09c05d5e-5817-4b65-b3f2-07f1c8047f52': 'Pat [Admin]',
      }),
    ).toBe('@Pat \\[Admin\\] hello');
  });

  it('can replace display names without markdown escaping', () => {
    const content = '@<09C05D5E-5817-4B65-B3F2-07F1C8047F52> hello';

    expect(
      replaceAzureDevOpsMentions(
        content,
        {
          '09c05d5e-5817-4b65-b3f2-07f1c8047f52': 'Pat [Admin]',
        },
        { escapeMarkdown: false },
      ),
    ).toBe('@Pat [Admin] hello');
  });

  it('can render known mentions as markdown links', () => {
    const content = '@<09C05D5E-5817-4B65-B3F2-07F1C8047F52> hello';

    expect(
      replaceAzureDevOpsMentions(
        content,
        {
          '09c05d5e-5817-4b65-b3f2-07f1c8047f52': 'Patrick Lin',
        },
        { renderMarkdownLinks: true },
      ),
    ).toBe(
      '[@Patrick Lin](azure-devops-mention:09c05d5e-5817-4b65-b3f2-07f1c8047f52) hello',
    );
  });

  it('replaces Azure DevOps HTML mention anchors with display text', () => {
    const content =
      '<a href="#" data-vss-mention="version:2.0,user-id">@Patrick Lin</a> please check';

    expect(replaceAzureDevOpsMentions(content)).toBe(
      '@Patrick Lin please check',
    );
  });

  it('can render HTML mention anchors as markdown links', () => {
    const content =
      '<a href="#" data-vss-mention="version:2.0,user-id">@Pat [Admin]</a> please check';

    expect(
      replaceAzureDevOpsMentions(content, undefined, {
        renderMarkdownLinks: true,
      }),
    ).toBe(
      '[@Pat \\[Admin\\]](azure-devops-mention:html) please check',
    );
  });
});

describe('containsAzureDevOpsMention', () => {
  it('detects raw Azure DevOps mention tokens', () => {
    expect(
      containsAzureDevOpsMention(
        '@<09C05D5E-5817-4B65-B3F2-07F1C8047F52> hello',
      ),
    ).toBe(true);
  });

  it('detects HTML-escaped Azure DevOps mention tokens', () => {
    expect(
      containsAzureDevOpsMention(
        '@&lt;09C05D5E-5817-4B65-B3F2-07F1C8047F52&gt; hello',
      ),
    ).toBe(true);
  });

  it('detects Azure DevOps HTML mention anchors', () => {
    expect(
      containsAzureDevOpsMention(
        '<a href="#" data-vss-mention="version:2.0,user-id">@Patrick Lin</a> hello',
      ),
    ).toBe(true);
  });
});
