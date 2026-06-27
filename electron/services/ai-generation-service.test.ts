import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrCreateServerMock, queryMock, recordUsageSafeMock } = vi.hoisted(
  () => ({
    getOrCreateServerMock: vi.fn(),
    queryMock: vi.fn(),
    recordUsageSafeMock: vi.fn(),
  }),
);

vi.mock('./agent-backends/opencode/opencode-backend', () => ({
  getOrCreateServer: getOrCreateServerMock,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

vi.mock('./rate-limit-swap-service', () => ({
  rateLimitSwapService: {
    resolveBackend: vi
      .fn()
      .mockResolvedValue({ backend: 'opencode', swapped: false }),
  },
}));

vi.mock('./ai-usage-tracking-service', () => ({
  aiUsageTrackingService: {
    recordUsageSafe: recordUsageSafeMock,
  },
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

async function* createClaudeQueryResponse(message: unknown) {
  yield message;
}

describe('generateText claude-code structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches structured generation through Claude query and records usage', async () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
    };
    const structured = { title: 'fix: provider generation' };
    queryMock.mockReturnValue(
      createClaudeQueryResponse({
        type: 'result',
        structured_output: structured,
        result: 'ignored text fallback',
        modelUsage: { 'claude-sonnet-4': {} },
        usage: {
          input_tokens: 12,
          output_tokens: 7,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      }),
    );

    const result = await generateText({
      backend: 'claude-code',
      model: 'claude-sonnet-4',
      prompt: 'Generate a title',
      thinkingEffort: 'high',
      outputSchema: schema,
      cwd: '/repo/project',
      allowedTools: ['Read', 'Grep'],
      usageContext: {
        feature: 'task-name',
        projectId: 'project-1',
        taskId: 'task-1',
        stepId: null,
      },
    });

    expect(result).toEqual(structured);
    expect(queryMock).toHaveBeenCalledWith({
      prompt: 'Generate a title',
      options: expect.objectContaining({
        allowedTools: ['Read', 'Grep'],
        model: 'claude-sonnet-4',
        effort: 'high',
        cwd: '/repo/project',
        outputFormat: {
          type: 'json_schema',
          schema,
        },
        persistSession: false,
        abortController: expect.any(AbortController),
      }),
    });
    expect(recordUsageSafeMock).toHaveBeenCalledWith({
      context: {
        feature: 'task-name',
        projectId: 'project-1',
        taskId: 'task-1',
        stepId: null,
      },
      backend: 'claude-code',
      model: 'claude-sonnet-4',
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      },
      allowEmptyUsage: true,
    });
  });

  it('returns falsy structured output from Claude instead of text fallback', async () => {
    const schema = {
      type: 'boolean',
    };
    queryMock.mockReturnValue(
      createClaudeQueryResponse({
        type: 'result',
        structured_output: false,
        result: 'incorrect text fallback',
      }),
    );

    const result = await generateText({
      backend: 'claude-code',
      model: 'default',
      prompt: 'Return false',
      outputSchema: schema,
    });

    expect(result).toBe(false);
  });
});

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

  it('records one-off OpenCode requests even when token usage is absent', async () => {
    const client = createMockClient({
      data: {
        info: {},
        parts: [{ type: 'text', text: '{"name":"fix task tracking"}' }],
      },
    });
    getOrCreateServerMock.mockResolvedValue({ client });

    await generateText({
      backend: 'opencode',
      model: 'default',
      prompt: 'Generate task name',
      outputSchema: { type: 'object' },
      usageContext: {
        feature: 'task-name',
        projectId: 'project-1',
        taskId: null,
        stepId: null,
      },
    });

    expect(recordUsageSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'opencode',
        model: 'default',
        allowEmptyUsage: true,
        context: expect.objectContaining({ feature: 'task-name' }),
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          cacheReadTokens: undefined,
          cacheCreationTokens: undefined,
        },
      }),
    );
  });
});

describe('generateText unsupported backends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for unsupported Codex generation when throwOnError is false', async () => {
    await expect(
      generateText({
        backend: 'codex',
        model: 'default',
        prompt: 'Generate task name',
      }),
    ).resolves.toBeNull();
  });

  it('throws for unsupported Codex generation when throwOnError is true', async () => {
    await expect(
      generateText({
        backend: 'codex',
        model: 'default',
        prompt: 'Generate task name',
        throwOnError: true,
      }),
    ).rejects.toThrow(/AI generation failed:/);
  });
});
