import { describe, expect, it } from 'vitest';

import type { DisplayMessage } from '../message-merger';
import type { NormalizedEntry } from '@shared/normalized-message-v2';

import {
  getFileChangeToolEntries,
  getLongAssistantMessages,
  getResultDisplayTokenCount,
  getRunningActivity,
} from './index';

function assistantMessage(id: string, value: string): DisplayMessage {
  return {
    kind: 'entry',
    entry: {
      id,
      date: '2026-07-12T11:06:07.464Z',
      type: 'assistant-message',
      value,
    } as NormalizedEntry,
  };
}

describe('getRunningActivity recent messages', () => {
  const longText = 'a'.repeat(400);

  it('previews the latest assistant message by default', () => {
    const activity = getRunningActivity([assistantMessage('m1', longText)]);
    expect(activity.recentMessages).toEqual([
      { kind: 'text', text: `${'a'.repeat(100)}...` },
    ]);
  });

  it('omits assistant messages already rendered in full above the summary', () => {
    const childMessages = [assistantMessage('m1', longText)];
    const shown = getLongAssistantMessages(childMessages);
    expect(shown.map((m) => m.entryId)).toEqual(['m1']);

    const activity = getRunningActivity(
      childMessages,
      new Set(shown.map((m) => m.entryId)),
    );
    // Falls back to the placeholder rather than duplicating the shown text
    expect(activity.recentMessages).toEqual([
      { kind: 'text', text: 'Working...' },
    ]);
  });
});

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
