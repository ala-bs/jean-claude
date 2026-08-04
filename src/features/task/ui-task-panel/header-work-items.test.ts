// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import { splitHeaderWorkItems } from '.';

describe('splitHeaderWorkItems', () => {
  it('shows every work item when at or below the cap', () => {
    expect(splitHeaderWorkItems(['1', '2', '3'])).toEqual({
      visible: ['1', '2', '3'],
      hiddenCount: 0,
    });
  });

  it('caps visible chips and reports the overflow count', () => {
    expect(splitHeaderWorkItems(['1', '2', '3', '4', '5'])).toEqual({
      visible: ['1', '2', '3'],
      hiddenCount: 2,
    });
  });

  it('handles an empty list', () => {
    expect(splitHeaderWorkItems([])).toEqual({ visible: [], hiddenCount: 0 });
  });
});
