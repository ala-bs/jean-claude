import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentBackendConfig,
  AgentTaskContext,
} from '@shared/agent-backend-types';

const mocks = vi.hoisted(() => ({
  getOrCreateCodexAppServer: vi.fn(),
}));

vi.mock('./codex-app-server', () => ({
  getOrCreateCodexAppServer: mocks.getOrCreateCodexAppServer,
}));

import { CodexBackend } from './codex-backend';

describe('CodexBackend', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts a new thread when config.sessionId is missing', async () => {
    const { backend, client } = createBackend();

    await backend.start(createConfig(), [
      { type: 'text', text: 'Hello Codex' },
    ]);

    expect(client.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/tmp/project',
      model: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        sandbox_workspace_write: {
          network_access: true,
          writable_roots: expectedPackageManagerCacheRoots(),
        },
      },
      serviceName: 'jean_claude',
    });
  });

  it('turns a command approval server request into a permission event', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Run the tests' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();
    const nextEvent = events.next();

    emitRequest({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        command: 'pnpm test',
        cwd: '/tmp/project',
        reason: 'Run the test suite',
      },
    });

    await expect(nextEvent).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: {
          requestId: '42',
          toolName: 'bash',
          input: { command: 'pnpm test' },
          description: 'Run the test suite',
        },
      },
    });

    await backend.respondToPermission(session.sessionId, '42', {
      behavior: 'allow',
      allowMode: 'session',
    });
    expect(client.respond).toHaveBeenCalledWith(42, {
      decision: 'acceptForSession',
    });
  });

  it('turns a Codex user-input request into a question event and responds with answer arrays', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me a question' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();
    const nextEvent = events.next();

    emitRequest({
      id: 'question-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-question-1',
        questions: [
          {
            id: 'choice',
            header: 'Choice',
            question: 'Which option?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'A', description: 'First option' }],
          },
        ],
        isBlocking: true,
        autoResolutionMs: null,
      },
    });

    await expect(nextEvent).resolves.toMatchObject({
      value: {
        type: 'question',
        request: {
          requestId: 'question-1',
          questions: [{ id: 'choice', question: 'Which option?' }],
        },
      },
    });

    await backend.respondToQuestion(
      session.sessionId,
      'question-1',
      { choice: 'A' },
      { questionKeys: ['choice'] },
    );
    expect(client.respond).toHaveBeenCalledWith('question-1', {
      answers: { choice: { answers: ['A'] } },
    });
  });

  it('routes MCP elicitation requests through the question UI', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask through MCP elicitation' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();
    const nextEvent = events.next();

    emitRequest({
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        mode: 'form',
        message: 'Choose an environment',
        requestedSchema: {
          type: 'object',
          properties: {
            environment: {
              type: 'string',
              title: 'Environment',
              enum: ['staging', 'production'],
            },
          },
          required: ['environment'],
        },
      },
    });

    await expect(nextEvent).resolves.toMatchObject({
      value: {
        type: 'question',
        request: {
          requestId: 'elicitation-1',
          contextReminder: 'Choose an environment',
          questions: [{ id: 'environment', type: 'single_choice' }],
        },
      },
    });

    await backend.respondToQuestion(
      session.sessionId,
      'elicitation-1',
      { environment: 'production' },
      { questionKeys: ['environment'] },
    );
    expect(client.request).toHaveBeenCalledWith('thread/increment_elicitation', {
      threadId: 'thread-1',
    });
    expect(client.request).toHaveBeenCalledWith('thread/decrement_elicitation', {
      threadId: 'thread-1',
    });
    expect(client.respond).toHaveBeenCalledWith('elicitation-1', {
      action: 'accept',
      content: { environment: 'production' },
    });
  });

  // The payload below is the verified codex-cli 0.155.0 shape: `_meta` carries
  // `tool_description`/`tool_params`/`persist` but NO `tool_name`, and
  // `requestedSchema.properties` is empty. The tool name is only available from
  // the `item/started` notification that precedes it.
  const MCP_APPROVAL_PARAMS = {
    threadId: 'thread-1',
    turnId: 'turn-1',
    serverName: 'jean-claude-mcp',
    mode: 'form',
    message: 'Allow the jean-claude-mcp MCP server to run tool "ask_question"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_description: 'Ask the user one or more questions.',
      tool_params: { questions: [] },
    },
  };

  // The approval is parked in `pendingApprovals` only after the
  // `thread/increment_elicitation` round trip, so let microtasks settle before
  // acting as the UI would. (In production the UI cannot respond earlier: it
  // only learns of the request from the event pushed after that.)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const MCP_TOOL_CALL_STARTED = {
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'exec-1',
        type: 'mcpToolCall',
        server: 'jean-claude-mcp',
        tool: 'ask_question',
        status: 'inProgress',
      },
    },
  };

  it('names the tool from item/started, since the approval payload omits it', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });

    let permissionEvent: unknown;
    for (let i = 0; i < 6; i += 1) {
      const next = await events.next();
      const value = next.value as { type?: string } | undefined;
      if (value?.type === 'permission-request') {
        permissionEvent = value;
        break;
      }
    }
    expect(permissionEvent).toMatchObject({
      type: 'permission-request',
      request: {
        requestId: 'approval-1',
        // Not the bare `mcp__jean-claude-mcp` fallback: the user must be able
        // to see which tool they are approving.
        toolName: 'mcp__jean-claude-mcp__ask_question',
        input: { questions: [] },
      },
    });

    // The Codex-side elicitation timeout is paused while the human decides.
    expect(client.request).toHaveBeenCalledWith('thread/increment_elicitation', {
      threadId: 'thread-1',
    });

    await backend.respondToPermission(session.sessionId, 'approval-1', {
      behavior: 'allow',
    });
    expect(client.respond).toHaveBeenCalledWith('approval-1', {
      action: 'accept',
      content: {},
    });
    expect(client.request).toHaveBeenCalledWith('thread/decrement_elicitation', {
      threadId: 'thread-1',
    });
  });

  it('falls back to the server name when no tool name is known', async () => {
    const { backend, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();
    const nextEvent = events.next();

    // No preceding item/started, so the tool name is genuinely unavailable.
    emitRequest({ id: 'approval-nameless', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });

    await expect(nextEvent).resolves.toMatchObject({
      value: { request: { toolName: 'mcp__jean-claude-mcp' } },
    });
  });

  it('cancels a pending MCP tool-call approval with an elicitation result', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-stop', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });

    await backend.stop(session.sessionId);

    // `{decision:'cancel'}` carries no `action` and would leave Codex's MCP
    // tool call unresolved.
    expect(client.respond).toHaveBeenCalledWith('approval-stop', {
      action: 'cancel',
    });
    expect(client.respond).not.toHaveBeenCalledWith('approval-stop', {
      decision: 'cancel',
    });
  });

  it('offers a session-allow button naming only the identified tool', async () => {
    const { backend, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });

    let permissionEvent: { request?: unknown } | undefined;
    for (let i = 0; i < 6; i += 1) {
      const next = await events.next();
      const value = next.value as { type?: string } | undefined;
      if (value?.type === 'permission-request') {
        permissionEvent = value as { request?: unknown };
        break;
      }
    }
    expect(permissionEvent?.request).toMatchObject({
      sessionAllowButton: {
        label: 'Allow ask_question for Session',
        toolsToAllow: ['mcp__jean-claude-mcp__ask_question'],
      },
    });
  });

  it('honours "allow for session" so the same MCP tool stops re-prompting', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();

    await backend.respondToPermission(session.sessionId, 'approval-1', {
      behavior: 'allow',
      allowMode: 'session',
    });
    client.respond.mockClear();

    // A second call to the same tool must be accepted without a new prompt.
    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-2', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();

    expect(client.respond).toHaveBeenCalledWith('approval-2', {
      action: 'accept',
      content: {},
    });
    await expect(
      backend.respondToPermission(session.sessionId, 'approval-2', { behavior: 'allow' }),
    ).rejects.toThrow('No pending Codex approval');
  });

  it('does not remember a plain allow-once', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();
    await backend.respondToPermission(session.sessionId, 'approval-1', {
      behavior: 'allow',
    });
    client.respond.mockClear();

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-2', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();

    // Still pending: no auto-accept was sent.
    expect(client.respond).not.toHaveBeenCalled();
  });

  it('never remembers a grant for an unidentified tool', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    // No item/started, so the tool is unnamed; a session grant here would
    // otherwise widen to the whole MCP server.
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();
    await backend.respondToPermission(session.sessionId, 'approval-1', {
      behavior: 'allow',
      allowMode: 'session',
    });
    client.respond.mockClear();

    emitRequest({ id: 'approval-2', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();
    expect(client.respond).not.toHaveBeenCalled();
  });

  const allowRule = (action: 'allow' | 'deny') => [
    {
      tool: 'mcp__jean-claude-mcp__ask_question',
      pattern: '*',
      action,
    },
  ];

  it('accepts without prompting when a persisted rule allows the tool', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    await backend.start(
      createConfig({ permissionRules: allowRule('allow') }),
      [{ type: 'text', text: 'Ask me something' }],
    );

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();

    expect(client.respond).toHaveBeenCalledWith('approval-1', {
      action: 'accept',
      content: {},
    });
    // No prompt was raised, so no elicitation pause was needed either.
    expect(client.request).not.toHaveBeenCalledWith(
      'thread/increment_elicitation',
      expect.anything(),
    );
  });

  it('declines when a persisted rule denies the tool', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    await backend.start(
      createConfig({ permissionRules: allowRule('deny') }),
      [{ type: 'text', text: 'Ask me something' }],
    );

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();

    expect(client.respond).toHaveBeenCalledWith('approval-1', {
      action: 'decline',
    });
  });

  it('applies a rule added mid-run to the live session', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);

    backend.updatePermissionRules({
      sessionId: session.sessionId,
      rules: allowRule('allow'),
    });

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();

    expect(client.respond).toHaveBeenCalledWith('approval-1', {
      action: 'accept',
      content: {},
    });
  });

  it('keeps step-scoped rules across a mid-run refresh', async () => {
    const { backend, client, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(
      createConfig({
        persistedSessionRules: {
          'mcp__jean-claude-mcp__ask_question': 'allow',
        } as AgentBackendConfig['persistedSessionRules'],
      }),
      [{ type: 'text', text: 'Ask me something' }],
    );

    // A refresh carrying unrelated project rules must not drop the step rule.
    backend.updatePermissionRules({
      sessionId: session.sessionId,
      rules: [{ tool: 'bash', pattern: 'ls *', action: 'allow' }],
    });

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();

    expect(client.respond).toHaveBeenCalledWith('approval-1', {
      action: 'accept',
      content: {},
    });
  });

  it('reports session grants so they can be persisted into the step', async () => {
    const { backend, emitRequest, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Ask me something' },
    ]);
    expect(backend.getSessionAllowedTools(session.sessionId)).toEqual([]);

    emitNotification(MCP_TOOL_CALL_STARTED);
    emitRequest({ id: 'approval-1', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });
    await settle();
    await backend.respondToPermission(session.sessionId, 'approval-1', {
      behavior: 'allow',
      allowMode: 'project',
    });

    // Canonical permission-key form, which is what the step store expects.
    expect(backend.getSessionAllowedTools(session.sessionId)).toEqual([
      'mcp__jean-claude-mcp__ask_question',
    ]);
  });

  it('declines an unknown approval kind instead of blind-accepting it', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);

    emitRequest({
      id: 'approval-future',
      method: 'mcpServer/elicitation/request',
      params: {
        ...MCP_APPROVAL_PARAMS,
        _meta: { codex_approval_kind: 'some_future_kind' },
      },
    });

    // Falls through to the elicitation-question path, which declines shapes it
    // cannot render rather than accepting with empty content.
    expect(client.respond).toHaveBeenCalledWith('approval-future', {
      action: 'decline',
    });
  });

  it('auto-approves MCP tool calls in auto mode without prompting', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig({ interactionMode: 'auto' }), [
      { type: 'text', text: 'Just do it' },
    ]);

    emitRequest({ id: 'approval-auto', method: 'mcpServer/elicitation/request', params: MCP_APPROVAL_PARAMS });

    expect(client.respond).toHaveBeenCalledWith('approval-auto', {
      action: 'accept',
      content: {},
    });
  });

  it('auto-approves command approvals in auto mode without prompting', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig({ interactionMode: 'auto' }), [
      { type: 'text', text: 'Run the tests' },
    ]);

    emitRequest({
      id: 'cmd-auto',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
    });

    expect(client.respond).toHaveBeenCalledWith('cmd-auto', {
      decision: 'acceptForSession',
    });
  });

  it('asks Codex for an approver even in auto mode', async () => {
    const { backend, client } = createBackend();
    await backend.start(createConfig({ interactionMode: 'auto' }), [
      { type: 'text', text: 'Just do it' },
    ]);

    // `never` would make Codex hard-deny every MCP tool call.
    expect(client.request).toHaveBeenCalledWith(
      'thread/start',
      expect.objectContaining({ approvalPolicy: 'on-request' }),
    );
  });

  it('declines unsupported MCP elicitation modes', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Sign in' }]);

    emitRequest({
      id: 'elicitation-url',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        mode: 'url',
        message: 'Sign in',
        url: 'https://example.test',
      },
    });

    expect(client.respond).toHaveBeenCalledWith('elicitation-url', {
      action: 'decline',
    });
  });

  it('turns a Codex permission-profile request into a permission event', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Request access' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();
    const nextEvent = events.next();

    emitRequest({
      id: 43,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-permissions-1',
        environmentId: null,
        startedAtMs: 1,
        cwd: '/tmp/project',
        reason: 'Need network access',
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });

    await expect(nextEvent).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: {
          requestId: '43',
          toolName: 'permissions',
          description: 'Need network access',
        },
      },
    });

    await backend.respondToPermission(session.sessionId, '43', {
      behavior: 'allow',
      allowMode: 'session',
    });
    expect(client.respond).toHaveBeenCalledWith(43, {
      permissions: { network: { enabled: true }, fileSystem: null },
      scope: 'session',
    });
  });

  it('steers an active Codex turn through the follow-up prompt capability', async () => {
    const { backend, client, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Start working' },
    ]);
    const events = session.events[Symbol.asyncIterator]();
    await events.next();

    await expect(
      backend.sendUserMessage!(session.sessionId, [
        { type: 'text', text: 'Focus on the failing tests first.' },
      ]),
    ).resolves.toBe(true);
    expect(client.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Focus on the failing tests first.' }],
      expectedTurnId: 'turn-1',
    });

    const nextEvent = events.next();
    emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'steered-item-1',
          type: 'userMessage',
          content: [
            { type: 'text', text: 'Focus on the failing tests first.' },
          ],
        },
      },
    });
    await expect(nextEvent).resolves.toMatchObject({
      value: {
        type: 'entry',
        entry: expect.objectContaining({
          type: 'user-prompt',
          value: 'Focus on the failing tests first.',
        }),
      },
    });
  });

  it('responds with a protocol error for unsupported server requests', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);

    emitRequest({
      id: 'request-1',
      method: 'item/tool/call',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });

    expect(client.respondError).toHaveBeenCalledWith(
      'request-1',
      -32601,
      'Unsupported Codex server request: item/tool/call',
    );
  });

  it('rejects permission-profile requests without a valid profile', async () => {
    const { backend, client, emitRequest } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Request access' }]);

    emitRequest({
      id: 'permissions-invalid',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
      },
    });

    expect(client.respondError).toHaveBeenCalledWith(
      'permissions-invalid',
      -32602,
      'Invalid parameters for item/permissions/requestApproval',
    );
  });

  it('cancels pending permission profiles with their protocol response shape', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Request access' },
    ]);

    emitRequest({
      id: 'permissions-cleanup',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        permissions: { network: { enabled: true } },
      },
    });

    await backend.stop(session.sessionId);

    expect(client.respond).toHaveBeenCalledWith('permissions-cleanup', {
      permissions: {},
      scope: 'turn',
    });
    expect(client.respond).not.toHaveBeenCalledWith('permissions-cleanup', {
      decision: 'cancel',
    });
  });

  it('cancels pending MCP elicitations during cleanup', async () => {
    const { backend, client, emitRequest } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Choose an environment' },
    ]);

    emitRequest({
      id: 'elicitation-cleanup',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: { environment: { type: 'string' } },
        },
      },
    });

    await backend.stop(session.sessionId);

    expect(client.request).toHaveBeenCalledWith('thread/increment_elicitation', {
      threadId: 'thread-1',
    });
    expect(client.request).toHaveBeenCalledWith('thread/decrement_elicitation', {
      threadId: 'thread-1',
    });
    expect(client.respond).toHaveBeenCalledWith('elicitation-cleanup', {
      action: 'cancel',
    });
  });

  it('resumes existing thread when config.sessionId is present', async () => {
    const { backend, client } = createBackend();

    await backend.start(createConfig({ sessionId: 'thread-existing' }), [
      { type: 'text', text: 'Continue' },
    ]);

    expect(client.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-existing',
      cwd: '/tmp/project',
      model: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        sandbox_workspace_write: {
          network_access: true,
          writable_roots: expectedPackageManagerCacheRoots(),
        },
      },
    });
    expect(client.request).not.toHaveBeenCalledWith(
      'thread/start',
      expect.anything(),
    );
  });

  it('passes runtime MCP config into the Codex thread config', async () => {
    const { backend, client } = createBackend();

    await backend.start(
      createConfig({
        mcpServers: {
          'jean-claude-mcp': {
            command: 'node',
            args: ['jean-claude-mcp-server.js'],
            env: {
              JC_MCP_BRIDGE_URL: 'http://127.0.0.1:4567',
              JC_MCP_AUTH_TOKEN: 'token-1',
              JC_MCP_STEP_ID: 'step-1',
              JC_MCP_REGISTRATION_ID: 'registration-1',
            },
            tools: {
              ask_question: { approval_mode: 'auto' },
            },
          },
        },
      }),
      [{ type: 'text', text: 'Hello Codex' }],
    );

    expect(mocks.getOrCreateCodexAppServer).toHaveBeenCalledWith(undefined);
    expect(client.request).toHaveBeenCalledWith('thread/start', {
      cwd: '/tmp/project',
      model: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        sandbox_workspace_write: {
          network_access: true,
          writable_roots: expectedPackageManagerCacheRoots(),
        },
        mcp_servers: {
          'jean-claude-mcp': {
            command: 'node',
            args: ['jean-claude-mcp-server.js'],
            env: {
              JC_MCP_BRIDGE_URL: 'http://127.0.0.1:4567',
              JC_MCP_AUTH_TOKEN: 'token-1',
              JC_MCP_STEP_ID: 'step-1',
              JC_MCP_REGISTRATION_ID: 'registration-1',
            },
            tools: {
              ask_question: { approval_mode: 'auto' },
            },
          },
        },
      },
      serviceName: 'jean_claude',
    });
  });

  it('passes runtime MCP config when resuming threads', async () => {
    const { backend, client } = createBackend();

    await backend.start(
      createConfig({
        sessionId: 'thread-existing',
        mcpServers: {
          'jean-claude-mcp': {
            command: 'node',
            args: ['jean-claude-mcp-server.js'],
            env: {
              JC_MCP_BRIDGE_URL: 'http://127.0.0.1:4567',
              JC_MCP_AUTH_TOKEN: 'token-1',
              JC_MCP_STEP_ID: 'step-1',
              JC_MCP_REGISTRATION_ID: 'registration-1',
            },
          },
        },
      }),
      [{ type: 'text', text: 'Continue' }],
    );

    expect(mocks.getOrCreateCodexAppServer).toHaveBeenCalledWith(undefined);
    expect(client.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'thread-existing',
      cwd: '/tmp/project',
      model: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: {
        sandbox_workspace_write: {
          network_access: true,
          writable_roots: expectedPackageManagerCacheRoots(),
        },
        mcp_servers: {
          'jean-claude-mcp': {
            command: 'node',
            args: ['jean-claude-mcp-server.js'],
            env: {
              JC_MCP_BRIDGE_URL: 'http://127.0.0.1:4567',
              JC_MCP_AUTH_TOKEN: 'token-1',
              JC_MCP_STEP_ID: 'step-1',
              JC_MCP_REGISTRATION_ID: 'registration-1',
            },
          },
        },
      },
    });
  });

  it('allows Codex to write linked worktree git metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-codex-git-'));
    try {
      const worktreePath = path.join(root, 'worktree');
      const gitDir = path.join(root, 'repo.git', 'worktrees', 'task-1');
      const commonDir = path.join(root, 'repo.git');
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${gitDir}\n`);
      fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');

      const { backend, client } = createBackend();
      await backend.start(createConfig({ cwd: worktreePath }), [
        { type: 'text', text: 'Commit changes' },
      ]);

      expect(client.request).toHaveBeenCalledWith('thread/start', {
        cwd: worktreePath,
        model: undefined,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: {
          sandbox_workspace_write: {
            network_access: true,
            writable_roots: [
              ...expectedPackageManagerCacheRoots(),
              gitDir,
              commonDir,
            ],
          },
        },
        serviceName: 'jean_claude',
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes granted external directories writable in the sandbox', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-codex-external-'));
    try {
      const projectGrant = fs.realpathSync.native(root);
      const sessionDirectory = path.join(projectGrant, 'session');
      fs.mkdirSync(sessionDirectory);
      const sessionGrant = fs.realpathSync.native(sessionDirectory);
      const revokedDirectory = path.join(projectGrant, 'revoked');
      fs.mkdirSync(revokedDirectory);
      const revokedGrant = fs.realpathSync.native(revokedDirectory);

      const { backend, client } = createBackend();
      await backend.start(
        createConfig({
          permissionRules: [
            {
              tool: 'external_directory',
              pattern: `${projectGrant}/**`,
              action: 'allow',
            },
            // Revoked by the later rule, so it must not reach the sandbox.
            {
              tool: 'external_directory',
              pattern: `${revokedGrant}/**`,
              action: 'allow',
            },
            {
              tool: 'external_directory',
              pattern: `${revokedGrant}/**`,
              action: 'ask',
            },
          ],
          persistedSessionRules: {
            external_directory: { [`${sessionGrant}/**`]: 'allow' },
          },
        }),
        [{ type: 'text', text: 'Write outside the project' }],
      );

      expect(client.request).toHaveBeenCalledWith(
        'thread/start',
        expect.objectContaining({
          config: {
            sandbox_workspace_write: {
              network_access: true,
              writable_roots: [
                ...expectedPackageManagerCacheRoots(),
                projectGrant,
                sessionGrant,
              ],
            },
          },
        }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts a turn with prompt input', async () => {
    const { backend, client } = createBackend();

    await backend.start(createConfig({ model: 'gpt-5' }), [
      { type: 'text', text: 'Read this' },
      { type: 'image', data: 'base64-data', mimeType: 'image/png' },
      { type: 'file', filePath: '/tmp/file.txt', filename: 'file.txt' },
    ]);

    expect(client.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'Read this' },
        { type: 'image', url: 'data:image/png;base64,base64-data' },
        { type: 'text', text: 'Attached file: /tmp/file.txt' },
      ],
      model: 'gpt-5',
      collaborationMode: {
        mode: 'default',
        settings: {
          model: 'gpt-5',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
  });

  it('passes native Plan mode to the next Codex turn', async () => {
    const { backend, client } = createBackend();

    await backend.start(createConfig({ model: 'gpt-5', interactionMode: 'plan' }), [
      { type: 'text', text: 'Make a plan' },
    ]);

    expect(client.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Make a plan' }],
      model: 'gpt-5',
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'gpt-5',
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
  });

  it('uses the first discovered model when the default marker is absent', async () => {
    const { backend, client } = createBackend({
      modelListResult: { data: [{ id: 'gpt-5.6-codex' }] },
    });

    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);

    expect(client.request).toHaveBeenCalledWith('turn/start',
      expect.objectContaining({
        collaborationMode: expect.objectContaining({
          settings: expect.objectContaining({ model: 'gpt-5.6-codex' }),
        }),
      }),
    );
  });

  it('exposes the Codex app-server root PID for resource tracking', async () => {
    const { backend } = createBackend({ rootPid: 4321 });

    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Track resources' },
    ]);

    expect(session.rootPid).toBe(4321);
  });

  it('yields entry events with persisted raw row ids', async () => {
    const { backend, emitNotification, persistRaw } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session-id', sessionId: 'thread-1' },
    });
    const next = iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'item-1', type: 'message', role: 'user', text: 'Hello' },
      },
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        type: 'entry',
        entry: expect.objectContaining({
          id: 'item-1',
          type: 'user-prompt',
          value: 'Hello',
        }),
        rawMessageId: 'raw-1',
      },
    });
    expect(persistRaw).toHaveBeenCalledWith({
      messageIndex: 7,
      backendSessionId: 'thread-1',
      rawData: {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          item: { id: 'item-1', type: 'message', role: 'user', text: 'Hello' },
        },
      },
    });
  });

  it('merges repeated Codex delta raw rows by item', async () => {
    const updateRaw = vi.fn<NonNullable<AgentTaskContext['updateRaw']>>(
      async () => undefined,
    );
    const { backend, emitNotification, persistRaw } = createBackend({
      updateRaw,
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Hel',
      },
    });
    emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'lo',
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'entry', entry: { id: 'msg-1', value: 'Hel' } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'entry-update', entry: { id: 'msg-1', value: 'Hello' } },
    });
    expect(persistRaw).toHaveBeenCalledTimes(1);
    expect(updateRaw).not.toHaveBeenCalled();

    await backend.stop(session.sessionId);

    expect(updateRaw).toHaveBeenCalledWith({
      rowId: 'raw-1',
      rawData: {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'msg-1',
          delta: 'Hello',
        },
      },
    });
  });

  it('ignores notifications for a different thread', async () => {
    const { backend, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-other',
        item: { id: 'wrong', type: 'message', role: 'user', text: 'Wrong' },
      },
    });
    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-other',
        item: {
          id: 'wrong-turn',
          type: 'message',
          role: 'user',
          text: 'Wrong',
        },
      },
    });
    await Promise.resolve();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'right', type: 'message', role: 'user', text: 'Right' },
      },
    });

    expect(await next).toMatchObject({
      done: false,
      value: { type: 'entry', entry: { id: 'right' } },
    });
  });

  it('accepts item notifications for registered Codex sub-agent child threads', async () => {
    const { backend, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Review with subagent' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'call-spawn',
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['thread-child'],
          prompt: 'Review diff',
          model: '',
        },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'entry',
        entry: {
          id: 'call-spawn',
          type: 'tool-use',
          name: 'sub-agent',
        },
      },
    });

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-child',
        turnId: 'turn-child',
        item: {
          id: 'child-message',
          type: 'agentMessage',
          text: 'Child finding',
        },
      },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'entry',
        entry: {
          id: 'child-message',
          type: 'assistant-message',
          value: 'Child finding',
          parentToolId: 'call-spawn',
        },
      },
    });
  });

  it('ignores other-thread started notifications using top-level params id', async () => {
    const { backend, emitNotification, persistRaw } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    emitNotification({
      method: 'thread/started',
      params: { id: 'thread-other' },
    });
    await Promise.resolve();
    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'item-1', type: 'message', role: 'user', text: 'Accepted' },
      },
    });

    await expect(next).resolves.toMatchObject({
      value: { type: 'entry', entry: { id: 'item-1' } },
    });
    expect(persistRaw).toHaveBeenCalledTimes(1);
  });

  it('processes notifications in order when first persistRaw resolves later', async () => {
    let resolveFirst!: (value: string) => void;
    const firstPersist = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const { backend, emitNotification } = createBackend({
      persistRaw: vi
        .fn<AgentTaskContext['persistRaw']>()
        .mockReturnValueOnce(firstPersist)
        .mockResolvedValueOnce('raw-2'),
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const first = iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'item-1', type: 'message', role: 'user', text: 'First' },
      },
    });
    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'item-2', type: 'message', role: 'user', text: 'Second' },
      },
    });
    await Promise.resolve();

    resolveFirst('raw-1');

    await expect(first).resolves.toMatchObject({
      value: { type: 'entry', entry: { id: 'item-1' }, rawMessageId: 'raw-1' },
    });
    const second = iterator.next();
    await expect(second).resolves.toMatchObject({
      value: { type: 'entry', entry: { id: 'item-2' }, rawMessageId: 'raw-2' },
    });
  });

  it('emits entry before closing for queued turn completion', async () => {
    const { backend, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'item-1', type: 'message', role: 'user', text: 'First' },
      },
    });
    emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'entry', entry: { id: 'item-1' } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'complete' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('ignores unscoped notifications', async () => {
    const { backend, emitNotification, persistRaw } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        item: { id: 'item-1', type: 'message', role: 'user', text: 'Ignored' },
      },
    });
    await Promise.resolve();
    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'item-2', type: 'message', role: 'user', text: 'Accepted' },
      },
    });

    await expect(next).resolves.toMatchObject({
      value: { type: 'entry', entry: { id: 'item-2' } },
    });
    expect(persistRaw).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes after natural completion', async () => {
    const { backend, emitNotification, unsubscribe } = createBackend();
    const session = await backend.start(
      createConfig({ model: 'gpt-5.3-codex' }),
      [{ type: 'text', text: 'Hello' }],
    );
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'complete',
        result: { model: 'gpt-5.3-codex' },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(unsubscribe).toHaveBeenCalledOnce();
    await expect(backend.stop(session.sessionId)).resolves.toBeUndefined();
  });

  it('completes when Codex reports the thread idle', async () => {
    const { backend, emitNotification, unsubscribe } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: { type: 'idle' } },
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'complete', result: { isError: false } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('ignores unscoped thread idle notifications', async () => {
    const { backend, emitNotification } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'thread/status/changed',
      params: { status: { type: 'idle' } },
    });
    await Promise.resolve();

    await backend.stop(session.sessionId);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('completes after idle timeout when all Codex items completed', async () => {
    vi.useFakeTimers();
    const { backend, emitNotification, unsubscribe } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'cmd-1', type: 'commandExecution', command: 'true' },
      },
    });
    await iterator.next();
    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'cmd-1', type: 'commandExecution', command: 'true' },
      },
    });
    await iterator.next();

    const complete = iterator.next();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(complete).resolves.toMatchObject({
      value: { type: 'complete', result: { isError: false } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not complete while an MCP elicitation is pending', async () => {
    vi.useFakeTimers();
    const { backend, client, emitNotification, emitRequest, unsubscribe } =
      createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Wait for an answer' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'msg-1', type: 'message', role: 'assistant' },
      },
    });
    await iterator.next();

    const question = iterator.next();
    emitRequest({
      id: 'elicitation-waiting',
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
        },
      },
    });
    await expect(question).resolves.toMatchObject({
      value: { type: 'question', request: { requestId: 'elicitation-waiting' } },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(unsubscribe).not.toHaveBeenCalled();

    await backend.stop(session.sessionId);
    expect(client.respond).toHaveBeenCalledWith('elicitation-waiting', {
      action: 'cancel',
    });
    vi.useRealTimers();
  });

  it('closes after idle delta flush fails without retrying cleanup flush', async () => {
    vi.useFakeTimers();
    const updateRaw = vi.fn<NonNullable<AgentTaskContext['updateRaw']>>(
      async () => {
        throw new Error('database unavailable');
      },
    );
    const { backend, emitNotification, unsubscribe } = createBackend({
      updateRaw,
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { id: 'msg-1', type: 'message', role: 'assistant' },
      },
    });
    await iterator.next();
    emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Hello',
      },
    });
    await iterator.next();
    emitNotification({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: ' world',
      },
    });
    await iterator.next();

    const error = iterator.next();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(error).resolves.toMatchObject({
      value: {
        type: 'error',
        error: 'Failed to flush Codex raw deltas: database unavailable',
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(updateRaw).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('does not wait on speculative Codex agent command executions', async () => {
    vi.useFakeTimers();
    const { backend, emitNotification, unsubscribe } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();

    emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-speculative',
          type: 'commandExecution',
          command: 'pnpm install',
          processId: null,
          source: 'agent',
          status: 'inProgress',
        },
      },
    });

    emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-real',
          type: 'commandExecution',
          command: 'pnpm install',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'inProgress',
        },
      },
    });
    await iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          id: 'cmd-real',
          type: 'commandExecution',
          command: 'pnpm install',
          processId: '123',
          source: 'unifiedExecStartup',
          status: 'failed',
          exitCode: 1,
        },
      },
    });
    await iterator.next();

    const complete = iterator.next();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(complete).resolves.toMatchObject({
      value: { type: 'complete', result: { isError: false } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(unsubscribe).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('emits error when raw persistence fails', async () => {
    const { backend, emitNotification, unsubscribe } = createBackend({
      persistRaw: vi.fn<AgentTaskContext['persistRaw']>(async () => {
        throw new Error('database unavailable');
      }),
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    await iterator.next();
    const next = iterator.next();

    emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: { id: 'item-1', type: 'message', role: 'user', text: 'Hello' },
      },
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: {
        type: 'error',
        error: 'Failed to persist Codex raw notification: database unavailable',
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('emits session id from thread start response', async () => {
    const { backend } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Hello' },
    ]);

    await expect(
      session.events[Symbol.asyncIterator]().next(),
    ).resolves.toEqual({
      done: false,
      value: { type: 'session-id', sessionId: 'thread-1' },
    });
  });

  it('emits resumed config session id when resume response lacks id', async () => {
    const { backend } = createBackend({ threadResult: {} });
    const session = await backend.start(
      createConfig({ sessionId: 'thread-existing' }),
      [{ type: 'text', text: 'Continue' }],
    );

    await expect(
      session.events[Symbol.asyncIterator]().next(),
    ).resolves.toEqual({
      done: false,
      value: { type: 'session-id', sessionId: 'thread-existing' },
    });
  });

  it('fails startup and cleans up when turn start response lacks id', async () => {
    const { backend, unsubscribe } = createBackend({ turnResult: {} });

    await expect(
      backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]),
    ).rejects.toThrow('Codex turn/start did not return a turn id');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('interrupts the active turn on stop', async () => {
    const { backend, client } = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'Stop later' },
    ]);

    await backend.stop(session.sessionId);

    expect(client.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
  });

  it('interrupts active turns on dispose without disposing shared process', async () => {
    const { backend, unsubscribe, serverDispose, client } = createBackend();
    await backend.start(createConfig(), [{ type: 'text', text: 'Hello' }]);

    await backend.dispose();

    expect(client.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(serverDispose).not.toHaveBeenCalled();
  });
});

function expectedPackageManagerCacheRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, 'Library/pnpm'),
    path.join(home, 'Library/Caches/pnpm'),
    path.join(home, '.local/share/pnpm'),
    path.join(home, '.pnpm-store'),
    path.join(home, '.cache/pnpm'),
    path.join(home, '.npm'),
    path.join(home, '.cache/node-gyp'),
    path.join(home, 'Library/Caches/Yarn'),
    path.join(home, '.cache/yarn'),
    path.join(home, '.yarn/berry/cache'),
    path.join(home, 'Library/Caches/electron'),
    path.join(home, '.cache/electron'),
    path.join(home, 'Library/Caches/electron-builder'),
    path.join(home, '.cache/electron-builder'),
    path.join(home, 'Library/Caches/Cypress'),
    path.join(home, '.cache/Cypress'),
    path.join(home, 'Library/Caches/ms-playwright'),
    path.join(home, '.cache/ms-playwright'),
    path.join(home, 'Library/Caches/puppeteer'),
    path.join(home, '.cache/puppeteer'),
    path.join(home, '.cache/vite'),
    path.join(home, '.cache/turbo'),
    path.join(home, '.turbo'),
    path.join(home, '.cache/esbuild'),
    path.join(home, '.cache/swc'),
    path.join(home, '.cache/parcel'),
    path.join(home, 'Library/Caches/nx'),
    path.join(home, '.cache/nx'),
    path.join(home, '.gradle/caches'),
    path.join(home, 'Library/Caches/Homebrew'),
    path.join(home, '.cargo/registry'),
    path.join(home, '.cargo/git'),
    path.join(home, 'go/pkg/mod'),
    path.join(home, '.m2/repository'),
    path.join(home, '.ivy2/cache'),
  ];
}

function createBackend(
  options: {
    persistRaw?: AgentTaskContext['persistRaw'];
    threadResult?: unknown;
    turnResult?: unknown;
    modelListResult?: unknown;
    updateRaw?: AgentTaskContext['updateRaw'];
    rootPid?: number;
  } = {},
) {
  let notificationListener:
    | ((message: { method: string; params?: unknown }) => void)
    | null = null;
  let requestListener:
    | ((message: { id: number | string; method: string; params?: unknown }) => void)
    | null = null;
  const unsubscribe = vi.fn();
  const unsubscribeRequest = vi.fn();
  const request = vi.fn(async (method: string) => {
    if (method === 'thread/start' || method === 'thread/resume') {
      return (
        options.threadResult ?? { thread: { id: 'thread-1' }, id: 'thread-1' }
      );
    }
    if (method === 'turn/start') {
      return options.turnResult ?? { turn: { id: 'turn-1' }, id: 'turn-1' };
    }
    if (method === 'model/list') {
      return options.modelListResult ?? {};
    }
    return {};
  });
  const client = {
    request,
    respond: vi.fn(async () => undefined),
    respondError: vi.fn(async () => undefined),
    onNotification: vi.fn((listener) => {
      notificationListener = listener;
      return unsubscribe;
    }),
    onRequest: vi.fn((listener) => {
      requestListener = listener;
      return unsubscribeRequest;
    }),
  };
  const serverDispose = vi.fn(async () => undefined);
  mocks.getOrCreateCodexAppServer.mockResolvedValue({
    client,
    rootPid: options.rootPid,
    dispose: serverDispose,
  });
  const persistRaw =
    options.persistRaw ??
    vi.fn<AgentTaskContext['persistRaw']>(async ({ messageIndex }) =>
      messageIndex === 7 ? 'raw-1' : `raw-${messageIndex - 6}`,
    );
  const backend = new CodexBackend({
    taskId: 'task-1',
    sessionStartIndex: 7,
    persistRaw,
    updateRaw: options.updateRaw,
  });

  return {
    backend,
    client,
    emitNotification: (message: { method: string; params?: unknown }) => {
      notificationListener?.(message);
    },
    emitRequest: (message: {
      id: number | string;
      method: string;
      params?: unknown;
    }) => {
      requestListener?.(message);
    },
    persistRaw,
    serverDispose,
    unsubscribe,
    unsubscribeRequest,
  };
}

function createConfig(
  overrides: Partial<AgentBackendConfig> = {},
): AgentBackendConfig {
  return {
    type: 'codex',
    cwd: '/tmp/project',
    interactionMode: 'ask',
    model: 'default',
    ...overrides,
  };
}
