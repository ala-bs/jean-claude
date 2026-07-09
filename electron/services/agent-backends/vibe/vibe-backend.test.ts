import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
} from '../acp-json-rpc-client';
import type {
  AgentBackendConfig,
  AgentTaskContext,
} from '@shared/agent-backend-types';

const mocks = vi.hoisted(() => ({
  getOrCreateVibeAcpServer: vi.fn(),
}));

vi.mock('./vibe-acp-server', () => ({
  getOrCreateVibeAcpServer: mocks.getOrCreateVibeAcpServer,
}));

import { VibeBackend } from './vibe-backend';

describe('VibeBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts a new ACP session and sends prompt blocks', async () => {
    const { backend, client } = createBackend();

    const session = await backend.start(createConfig({ model: 'codestral' }), [
      { type: 'text', text: 'Read this' },
      { type: 'image', data: 'base64-data', mimeType: 'image/png' },
      { type: 'file', filePath: '/tmp/file.txt', filename: 'file.txt' },
    ]);

    expect(session.sessionId).toBe('vibe-session-1');
    expect(session.rootPid).toBe(4321);
    expect(client.request).toHaveBeenCalledWith('session/new', {
      cwd: '/tmp/project',
      mcpServers: [],
    });
    expect(client.request).toHaveBeenCalledWith('session/set_config_option', {
      sessionId: 'vibe-session-1',
      configId: 'model',
      value: 'codestral',
    });
    expect(client.request).toHaveBeenCalledWith('session/set_mode', {
      sessionId: 'vibe-session-1',
      modeId: 'default',
    });
    expect(client.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'vibe-session-1',
      prompt: [
        { type: 'text', text: 'Read this' },
        { type: 'image', mimeType: 'image/png', data: 'base64-data' },
        { type: 'text', text: 'Attached file: /tmp/file.txt' },
      ],
    });

    await expect(session.events[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: { type: 'session-id', sessionId: 'vibe-session-1' },
    });
  });

  it('accepts snake_case session id from new ACP session results', async () => {
    const { backend } = createBackend({
      sessionResult: { session_id: 'vibe-session-1' },
    });

    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);

    expect(session.sessionId).toBe('vibe-session-1');
  });

  it('passes runtime MCP servers to new and loaded ACP sessions', async () => {
    const { backend, client } = createBackend();
    const config = createConfig({
      mcpServers: {
        'jean-claude-mcp': {
          command: 'node',
          args: ['server.js'],
          env: { TOKEN: 'secret' },
        },
        minimal: { command: 'minimal-server' },
      },
    });

    await backend.start(config, [{ type: 'text', text: 'Hello' }]);

    expect(client.request).toHaveBeenCalledWith('session/new', {
      cwd: '/tmp/project',
      mcpServers: [
        {
          name: 'jean-claude-mcp',
          command: process.execPath,
          args: ['server.js'],
          env: [{ name: 'TOKEN', value: 'secret' }],
        },
        {
          name: 'minimal',
          command: '/usr/bin/env',
          args: ['minimal-server'],
          env: [],
        },
      ],
    });

    const loaded = createBackend({ sessionId: 'loaded-session' });
    await loaded.backend.start({ ...config, sessionId: 'existing-session' }, [
      { type: 'text', text: 'Continue' },
    ]);
    expect(loaded.client.request).toHaveBeenCalledWith('session/load', {
      cwd: '/tmp/project',
      sessionId: 'existing-session',
      mcpServers: [
        {
          name: 'jean-claude-mcp',
          command: process.execPath,
          args: ['server.js'],
          env: [{ name: 'TOKEN', value: 'secret' }],
        },
        {
          name: 'minimal',
          command: '/usr/bin/env',
          args: ['minimal-server'],
          env: [],
        },
      ],
    });
  });

  it('loads an existing ACP session', async () => {
    const { backend, client } = createBackend({ sessionId: 'loaded-session' });

    await backend.start(createConfig({ sessionId: 'existing-session' }), [
      { type: 'text', text: 'Continue' },
    ]);

    expect(client.request).toHaveBeenCalledWith('session/load', {
      cwd: '/tmp/project',
      sessionId: 'existing-session',
      mcpServers: [],
    });
    expect(client.request).not.toHaveBeenCalledWith(
      'session/new',
      expect.anything(),
    );
    expect(client.request).toHaveBeenCalledWith('session/prompt', {
      sessionId: 'loaded-session',
      prompt: [{ type: 'text', text: 'Continue' }],
    });
  });

  it('persists matching raw notifications and emits normalized entry events', async () => {
    const { backend, emitNotification, persistRaw } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'msg-1',
          type: 'assistant-message',
          value: 'Hi',
        }),
        rawMessageId: 'raw-1',
      },
    });
    expect(persistRaw).toHaveBeenCalledWith({
      messageIndex: 7,
      backendSessionId: 'vibe-session-1',
      rawData: {
        method: 'session/update',
        params: {
          sessionId: 'vibe-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-1',
            content: { type: 'text', text: 'Hi' },
          },
        },
      },
    });

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'other-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-2',
          content: { type: 'text', text: 'Ignore' },
        },
      },
    });
    expect(persistRaw).toHaveBeenCalledTimes(1);
  });

  it('matches snake_case session ids in session update notifications', async () => {
    const { backend, emitNotification, persistRaw } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    emitNotification({
      method: 'session/update',
      params: {
        session_id: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: 'entry',
        rawMessageId: 'raw-1',
      },
    });
    expect(persistRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        backendSessionId: 'vibe-session-1',
      }),
    );
  });

  it('starts raw message persistence from raw session start index when present', async () => {
    const { backend, emitNotification, persistRaw } = createBackend({
      rawSessionStartIndex: 11,
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });

    await next;
    expect(persistRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        messageIndex: 11,
      }),
    );
  });

  it('forwards normalized entry updates and includes result updates in completion', async () => {
    const { backend, emitNotification, persistRaw, resolvePrompt } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'entry', rawMessageId: 'raw-1' },
    });

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: ' there' },
        },
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'entry-update',
        entry: expect.objectContaining({
          id: 'msg-1',
          type: 'assistant-message',
          value: 'Hi there',
        }),
      },
    });

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'usage_update',
          cost: { amount: 0.5, currency: 'USD' },
          used: 123,
        },
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'result-update',
        result: {
          isError: false,
          cost: { costUsd: 0.5, totalCostUsd: 0.5 },
          usage: { inputTokens: 123, outputTokens: 0 },
        },
      },
    });
    expect(persistRaw).toHaveBeenCalledTimes(3);

    resolvePrompt();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'complete',
        result: {
          isError: false,
          cost: { costUsd: 0.5, totalCostUsd: 0.5 },
          usage: { inputTokens: 123, outputTokens: 0 },
        },
      },
    });
  });

  it('coalesces Vibe text chunk raw rows when raw updates are supported', async () => {
    const updateRaw = vi.fn<NonNullable<AgentTaskContext['updateRaw']>>();
    const { backend, emitNotification, persistRaw, resolvePrompt } = createBackend({
      updateRaw,
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'entry', rawMessageId: 'raw-1' },
    });

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: ' there' },
        },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'entry-update',
        entry: { value: 'Hi there' },
      },
    });

    expect(persistRaw).toHaveBeenCalledTimes(1);
    expect(updateRaw).not.toHaveBeenCalled();

    resolvePrompt();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'complete' },
    });

    expect(updateRaw).toHaveBeenCalledWith({
      rowId: 'raw-1',
      rawData: {
        method: 'session/update',
        params: {
          sessionId: 'vibe-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-1',
            content: { type: 'text', text: 'Hi there' },
          },
        },
      },
    });
  });

  it('emits complete and closes events after session prompt resolves', async () => {
    const { backend, resolvePrompt } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const complete = iterator.next();

    resolvePrompt();

    await expect(complete).resolves.toEqual({
      done: false,
      value: { type: 'complete', result: { isError: false } },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('waits for pending notification processing before completing resolved prompts', async () => {
    let resolvePersist: (rawMessageId: string) => void = () => undefined;
    const persistRaw = vi.fn<AgentTaskContext['persistRaw']>(
      () =>
        new Promise((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const { backend, client, emitNotification, resolvePrompt } = createBackend({
      persistRaw,
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const entry = iterator.next();

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });
    await vi.waitFor(() => expect(persistRaw).toHaveBeenCalledTimes(1));

    resolvePrompt();
    await nextTick();

    expect(client.notificationListeners).toHaveLength(1);
    resolvePersist('raw-1');

    await expect(entry).resolves.toMatchObject({
      done: false,
      value: { type: 'entry', rawMessageId: 'raw-1' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'complete', result: { isError: false } },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(client.notificationListeners).toHaveLength(0);
  });

  it('emits error completion and closes events after session prompt rejects', async () => {
    const { backend, rejectPrompt } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    rejectPrompt(new Error('prompt failed'));

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'error', error: 'prompt failed' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'complete',
        result: { isError: true, text: 'prompt failed' },
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('emits Task 9 ACP permission requests and responds with selected option ids', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const permission = iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: {
          toolCallId: 'tool-1',
          title: 'bash: pnpm test',
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', name: 'Reject' },
        ],
      },
    });

    await expect(permission).resolves.toEqual({
      done: false,
      value: {
        type: 'permission-request',
        request: {
          requestId: 'perm-1',
          toolName: 'bash',
          input: { command: 'pnpm test' },
          description: 'bash: pnpm test',
        },
      },
    });

    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    expect(client.respond).toHaveBeenCalledWith('jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });

    emitRequest({
      id: 42,
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-2',
        toolCall: { title: 'Edit', input: { filePath: '/tmp/file.txt' } },
        options: [{ optionId: 'reject_once', name: 'Reject' }],
      },
    });
    await iterator.next();

    await backend.respondToPermission('vibe-session-1', 'perm-2', {
      behavior: 'deny',
    });

    expect(client.respond).toHaveBeenCalledWith(42, {
      outcome: { outcome: 'selected', optionId: 'reject_once' },
    });
  });

  it('marks user-approved Vibe tool calls as allowed by agent', async () => {
    const { backend, client, emitNotification, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: {
          toolCallId: 'tool-1',
          title: 'bash: pnpm test',
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', name: 'Reject' },
        ],
      },
    });
    await iterator.next();
    client.respond.mockImplementationOnce(() => {
      emitNotification({
        method: 'session/update',
        params: {
          sessionId: 'vibe-session-1',
          update: {
            _meta: { tool_name: 'bash' },
            kind: 'execute',
            rawInput: '{"command":"pnpm test"}',
            title: 'bash: pnpm test',
            toolCallId: 'tool-1',
            sessionUpdate: 'tool_call',
          },
        },
      });
      return Promise.resolve();
    });
    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: 'entry',
        entry: {
          type: 'tool-use',
          name: 'bash',
          permission: { allowedBy: 'agent' },
        },
      },
    });
  });

  it('auto-allows Vibe permission requests from system rules', async () => {
    const { backend, client, emitNotification, emitRequest } = createBackend();
    const session = await backend.start(
      createConfig({
        permissionRules: [
          {
            action: 'allow',
            tool: 'bash',
            pattern: 'pnpm test*',
          },
        ],
      }),
      [{ type: 'text', text: 'Hello' }],
    );
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: {
          toolCallId: 'tool-1',
          kind: 'execute',
          rawInput: '{"command":"pnpm test -- --runInBand"}',
          title: 'bash',
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', name: 'Reject' },
        ],
      },
    });
    await nextTick();

    expect(client.respond).toHaveBeenCalledWith('jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          _meta: { tool_name: 'bash' },
          kind: 'execute',
          rawInput: '{"command":"pnpm test -- --runInBand"}',
          title: 'bash',
          toolCallId: 'tool-1',
          sessionUpdate: 'tool_call',
        },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        type: 'entry',
        entry: {
          type: 'tool-use',
          name: 'bash',
          permission: {
            allowedBy: 'system',
            rule: { tool: 'bash', pattern: 'pnpm test*' },
          },
        },
      },
    });
  });

  it('accepts snake_case session and request ids in permission requests', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const permission = iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        session_id: 'vibe-session-1',
        request_id: 'perm-1',
        tool_call: {
          toolCallId: 'tool-1',
          title: 'bash: pnpm test',
        },
        options: [
          { option_id: 'allow_once', name: 'Allow once' },
          { option_id: 'reject_once', name: 'Reject' },
        ],
      },
    });

    await expect(permission).resolves.toMatchObject({
      done: false,
      value: {
        type: 'permission-request',
        request: {
          requestId: 'perm-1',
          toolName: 'bash',
          input: { command: 'pnpm test' },
        },
      },
    });

    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    expect(client.respond).toHaveBeenCalledWith('jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  it('maps space-delimited bash permission titles to command input', async () => {
    const { backend, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const permission = iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash pnpm test' },
        options: [
          { optionId: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', name: 'Reject' },
        ],
      },
    });

    await expect(permission).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: {
          requestId: 'perm-1',
          toolName: 'bash',
          input: { command: 'pnpm test' },
        },
      },
    });
  });

  it('does not choose negative allow labels for allow responses', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
        options: [
          { optionId: 'reject_once', name: "Don't allow" },
          { optionId: 'allow_once', name: 'Allow once' },
        ],
      },
    });
    await iterator.next();

    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    expect(client.respond).toHaveBeenCalledWith('jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  it('falls back to cancelled when denying without a reject-ish option', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
        options: [{ optionId: 'allow_once', name: 'Allow once' }],
      },
    });
    await iterator.next();

    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'deny',
    });

    expect(client.respond).toHaveBeenCalledWith('jsonrpc-1', {
      outcome: { outcome: 'cancelled' },
    });
  });

  it('does not send duplicate permission responses when respondToPermission is called concurrently', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
        options: [
          { optionId: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', name: 'Reject' },
        ],
      },
    });
    await iterator.next();

    const first = backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });
    const second = backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(
      'Vibe permission response already in flight',
    );
    expect(client.respond).toHaveBeenCalledTimes(1);
    expect(client.respond).toHaveBeenCalledWith('jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  it('keeps pending permission available for retry when ACP response fails', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
        options: [
          { optionId: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', name: 'Reject' },
        ],
      },
    });
    await iterator.next();

    client.respond.mockRejectedValueOnce(new Error('write failed'));
    await expect(
      backend.respondToPermission('vibe-session-1', 'perm-1', {
        behavior: 'allow',
      }),
    ).rejects.toThrow('write failed');

    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    expect(client.respond).toHaveBeenCalledTimes(2);
    expect(client.respond).toHaveBeenNthCalledWith(1, 'jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(client.respond).toHaveBeenNthCalledWith(2, 'jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
  });

  it('rejects duplicate incoming permission request ids without replacing pending request', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
        options: [{ optionId: 'allow_once', name: 'Allow once' }],
      },
    });
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-2',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-2', title: 'bash: pnpm lint' },
        options: [{ optionId: 'allow_second', name: 'Allow once' }],
      },
    });
    await nextTick();

    expect(client.respondError).toHaveBeenCalledWith('jsonrpc-2', {
      code: -32000,
      message: 'Duplicate Vibe permission request: perm-1',
    });

    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    expect(client.respond).toHaveBeenCalledWith('jsonrpc-1', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });
    expect(client.respond).not.toHaveBeenCalledWith(
      'jsonrpc-2',
      expect.anything(),
    );
  });

  it('responds to pending permissions using original session client after ACP server restart', async () => {
    const originalClient = createFakeClient('vibe-session-1');
    const restartedClient = createFakeClient('restarted-session');
    const { backend, emitRequest } = createBackend({ client: originalClient });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-original',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { title: 'bash: pnpm test' },
        options: [{ optionId: 'allow-once', kind: 'allow' }],
      },
    });
    await iterator.next();
    mocks.getOrCreateVibeAcpServer.mockResolvedValue({
      client: restartedClient,
      rootPid: 9999,
    });

    await backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    expect(originalClient.respond).toHaveBeenCalledWith('jsonrpc-original', {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(restartedClient.respond).not.toHaveBeenCalled();
  });

  it('sets mode using original session client after ACP server restart', async () => {
    const originalClient = createFakeClient('vibe-session-1');
    const restartedClient = createFakeClient('restarted-session');
    const { backend } = createBackend({ client: originalClient });
    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);
    mocks.getOrCreateVibeAcpServer.mockResolvedValue({
      client: restartedClient,
      rootPid: 9999,
    });

    await backend.setMode('vibe-session-1', 'auto');

    expect(originalClient.request).toHaveBeenCalledWith('session/set_mode', {
      sessionId: 'vibe-session-1',
      modeId: 'auto-approve',
    });
    expect(restartedClient.request).not.toHaveBeenCalledWith(
      'session/set_mode',
      expect.anything(),
    );
  });

  it('cancels pending permission requests on stop', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-perm',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { title: 'bash: pnpm test' },
        options: [{ optionId: 'allow', kind: 'allow' }],
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'permission-request' },
    });

    await backend.stop('vibe-session-1');

    expect(client.respond).toHaveBeenCalledWith('jsonrpc-perm', {
      outcome: { outcome: 'cancelled' },
    });
    expect(client.notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: 'vibe-session-1',
    });
  });

  it('does not send cancelled for in-flight permission responses during stop', async () => {
    let resolveRespond: () => void = () => undefined;
    const { backend, client, emitRequest } = createBackend();
    client.respond.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRespond = resolve;
        }),
    );
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-perm',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
        options: [
          { optionId: 'allow_once', name: 'Allow once' },
          { optionId: 'reject_once', name: 'Reject' },
        ],
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'permission-request' },
    });

    const response = backend.respondToPermission('vibe-session-1', 'perm-1', {
      behavior: 'allow',
    });

    expect(client.respond).toHaveBeenCalledTimes(1);
    expect(client.respond).toHaveBeenCalledWith('jsonrpc-perm', {
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    });

    await backend.stop('vibe-session-1');

    expect(client.respond).toHaveBeenCalledTimes(1);
    expect(client.respond).not.toHaveBeenCalledWith('jsonrpc-perm', {
      outcome: { outcome: 'cancelled' },
    });

    resolveRespond();
    await expect(response).resolves.toBeUndefined();
    expect(client.respond).toHaveBeenCalledTimes(1);
  });

  it('cancels pending permission requests when prompt completes', async () => {
    const { backend, client, emitRequest, resolvePrompt } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitRequest({
      id: 'jsonrpc-perm',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { toolCallId: 'tool-1', title: 'bash: pnpm test' },
        options: [{ optionId: 'allow_once', name: 'Allow once' }],
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'permission-request' },
    });

    resolvePrompt();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'complete', result: { isError: false } },
    });
    await vi.waitFor(() =>
      expect(client.respond).toHaveBeenCalledWith('jsonrpc-perm', {
        outcome: { outcome: 'cancelled' },
      }),
    );
  });

  it('responds with errors for unknown ACP requests', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);

    emitRequest({
      id: 'unknown-1',
      method: 'unknown/method',
      params: { sessionId: 'vibe-session-1' },
    });
    await nextTick();

    expect(client.respondError).toHaveBeenCalledWith('unknown-1', {
      code: -32601,
      message: 'Method not found',
    });
  });

  it('uses one shared ACP request router for multiple Vibe sessions', async () => {
    const client = createFakeClient(['vibe-session-1', 'vibe-session-2']);
    const first = createBackend({ client });
    await first.backend.start(createConfig(), [{ type: 'text', text: 'One' }]);
    const second = createBackend({ client });
    await second.backend.start(createConfig(), [{ type: 'text', text: 'Two' }]);

    expect(client.requestListeners).toHaveLength(1);

    first.emitRequest({
      id: 'unknown-shared',
      method: 'unknown/method',
      params: {},
    });
    await nextTick();

    expect(client.respondError).toHaveBeenCalledTimes(1);
    expect(client.respondError).toHaveBeenCalledWith('unknown-shared', {
      code: -32601,
      message: 'Method not found',
    });
  });

  it('routes permission requests immediately while notification persistence is blocked and stop cancels them', async () => {
    let resolvePersist: (rawMessageId: string) => void = () => undefined;
    const persistRaw = vi.fn<AgentTaskContext['persistRaw']>(
      () =>
        new Promise((resolve) => {
          resolvePersist = resolve;
        }),
    );
    const { backend, client, emitNotification, emitRequest } = createBackend({
      persistRaw,
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Hi' },
        },
      },
    });
    await vi.waitFor(() => expect(persistRaw).toHaveBeenCalledTimes(1));

    emitRequest({
      id: 'perm-while-blocked',
      method: 'session/request_permission',
      params: {
        sessionId: 'vibe-session-1',
        requestId: 'perm-1',
        toolCall: { title: 'bash: pnpm test' },
        options: [{ optionId: 'allow', kind: 'allow' }],
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'permission-request' },
    });

    await backend.stop('vibe-session-1');

    expect(client.respond).toHaveBeenCalledWith('perm-while-blocked', {
      outcome: { outcome: 'cancelled' },
    });
    resolvePersist('raw-1');
  });

  it('responds once for stale session id ACP requests', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);

    emitRequest({
      id: 'stale-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'missing-session',
        requestId: 'perm-1',
      },
    });
    await nextTick();

    expect(client.respondError).toHaveBeenCalledTimes(1);
    expect(client.respondError).toHaveBeenCalledWith('stale-1', {
      code: -32000,
      message: 'Unknown Vibe session',
    });
  });

  it('cancels, unsubscribes, closes events, and ignores cancel failures on stop', async () => {
    const { backend, client, emitNotification } = createBackend();
    client.notify.mockRejectedValueOnce(new Error('cancel failed'));
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    await backend.stop('vibe-session-1');

    expect(client.notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: 'vibe-session-1',
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    emitNotification({
      method: 'session/update',
      params: {
        sessionId: 'vibe-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg-1',
          content: { type: 'text', text: 'Late' },
        },
      },
    });
    expect(client.notificationListeners).toHaveLength(0);
  });

  it('sends set_mode for active sessions', async () => {
    const { backend, client } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);

    await backend.setMode('vibe-session-1', 'auto');

    expect(client.request).toHaveBeenLastCalledWith('session/set_mode', {
      sessionId: 'vibe-session-1',
      modeId: 'auto-approve',
    });
  });

  it('stops active sessions during dispose', async () => {
    const { backend, client } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    await backend.dispose();

    expect(client.notify).toHaveBeenCalledWith('session/cancel', {
      sessionId: 'vibe-session-1',
    });
    expect(client.notificationListeners).toHaveLength(0);
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

function createBackend(
  options: {
    sessionId?: string;
    rootPid?: number;
    persistRaw?: AgentTaskContext['persistRaw'];
    updateRaw?: AgentTaskContext['updateRaw'];
    rawSessionStartIndex?: number;
    sessionResult?: unknown;
    client?: ReturnType<typeof createFakeClient>;
  } = {},
) {
  const client =
    options.client ??
    createFakeClient(options.sessionId ?? 'vibe-session-1', options.sessionResult);
  mocks.getOrCreateVibeAcpServer.mockResolvedValue({
    client,
    rootPid: options.rootPid ?? 4321,
  });
  let rawId = 0;
  const persistRaw =
    options.persistRaw ??
    vi.fn<AgentTaskContext['persistRaw']>(async () => {
      rawId += 1;
      return `raw-${rawId}`;
    });
  const backend = new VibeBackend({
    taskId: 'task-1',
    sessionStartIndex: 7,
    rawSessionStartIndex: options.rawSessionStartIndex,
    persistRaw,
    updateRaw: options.updateRaw,
  });

  return {
    backend,
    client,
    persistRaw,
    resolvePrompt: client.resolvePrompt,
    rejectPrompt: client.rejectPrompt,
    emitNotification: (notification: AcpJsonRpcNotification) => {
      for (const listener of [...client.notificationListeners]) {
        listener(notification);
      }
    },
    emitRequest: (request: AcpJsonRpcRequest) => {
      for (const listener of [...client.requestListeners]) {
        listener(request);
      }
    },
  };
}

function createFakeClient(
  sessionIds: string | string[],
  sessionResult?: unknown,
) {
  const pendingSessionIds = Array.isArray(sessionIds)
    ? [...sessionIds]
    : [sessionIds];
  const notificationListeners: Array<(message: AcpJsonRpcNotification) => void> =
    [];
  const requestListeners: Array<(message: AcpJsonRpcRequest) => void> = [];
  let resolvePrompt: () => void = () => undefined;
  let rejectPrompt: (error: Error) => void = () => undefined;
  const promptPromise = new Promise<void>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  return {
    notificationListeners,
    requestListeners,
    request: vi.fn((method: string) => {
      if (method === 'session/new' || method === 'session/load') {
        if (sessionResult !== undefined) return Promise.resolve(sessionResult);
        return Promise.resolve({
          sessionId: pendingSessionIds.shift() ?? pendingSessionIds[0],
        });
      }
      if (method === 'session/prompt') {
        return promptPromise;
      }
      return Promise.resolve({});
    }),
    notify: vi.fn(() => Promise.resolve()),
    respond: vi.fn(() => Promise.resolve()),
    respondError: vi.fn(() => Promise.resolve()),
    resolvePrompt,
    rejectPrompt,
    onNotification: vi.fn(
      (listener: (message: AcpJsonRpcNotification) => void) => {
        notificationListeners.push(listener);
        return () => {
          const index = notificationListeners.indexOf(listener);
          if (index >= 0) notificationListeners.splice(index, 1);
        };
      },
    ),
    onRequest: vi.fn((listener: (message: AcpJsonRpcRequest) => void) => {
      requestListeners.push(listener);
      return () => {
        const index = requestListeners.indexOf(listener);
        if (index >= 0) requestListeners.splice(index, 1);
      };
    }),
  };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createConfig(
  overrides: Partial<AgentBackendConfig> = {},
): AgentBackendConfig {
  return {
    type: 'vibe',
    cwd: '/tmp/project',
    interactionMode: 'ask',
    ...overrides,
  };
}
