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
import { dirname } from 'node:path';

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
        timeoutMs: 10 * 60 * 1000,
        // The tool options above are backend-specific, and the `summary` role
        // picked this backend: a rate-limit swap must not move it.
        allowRateLimitSwap: false,
      }),
    );
    await expect(readFile(preparedPrompt.transcriptPath!, 'utf-8')).rejects.toThrow();
  });

  it.each([false, true])('has Codex read the spilled transcript instead of inlining it (failure=%s)', async (fail) => {
    const value = `${'a'.repeat(35_000)}IMPORTANT MIDDLE${'z'.repeat(35_000)}`;
    const preparedPrompt = await prepareSummaryGenerationPrompt([{
      id: 'long', date: '2026-06-13T00:00:00.000Z', type: 'assistant-message', value,
    }]);
    if (fail) generateTextMock.mockRejectedValueOnce(new Error('generation failed'));
    else generateTextMock.mockResolvedValueOnce({ summary: 'Complete summary' });
    const result = summarizeNormalizedMessages({
      backend: 'codex', model: 'selected-model', messages: [], preparedPrompt,
    });
    if (fail) await expect(result).rejects.toThrow('generation failed');
    else await expect(result).resolves.toBe('Complete summary');
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'codex', model: 'selected-model', prompt: preparedPrompt.prompt,
      toolPolicy: 'none', allowedTools: [], allowRateLimitSwap: false,
      allowReadOnlyShell: true, cwd: dirname(preparedPrompt.transcriptPath!),
    }));
    // The transcript is read by the model, never inlined, so no history is lost
    // and the prompt stays small no matter how large the step was.
    const { prompt } = generateTextMock.mock.calls[0][0];
    expect(prompt).not.toContain(value);
    expect(prompt).toContain(preparedPrompt.transcriptPath!);
    expect(prompt.length).toBeLessThan(2_000);
    expect(generateTextMock.mock.calls[0][0].allowedToolPatterns).toBeUndefined();
    await expect(readFile(preparedPrompt.transcriptPath!, 'utf-8')).rejects.toThrow();
  });

  it('keeps the prompt tiny even for a transcript far over the Codex input limit', async () => {
    const value = `${'a'.repeat(600_000)}MIDDLE${'z'.repeat(600_000)}`;
    const preparedPrompt = await prepareSummaryGenerationPrompt([{
      id: 'huge', date: '2026-06-13T00:00:00.000Z', type: 'assistant-message', value,
    }]);
    generateTextMock.mockResolvedValueOnce({ summary: 'Full summary' });
    await expect(
      summarizeNormalizedMessages({
        backend: 'codex', model: 'selected-model', messages: [], preparedPrompt,
      }),
    ).resolves.toBe('Full summary');
    const { prompt } = generateTextMock.mock.calls[0][0];
    // 1.2M chars of history, and the prompt never approaches the 1,048,576
    // character ceiling because the transcript is read, not inlined.
    expect(prompt.length).toBeLessThan(2_000);
    expect(prompt).not.toContain('MIDDLE');
    expect(prompt).not.toContain('...[truncated]...');
  });

  it('uses the isolated runner for short Codex histories too', async () => {
    generateTextMock.mockResolvedValueOnce({ summary: 'Summary' });
    await summarizeNormalizedMessages({
      backend: 'codex', model: 'default', messages: [{
        id: 'short', date: '2026-06-13T00:00:00.000Z', type: 'assistant-message', value: 'Done',
      }],
    });
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({ toolPolicy: 'none' }));
  });

  it('rejects model narration instead of injecting it as the summary', async () => {
    generateTextMock.mockResolvedValue(
      'I have already called the StructuredOutput tool at the end of my response above.',
    );

    await expect(
      summarizeNormalizedMessages({
        backend: 'claude-code',
        model: 'default',
        messages: [
          {
            id: 'msg-1',
            date: '2026-06-13T00:00:00.000Z',
            type: 'assistant-message',
            value: 'did the thing',
          },
        ],
      }),
    ).rejects.toThrow('Failed to generate summary from normalized messages');
  });

  it('unwraps a summary returned as a JSON string', async () => {
    generateTextMock.mockResolvedValue(
      JSON.stringify({ summary: 'Generated summary.' }),
    );

    await expect(
      summarizeNormalizedMessages({
        backend: 'claude-code',
        model: 'default',
        messages: [
          {
            id: 'msg-1',
            date: '2026-06-13T00:00:00.000Z',
            type: 'assistant-message',
            value: 'did the thing',
          },
        ],
      }),
    ).resolves.toBe('Generated summary.');
  });

  it('rejects summaries that are too large to inject into a prompt', async () => {
    generateTextMock.mockResolvedValue({ summary: 'x'.repeat(8_001) });

    await expect(
      summarizeNormalizedMessages({
        backend: 'claude-code',
        model: 'default',
        messages: [
          {
            id: 'msg-1',
            date: '2026-06-13T00:00:00.000Z',
            type: 'assistant-message',
            value: 'did the thing',
          },
        ],
      }),
    ).rejects.toThrow('Failed to generate summary from normalized messages');
  });
});
