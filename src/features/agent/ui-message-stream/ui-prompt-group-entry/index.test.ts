import { describe, expect, it } from 'vitest';

import type { DisplayMessage } from '../message-merger';
import type { NormalizedEntry } from '@shared/normalized-message-v2';

import {
  getFileChangeToolEntries,
  getResultDisplayTokenCount,
} from './index';

describe('getResultDisplayTokenCount', () => {
  it('prefers latest context usage over cumulative usage', () => {
    expect(
      getResultDisplayTokenCount({
        usage: { inputTokens: 576_063, outputTokens: 15_548 },
        contextUsage: { inputTokens: 196_919, outputTokens: 2_944 },
      }),
    ).toBe(199_863);
  });

  it('falls back to cumulative usage when context usage is unavailable', () => {
    expect(
      getResultDisplayTokenCount({
        usage: { inputTokens: 12_000, outputTokens: 500 },
      }),
    ).toBe(12_500);
  });
});

describe('getFileChangeToolEntries', () => {
  it('excludes replayed edits from before the follow-up prompt', () => {
    const prompt: NormalizedEntry & { type: 'user-prompt' } = {
      id: 'prompt-2',
      date: '2026-07-12T11:06:07.464Z',
      type: 'user-prompt',
      value: 'Follow up',
    };
    const childMessages: DisplayMessage[] = [
      {
        kind: 'entry',
        entry: {
          id: 'turn-1-edit-replayed',
          date: '2026-07-12T10:57:18.214Z',
          type: 'tool-use',
          toolId: 'call-1',
          name: 'edit',
          input: {
            filePath: 'src/turn-1.ts',
            oldString: 'old',
            newString: 'new',
          },
        },
      },
      {
        kind: 'entry',
        entry: {
          id: 'turn-2-edit',
          date: '2026-07-12T11:07:18.214Z',
          type: 'tool-use',
          toolId: 'call-2',
          name: 'edit',
          input: {
            filePath: 'src/turn-2.ts',
            oldString: 'old',
            newString: 'new',
          },
        },
      },
    ];

    expect(
      getFileChangeToolEntries(childMessages, prompt).map((entry) => entry.id),
    ).toEqual(['turn-2-edit']);
  });

  it('excludes undated edits when the prompt date is known', () => {
    const prompt: NormalizedEntry & { type: 'user-prompt' } = {
      id: 'prompt-2',
      date: '2026-07-12T11:06:07.464Z',
      type: 'user-prompt',
      value: 'Follow up',
    };
    const childMessages: DisplayMessage[] = [
      {
        kind: 'entry',
        entry: {
          id: 'invalid-date-edit',
          date: '',
          type: 'tool-use',
          toolId: 'call-1',
          name: 'edit',
          input: {
            filePath: 'src/unknown-turn.ts',
            oldString: 'old',
            newString: 'new',
          },
        },
      },
    ];

    expect(getFileChangeToolEntries(childMessages, prompt)).toEqual([]);
  });
});
