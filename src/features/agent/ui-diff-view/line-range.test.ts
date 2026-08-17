import { describe, expect, it } from 'vitest';

import { lineRangeKey } from './index';

describe('lineRangeKey', () => {
  it('keeps old and new ranges with the same line numbers distinct', () => {
    expect(lineRangeKey({ start: 42, end: 42, side: 'old' })).not.toBe(
      lineRangeKey({ start: 42, end: 42, side: 'new' }),
    );
  });

  it('defaults missing side to new for existing ranges', () => {
    expect(lineRangeKey({ start: 42, end: 42 })).toBe(
      lineRangeKey({ start: 42, end: 42, side: 'new' }),
    );
  });
});
