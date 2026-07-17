import { describe, expect, it } from 'vitest';

import { getOwnerOptions } from '@/features/feed/ui-work-item-details';

describe('getOwnerOptions', () => {
  it('keeps unassigned and current owner first, then sorted unique owners', () => {
    expect(
      getOwnerOptions(
        [
          { displayName: 'Zoe', value: 'zoe@example.com' },
          { displayName: 'alice', value: 'alice@example.com' },
          { displayName: ' Alice ', value: 'ALICE@example.com' },
          { displayName: 'Current Owner', value: 'current@example.com' },
        ],
        'Current Owner',
        'current@example.com',
      ),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'Current Owner', value: 'current@example.com' },
      { displayName: 'alice', value: 'alice@example.com' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
  });

  it('keeps current owner when absent from project work items', () => {
    expect(
      getOwnerOptions(
        [{ displayName: 'Zoe', value: 'zoe@example.com' }],
        'Current Owner',
      ),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'Current Owner', value: 'Current Owner' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
  });
});
