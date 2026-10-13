import { describe, expect, it } from 'vitest';

import type { FeedItem } from '@shared/feed-types';

import { matchesFeedSearch } from './feed-search';

const item = (overrides: Partial<FeedItem> = {}): FeedItem => ({
  id: 'item-1',
  source: 'work-item',
  attention: 'assigned-work-item',
  timestamp: '2026-01-01T00:00:00.000Z',
  projectId: 'project-1',
  projectName: 'Project',
  projectColor: '#fff',
  projectPriority: 'normal',
  title: 'Improve feed search',
  ...overrides,
});

describe('matchesFeedSearch', () => {
  it('matches title case-insensitively and ignores surrounding whitespace', () => {
    expect(matchesFeedSearch(item(), '  FEED SEARCH ')).toBe(true);
  });

  it('matches scalar and grouped work-item IDs', () => {
    expect(matchesFeedSearch(item({ workItemId: 123 }), '123')).toBe(true);
    expect(matchesFeedSearch(item({ workItemIds: ['456', '789'] }), '789')).toBe(
      true,
    );
  });

  it('matches a nested task child', () => {
    expect(
      matchesFeedSearch(
        item({
          source: 'task',
          children: [item({ title: 'Fix deployment', workItemId: 321 })],
        }),
        '321',
      ),
    ).toBe(true);
  });

  it('does not match unrelated fields', () => {
    expect(matchesFeedSearch(item({ projectName: 'Matching project' }), 'matching')).toBe(
      false,
    );
  });
});
