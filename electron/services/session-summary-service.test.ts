import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';

vi.mock('./ai-generation-service', () => ({
  generateText: vi.fn(),
}));

import { generateText } from './ai-generation-service';
import {
  buildSummaryGenerationPrompt,
  prepareSummaryGenerationPrompt,
  summarizeNormalizedMessages,
} from './session-summary-service';

const generateTextMock = vi.mocked(generateText);

describe('buildSummaryGenerationPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('spills oversized transcript to a temporary file', async () => {
    const prompt = await prepareSummaryGenerationPrompt([
      {
        id: 'msg-1',
        date: '2026-06-13T00:00:00.000Z',
        type: 'assistant-message',
        value: 'x'.repeat(70_000),
      },
    ]);

    expect(prompt.transcriptPath).toMatch(/normalized-messages\.md$/);
    expect(prompt.prompt).toContain('too large to inline');
    expect(prompt.prompt).toContain(prompt.transcriptPath);
    expect(prompt.prompt).not.toContain('x'.repeat(10_000));
    await expect(readFile(prompt.transcriptPath!, 'utf-8')).resolves.toContain(
      'x'.repeat(70_000),
    );
    await rm(prompt.transcriptDir!, { force: true, recursive: true });
  });

  it('allows reading spilled transcript during summary generation', async () => {
    generateTextMock.mockResolvedValue({ summary: 'Generated summary.' });
    const preparedPrompt = await prepareSummaryGenerationPrompt([
      {
        id: 'msg-1',
        date: '2026-06-13T00:00:00.000Z',
        type: 'assistant-message',
        value: 'x'.repeat(70_000),
      },
    ]);

    await summarizeNormalizedMessages({
      backend: 'opencode',
      model: 'default',
      messages: [],
      preparedPrompt,
    });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ['Read'],
        allowedToolPatterns: { Read: [preparedPrompt.transcriptPath] },
        prompt: preparedPrompt.prompt,
      }),
    );
    await expect(readFile(preparedPrompt.transcriptPath!, 'utf-8')).rejects.toThrow();
  });
});
