import { describe, expect, it, vi } from 'vitest';

vi.mock('../index', () => ({
  db: {},
}));

import { formatNormalizedDataForRawId } from './agent-messages';

describe('agent message raw mapping', () => {
  it('keeps multiple normalized entries for one raw message', () => {
    const normalizedData = formatNormalizedDataForRawId([
      JSON.stringify({ type: 'thinking', value: 'Thinking' }),
      JSON.stringify({ type: 'assistant-message', value: 'Answer' }),
    ]);

    expect(normalizedData ? JSON.parse(normalizedData) : null).toEqual([
      { type: 'thinking', value: 'Thinking' },
      { type: 'assistant-message', value: 'Answer' },
    ]);
  });
});
