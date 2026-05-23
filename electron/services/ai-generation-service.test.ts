import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrCreateServerMock } = vi.hoisted(() => ({
  getOrCreateServerMock: vi.fn(),
}));

vi.mock('./agent-backends/opencode/opencode-backend', () => ({
  getOrCreateServer: getOrCreateServerMock,
}));

import { generateText } from './ai-generation-service';

function createMockClient(response: unknown) {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'session-1' } }),
      prompt: vi.fn().mockResolvedValue(response),
      delete: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('generateText opencode structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns native structured output when OpenCode provides it', async () => {
    const structured = {
      title: 'fix: generate squash merge messages',
      body: '',
    };
    const client = createMockClient({
      data: {
        info: { structured },
        parts: [{ type: 'text', text: 'ignored text fallback' }],
      },
    });
    getOrCreateServerMock.mockResolvedValue({ client });

    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
    };

    const result = await generateText({
      backend: 'opencode',
      model: 'default',
      prompt: 'Generate message',
      outputSchema: schema,
    });

    expect(result).toEqual(structured);
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        format: {
          type: 'json_schema',
          schema,
          retryCount: 1,
        },
      }),
    );
  });

  it('falls back to parsing text JSON when structured output is absent', async () => {
    const client = createMockClient({
      data: {
        info: {},
        parts: [
          {
            type: 'text',
            text: '{"title":"fix: recover opencode output","body":"- Use text fallback"}',
          },
        ],
      },
    });
    getOrCreateServerMock.mockResolvedValue({ client });

    const result = await generateText({
      backend: 'opencode',
      model: 'default',
      prompt: 'Generate message',
      outputSchema: { type: 'object' },
    });

    expect(result).toEqual({
      title: 'fix: recover opencode output',
      body: '- Use text fallback',
    });
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: [
          expect.objectContaining({
            text: expect.stringContaining(
              'Respond with ONLY a valid JSON object matching this schema',
            ),
          }),
        ],
      }),
    );
  });
});
