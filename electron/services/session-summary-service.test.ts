import { describe, expect, it, vi } from 'vitest';

vi.mock('./ai-generation-service', () => ({
  generateText: vi.fn(),
}));

import { buildSummaryGenerationPrompt } from './session-summary-service';

describe('buildSummaryGenerationPrompt', () => {
  it('excludes error result entries from summary history', () => {
    const prompt = buildSummaryGenerationPrompt([
      {
        id: 'msg-1',
        date: '2026-06-13T00:00:00.000Z',
        type: 'assistant-message',
        value: 'Implemented login flow.',
      },
      {
        id: 'msg-2',
        date: '2026-06-13T00:01:00.000Z',
        type: 'result',
        value: 'Task interrupted by user',
        isError: true,
      },
    ]);

    expect(prompt).toContain('Implemented login flow.');
    expect(prompt).not.toContain('Task interrupted by user');
  });
});
