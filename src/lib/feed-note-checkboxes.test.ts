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
