import { describe, expect, it } from 'vitest';

import { resolveDetailsPaneEscape } from './details-pane-escape';

const base = {
  isDetailsPaneOpen: true,
  workItemStackDepth: 1,
  hasRelatedBugsStory: false,
  isRelatedBugsPanelOpen: false,
};

describe('resolveDetailsPaneEscape', () => {
  it('lets the overlay handle escape when the pane is closed', () => {
    expect(
      resolveDetailsPaneEscape({
        ...base,
        isDetailsPaneOpen: false,
        workItemStackDepth: 0,
      }),
    ).toBe('none');
  });

  it('closes the details pane at the root level', () => {
    expect(resolveDetailsPaneEscape(base)).toBe('close-details-pane');
  });

  it('pops one nested work item instead of closing everything', () => {
    expect(
      resolveDetailsPaneEscape({ ...base, workItemStackDepth: 2 }),
    ).toBe('pop-work-item');
  });

  it('returns to the related bugs list when it was the entry point', () => {
    expect(
      resolveDetailsPaneEscape({
        ...base,
        workItemStackDepth: 2,
        hasRelatedBugsStory: true,
      }),
    ).toBe('back-to-related-bugs');
  });

  it('closes the related bugs panel before the pane', () => {
    expect(
      resolveDetailsPaneEscape({ ...base, isRelatedBugsPanelOpen: true }),
    ).toBe('close-related-bugs');
  });
});
