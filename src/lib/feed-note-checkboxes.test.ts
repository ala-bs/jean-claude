import { describe, expect, it } from 'vitest';

import {
  getFeedNoteTaskIndex,
  markdownToBlockNoteJson,
  parseFeedNoteLines,
  toggleFeedNoteContentCheckbox,
} from './feed-note-checkboxes';

describe('feed-note-checkboxes', () => {
  it('parses markdown task list lines', () => {
    expect(parseFeedNoteLines('Title\n- [ ] Open\n  - [x] Done')).toEqual([
      { lineIndex: 0, raw: 'Title', text: 'Title' },
      {
        lineIndex: 1,
        raw: '- [ ] Open',
        text: 'Open',
        task: { checked: false },
      },
      {
        lineIndex: 2,
        raw: '  - [x] Done',
        text: 'Done',
        task: { checked: true },
      },
    ]);
  });

  it('finds the task index for a markdown line', () => {
    expect(
      getFeedNoteTaskIndex({
        content: 'Title\n- [ ] One\nBody\n- [x] Two',
        lineIndex: 3,
      }),
    ).toBe(1);
  });

  it('converts markdown task lines to BlockNote JSON', () => {
    expect(JSON.parse(markdownToBlockNoteJson('- [x] Done'))[0]).toMatchObject({
      type: 'checkListItem',
      props: { checked: true },
      content: 'Done',
    });
  });

  it('preserves common markdown block types when converting', () => {
    expect(
      JSON.parse(
        markdownToBlockNoteJson('# Heading\n- Bullet\n1. Step\n> Quote'),
      ),
    ).toMatchObject([
      { type: 'heading', props: { level: 1 }, content: 'Heading' },
      { type: 'bulletListItem', content: 'Bullet' },
      { type: 'numberedListItem', content: 'Step' },
      { type: 'quote', content: 'Quote' },
    ]);
  });

  it('converts two-space indented list items to nested BlockNote children', () => {
    expect(
      JSON.parse(
        markdownToBlockNoteJson('- Parent\n  - Child\n    - Grandchild'),
      ),
    ).toMatchObject([
      {
        type: 'bulletListItem',
        content: 'Parent',
        children: [
          {
            type: 'bulletListItem',
            content: 'Child',
            children: [{ type: 'bulletListItem', content: 'Grandchild' }],
          },
        ],
      },
    ]);
  });

  it('converts indented checklist items to nested BlockNote children', () => {
    expect(
      JSON.parse(markdownToBlockNoteJson('- [ ] Parent\n  - [x] Child')),
    ).toMatchObject([
      {
        type: 'checkListItem',
        props: { checked: false },
        content: 'Parent',
        children: [
          {
            type: 'checkListItem',
            props: { checked: true },
            content: 'Child',
          },
        ],
      },
    ]);
  });

  it('preserves leading spaces for non-list lines when converting markdown', () => {
    expect(JSON.parse(markdownToBlockNoteJson('  indented paragraph'))).toEqual(
      [{ type: 'paragraph', content: '  indented paragraph' }],
    );
  });

  it('does not attach indented list items to blank-line paragraphs', () => {
    expect(
      JSON.parse(markdownToBlockNoteJson('- Parent\n\n  - Child')),
    ).toEqual([
      { type: 'bulletListItem', content: 'Parent' },
      { type: 'paragraph', content: '' },
      { type: 'bulletListItem', content: 'Child' },
    ]);
  });

  it('toggles the matching checklist block in BlockNote content', () => {
    const content = JSON.stringify([
      { type: 'paragraph', content: 'Title' },
      { type: 'checkListItem', props: { checked: false }, content: 'One' },
      { type: 'checkListItem', props: { checked: true }, content: 'Two' },
    ]);

    expect(
      JSON.parse(
        toggleFeedNoteContentCheckbox({
          content,
          taskIndex: 1,
          checked: false,
        }),
      )[2].props.checked,
    ).toBe(false);
  });
});
