import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';

import { QuestionContextReminder } from '.';

describe('QuestionContextReminder', () => {
  it('renders Markdown as assistant context', () => {
    const markup = renderToStaticMarkup(
      <RootKeyboardBindings>
        <QuestionContextReminder content="**Current constraint:** keep scope small." />
      </RootKeyboardBindings>,
    );

    expect(markup).toContain('<aside');
    expect(markup).toContain('Context');
    expect(markup).toMatch(/<strong[^>]*>Current constraint:<\/strong>/);
    expect(markup).toContain('keep scope small.');
  });

  it('renders nothing when omitted', () => {
    expect(
      renderToStaticMarkup(<QuestionContextReminder />),
    ).toBe('');
  });
});
