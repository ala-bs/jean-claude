import { describe, expect, it } from 'vitest';

import {
  createVibeNormalizationContext,
  normalizeVibeNotification,
} from './normalize-vibe-message-v2';

describe('normalizeVibeNotification', () => {
  it('appends assistant chunks by message id', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-1',
              content: { type: 'text', text: 'Hello' },
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'msg-1',
          type: 'assistant-message',
          value: 'Hello',
        }),
      },
    ]);

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'msg-1',
              content: [
                { type: 'content', content: { type: 'text', text: ' world' } },
              ],
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'msg-1',
          type: 'assistant-message',
          value: 'Hello world',
        }),
      },
    ]);
  });

  it('appends thought chunks by message id', () => {
    const ctx = createVibeNormalizationContext();

    normalizeVibeNotification(
      {
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            session_update: 'agent_thought_chunk',
            messageId: 'thought-1',
            content: { type: 'text', text: 'I should ' },
          },
        },
      },
      ctx,
    );

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              session_update: 'agent_thought_chunk',
              messageId: 'thought-1',
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: 'inspect files' },
                },
              ],
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'thought-1',
          type: 'thinking',
          value: 'I should inspect files',
        }),
      },
    ]);
  });

  it('normalizes tool calls and updates', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              title: 'Bash',
              content: { type: 'text', text: 'pnpm test' },
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'bash',
          input: { command: 'pnpm test', description: 'Bash' },
        }),
      },
    ]);

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              status: 'failed',
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: 'command failed' },
                },
              ],
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'bash',
          result: { content: 'command failed', isError: true },
        }),
      },
    ]);
  });

  it('normalizes sample-shaped bash tool calls from rawInput', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'bash' },
              kind: 'execute',
              status: 'pending',
              title: 'bash',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call',
            },
          },
        },
        ctx,
      ),
    ).toEqual([]);

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'bash' },
              kind: 'execute',
              rawInput:
                '{"command":"ls -la /Users/patricklin/work/tools/jean-claude","timeout":null}',
              status: 'pending',
              title: 'bash: ls -la /Users/patricklin/work/tools/jean-claude',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call',
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'bash',
          input: {
            command: 'ls -la /Users/patricklin/work/tools/jean-claude',
            description: 'bash: ls -la /Users/patricklin/work/tools/jean-claude',
          },
        }),
      },
    ]);

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'bash' },
              content: [
                {
                  content: { type: 'text', text: 'Ran ls -la /Users/patricklin/work/tools/jean-claude' },
                  type: 'content',
                },
              ],
              kind: 'execute',
              rawOutput:
                '{"command":"ls -la /Users/patricklin/work/tools/jean-claude","stdout":"total 1088","stderr":"","exit_code":0}',
              status: 'completed',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call_update',
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'bash',
          result: {
            content: 'total 1088',
            isError: false,
          },
        }),
      },
    ]);
  });

  it('marks Vibe native auto-allowed tool calls as agent permissions', () => {
    const ctx = createVibeNormalizationContext();

    const events = normalizeVibeNotification(
      {
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            _meta: { tool_name: 'bash' },
            kind: 'execute',
            rawInput: '{"command":"pnpm test"}',
            status: 'pending',
            title: 'bash: pnpm test',
            toolCallId: 'tool-1',
            sessionUpdate: 'tool_call',
          },
        },
      },
      ctx,
    );

    expect(events[0]).toMatchObject({
      entry: {
        type: 'tool-use',
        permission: { allowedBy: 'agent' },
      },
    });
  });

  it('marks Vibe native system-rule auto-allows as system permissions', () => {
    const ctx = createVibeNormalizationContext();
    ctx.permissionRules = [
      { tool: 'bash', pattern: 'pnpm *', action: 'allow' },
    ];

    const events = normalizeVibeNotification(
      {
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            _meta: { tool_name: 'bash' },
            kind: 'execute',
            rawInput: '{"command":"pnpm test"}',
            status: 'pending',
            title: 'bash: pnpm test',
            toolCallId: 'tool-1',
            sessionUpdate: 'tool_call',
          },
        },
      },
      ctx,
    );

    expect(events[0]).toMatchObject({
      entry: {
        type: 'tool-use',
        permission: {
          allowedBy: 'system',
          rule: { tool: 'bash', pattern: 'pnpm *' },
        },
      },
    });
  });

  it('marks bash rawOutput returncode failures as errors', () => {
    const ctx = createVibeNormalizationContext();

    normalizeVibeNotification(
      {
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            _meta: { tool_name: 'bash' },
            kind: 'execute',
            rawInput: '{"command":"pnpm missing-script"}',
            status: 'pending',
            title: 'bash: pnpm missing-script',
            toolCallId: 'tool-1',
            sessionUpdate: 'tool_call',
          },
        },
      },
      ctx,
    );

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'bash' },
              content: [
                {
                  content: { type: 'text', text: 'Command failed' },
                  type: 'content',
                },
              ],
              kind: 'execute',
              rawOutput:
                '{"stdout":"","stderr":"ERR_PNPM_NO_SCRIPT Missing script","returncode":1}',
              status: 'completed',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call_update',
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'bash',
          result: {
            content: 'ERR_PNPM_NO_SCRIPT Missing script',
            isError: true,
          },
        }),
      },
    ]);
  });

  it('does not use summary text when bash rawOutput is empty', () => {
    const ctx = createVibeNormalizationContext();

    normalizeVibeNotification(
      {
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            _meta: { tool_name: 'bash' },
            kind: 'execute',
            rawInput: '{"command":"true"}',
            status: 'pending',
            title: 'bash: true',
            toolCallId: 'tool-1',
            sessionUpdate: 'tool_call',
          },
        },
      },
      ctx,
    );

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'bash' },
              content: [
                {
                  content: { type: 'text', text: 'Ran true' },
                  type: 'content',
                },
              ],
              kind: 'execute',
              rawOutput: '{"stdout":"","stderr":"","returncode":0}',
              status: 'completed',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call_update',
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'bash',
          result: { content: '', isError: false },
        }),
      },
    ]);
  });

  it('marks string exit codes as bash errors', () => {
    const ctx = createVibeNormalizationContext();

    normalizeVibeNotification(
      {
        method: 'session/update',
        params: {
          sessionId: 'session-1',
          update: {
            _meta: { tool_name: 'bash' },
            kind: 'execute',
            rawInput: '{"command":"false"}',
            status: 'pending',
            title: 'bash: false',
            toolCallId: 'tool-1',
            sessionUpdate: 'tool_call',
          },
        },
      },
      ctx,
    );

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'bash' },
              kind: 'execute',
              rawOutput: '{"stdout":"","stderr":"failed","returncode":"1"}',
              status: 'completed',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call_update',
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'bash',
          result: { content: 'failed', isError: true },
        }),
      },
    ]);
  });

  it('normalizes sample-shaped read_file calls from rawInput', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'read_file' },
              kind: 'read',
              status: 'pending',
              title: 'read_file',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call',
            },
          },
        },
        ctx,
      ),
    ).toEqual([]);

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'read_file' },
              kind: 'read',
              rawInput:
                '{"file_path":"/Users/patricklin/work/tools/jean-claude/README.md","offset":null,"limit":2000}',
              status: 'pending',
              title: 'Reading /Users/patricklin/work/tools/jean-claude/README.md',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call',
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'read',
          input: { filePath: '/Users/patricklin/work/tools/jean-claude/README.md' },
          result: 'Read from README.md',
        }),
      },
    ]);
  });

  it('does not classify grep calls mentioning README as read calls', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              _meta: { tool_name: 'grep' },
              kind: 'search',
              rawInput: '{"pattern":"README.md"}',
              status: 'pending',
              title: 'Searching README.md',
              toolCallId: 'tool-1',
              sessionUpdate: 'tool_call',
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'tool-1',
          type: 'tool-use',
          toolId: 'tool-1',
          name: 'grep',
          input: { pattern: 'README.md' },
        }),
      },
    ]);
  });

  it('normalizes usage updates', () => {
    const ctx = createVibeNormalizationContext();

    expect(
      normalizeVibeNotification(
        {
          method: 'session/update',
          params: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'usage_update',
              cost: { amount: 0.25, currency: 'USD' },
              used: 42,
            },
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        type: 'result-update',
        result: {
          isError: false,
          cost: { costUsd: 0.25, totalCostUsd: 0.25 },
          usage: { inputTokens: 42, outputTokens: 0 },
        },
      },
    ]);
  });
});
