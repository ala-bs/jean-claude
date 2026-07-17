import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { WorkItemTitleParserSetting } from '@shared/work-item-title-parser-types';

import { WorkItemBoardPrimaryHeading } from '@/features/work-item/ui-work-item-board/card-primary-heading';

import { ParsedWorkItemTitle } from '.';

const parserSetting: WorkItemTitleParserSetting = {
  version: 1,
  enabled: true,
  rules: [
    {
      id: 'labels',
      enabled: true,
      pattern: String.raw`\[(?<label>[^\]]+)\]\s*`,
      caseInsensitive: false,
    },
  ],
};

describe('ParsedWorkItemTitle', () => {
  it('renders only raw title when parsing is disabled', () => {
    const markup = renderToStaticMarkup(
      <ParsedWorkItemTitle
        title="[API] Raw title"
        parserSetting={{ ...parserSetting, enabled: false }}
        titleClassName="title-class"
      />,
    );

    expect(markup).toBe(
      '<div class="min-w-0"><span class="title-class">[API] Raw title</span></div>',
    );
  });

  it('renders parsed title and every label in noncompact mode', () => {
    const markup = renderToStaticMarkup(
      <ParsedWorkItemTitle
        title="[API] [Urgent] Repair search"
        parserSetting={parserSetting}
        search="repair"
        titleElement="h3"
      />,
    );

    expect(markup).toMatch(/^<div[^>]*><h3>/);
    expect(markup).toContain('<h3>');
    expect(markup).toContain('<mark');
    expect(markup).toContain('>API</span>');
    expect(markup).toContain('>Urgent</span>');
    expect(markup).not.toContain('Show all extracted labels');
  });

  it('uses phrasing wrappers for editable title content', () => {
    const markup = renderToStaticMarkup(
      <button type="button">
        <ParsedWorkItemTitle
          title="[API] Repair search"
          parserSetting={parserSetting}
          titleElement="h3"
          inline
        />
      </button>,
    );

    expect(markup).toMatch(/^<button[^>]*><span[^>]*><span>/);
    expect(markup).not.toContain('<div');
    expect(markup).not.toContain('<h3');
  });

  it('limits compact labels and exposes a focusable overflow trigger', () => {
    const markup = renderToStaticMarkup(
      <ParsedWorkItemTitle
        title="[One] [Two] [Three] [Four] [Five] [Six] [Seven] Title"
        parserSetting={parserSetting}
        compact
      />,
    );

    expect(markup).toContain('>Five</span>');
    expect(markup).not.toContain('>Six</span>');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('Show all extracted labels: One, Two, Three, Four, Five, Six, Seven');
    expect(markup).toContain('>+2</span>');
  });

  it('renders compact labels outside a supplied primary button', () => {
    const markup = renderToStaticMarkup(
      <ParsedWorkItemTitle
        title="[One] [Two] [Three] [Four] [Five] [Six] Title"
        parserSetting={parserSetting}
        compact
        renderTitle={(title) => <button type="button">{title}</button>}
      />,
    );

    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toMatch(/^<div/);
    expect(markup).toMatch(/<button[^>]*>.*Title<\/span><\/button>/);
    expect(markup).not.toMatch(/<button[^>]*>[\s\S]*tabindex="0"[\s\S]*<\/button>/);
    expect(markup.indexOf('</button>')).toBeLessThan(markup.indexOf('tabindex="0"'));
  });

  it('keeps selection control sibling to parser title button and overflow trigger', () => {
    const markup = renderToStaticMarkup(
      <ParsedWorkItemTitle
        title="[One] [Two] [Three] [Four] [Five] [Six] Title"
        parserSetting={parserSetting}
        compact
        renderTitle={(title) => (
          <WorkItemBoardPrimaryHeading
            selectionControl={<button type="button">Select</button>}
            trailingControl={<span>SP</span>}
            metadata={<span>#123</span>}
            title={title}
            onOpen={() => {}}
          />
        )}
      />,
    );

    const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.indexOf('<button', 1) === -1)).toBe(true);
    expect(markup.lastIndexOf('</button>')).toBeLessThan(markup.indexOf('tabindex="0"'));
  });
});
