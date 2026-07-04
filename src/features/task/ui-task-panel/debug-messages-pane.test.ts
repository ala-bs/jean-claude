import { describe, expect, it } from 'vitest';

import { normalizedDataMatchesEntryId } from './debug-messages-pane';

describe('normalizedDataMatchesEntryId', () => {
  it('matches ids inside multi-entry normalized data arrays', () => {
    expect(
      normalizedDataMatchesEntryId(
        [
          { id: 'thinking-1', type: 'thinking' },
          { toolId: 'tool-1', type: 'tool-use' },
        ],
        'tool-1',
      ),
    ).toBe(true);
  });

  it('matches ids on single normalized data objects', () => {
    expect(
      normalizedDataMatchesEntryId({ id: 'entry-1' }, 'entry-1'),
    ).toBe(true);
  });
});
