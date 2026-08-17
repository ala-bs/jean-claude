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

  it('pins the signed-in user above the current owner', () => {
    expect(
      getOwnerOptions(
        [
          { displayName: 'Zoe', value: 'zoe@example.com' },
          { displayName: 'Me', value: 'me@example.com' },
        ],
        'Current Owner',
        'current@example.com',
        { displayName: 'Me', uniqueName: 'me@example.com' },
      ),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'Me', value: 'me@example.com' },
      { displayName: 'Current Owner', value: 'current@example.com' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
  });

  it('does not duplicate the signed-in user when they are the current owner', () => {
    expect(
      getOwnerOptions(
        [
          { displayName: 'Zoe', value: 'zoe@example.com' },
          { displayName: 'Me', value: 'me@example.com' },
        ],
        'Me',
        undefined,
        { displayName: 'Me', uniqueName: 'me@example.com' },
      ),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'Me', value: 'Me' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
  });

  it('keeps distinct owners that share a display name', () => {
    expect(
      getOwnerOptions(
        [
          { displayName: 'John Smith', value: 'john.smith@example.com' },
          { displayName: 'John Smith', value: 'jsmith@example.com' },
        ],
        undefined,
        undefined,
        { displayName: 'John Smith', uniqueName: 'john.smith@example.com' },
      ),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'John Smith', value: 'john.smith@example.com' },
      { displayName: 'John Smith', value: 'jsmith@example.com' },
    ]);
  });

  it('falls back to the display name when the unique name is blank', () => {
    expect(
      getOwnerOptions([{ displayName: 'Zoe', value: 'zoe@example.com' }], undefined, undefined, {
        displayName: 'Me',
        uniqueName: '  ',
      }),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'Me', value: 'Me' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
  });

  it('ignores an empty current user', () => {
    expect(
      getOwnerOptions([{ displayName: 'Zoe', value: 'zoe@example.com' }], undefined, undefined, {
        displayName: null,
        uniqueName: null,
      }),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
  });

  it('adds the signed-in user when missing from the owners list', () => {
    expect(
      getOwnerOptions([{ displayName: 'Zoe', value: 'zoe@example.com' }], undefined, undefined, {
        displayName: 'Me',
        uniqueName: 'me@example.com',
      }),
    ).toEqual([
      { displayName: 'Unassigned', value: '' },
      { displayName: 'Me', value: 'me@example.com' },
      { displayName: 'Zoe', value: 'zoe@example.com' },
    ]);
  });
});
