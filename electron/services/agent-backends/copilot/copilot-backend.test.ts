import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PermissionScope,
  ResolvedPermissionRule,
} from '@shared/permission-types';
import type { AgentTaskContext } from '@shared/agent-backend-types';

const mocks = vi.hoisted(() => ({
  nanoid: vi.fn(),
  clientStart: vi.fn(),
  clientStop: vi.fn(),
  createSession: vi.fn(),
  resumeSession: vi.fn(),
  sessionSend: vi.fn(),
  sessionSendAndWait: vi.fn(),
  sessionAbort: vi.fn(),
  sessionDisconnect: vi.fn(),
  sessionOn: vi.fn(),
  unsubscribe: vi.fn(),
  copilotClientConstructor: vi.fn(),
  runtimeForStdio: vi.fn(),
}));

vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: mocks.copilotClientConstructor,
  RuntimeConnection: {
    forStdio: mocks.runtimeForStdio,
  },
}));

vi.mock('nanoid', () => ({
  nanoid: mocks.nanoid,
}));

import { CopilotBackend } from './copilot-backend';

describe('CopilotBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nanoid.mockReturnValue('jc-session-1');
    mocks.clientStart.mockResolvedValue(undefined);
    mocks.clientStop.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue(createSdkSession());
    mocks.resumeSession.mockResolvedValue(createSdkSession());
    mocks.sessionSend.mockResolvedValue('message-1');
    mocks.sessionSendAndWait.mockResolvedValue({
      type: 'assistant.message',
      data: { content: 'Summary text' },
    });
    mocks.sessionAbort.mockResolvedValue(undefined);
    mocks.sessionDisconnect.mockResolvedValue(undefined);
    mocks.sessionOn.mockReturnValue(mocks.unsubscribe);
    mocks.runtimeForStdio.mockImplementation((options) => ({
      kind: 'stdio',
      ...options,
    }));
    mocks.copilotClientConstructor.mockImplementation(() => ({
      start: mocks.clientStart,
      stop: mocks.clientStop,
      createSession: mocks.createSession,
      resumeSession: mocks.resumeSession,
    }));
  });

  it('starts a logged-in-user client in the working directory', async () => {
    const backend = createBackend();

    await backend.start(createConfig(), [{ type: 'text', text: 'hello' }]);

    expect(mocks.copilotClientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ kind: 'stdio' }),
        workingDirectory: '/repo',
        useLoggedInUser: true,
      }),
    );
    expect(mocks.clientStart).toHaveBeenCalledOnce();
  });

  it('creates a model-specific session when model is not default', async () => {
    const backend = createBackend();

    await backend.start(createConfig({ model: 'gpt-5' }), [
      { type: 'text', text: 'hello' },
    ]);

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5' }),
    );
  });

  it('maps interaction modes to Copilot agent modes when creating sessions', async () => {
    const cases = [
      { interactionMode: 'ask' as const, agentMode: 'interactive' },
      { interactionMode: 'plan' as const, agentMode: 'plan' },
      { interactionMode: 'auto' as const, agentMode: 'autopilot' },
    ];

    for (const testCase of cases) {
      const backend = createBackend();

      await backend.start(createConfig(testCase), [
        { type: 'text', text: 'hello' },
      ]);

      expect(mocks.createSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentMode: testCase.agentMode }),
      );
      expect(mocks.sessionSend).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentMode: testCase.agentMode }),
      );
      await backend.stop('jc-session-1');
    }
  });

  it('maps interaction modes to Copilot agent modes when resuming sessions', async () => {
    const cases = [
      { interactionMode: 'ask' as const, agentMode: 'interactive' },
      { interactionMode: 'plan' as const, agentMode: 'plan' },
      { interactionMode: 'auto' as const, agentMode: 'autopilot' },
    ];

    for (const testCase of cases) {
      const backend = createBackend();

      await backend.start(
        createConfig({ ...testCase, sessionId: 'sdk-session-1' }),
        [{ type: 'text', text: 'hello' }],
      );

      expect(mocks.resumeSession).toHaveBeenLastCalledWith(
        'sdk-session-1',
        expect.objectContaining({ agentMode: testCase.agentMode }),
      );
      expect(mocks.sessionSend).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentMode: testCase.agentMode }),
      );
      await backend.stop('jc-session-1');
    }
  });

  it('passes reasoning effort when thinking effort is not default', async () => {
    const backend = createBackend();

    await backend.start(createConfig({ thinkingEffort: 'high' }), [
      { type: 'text', text: 'hello' },
    ]);

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
    );
  });

  it('passes runtime MCP servers to Copilot sessions', async () => {
    const backend = createBackend();

    await backend.start(
      createConfig({
        mcpServers: {
          'jean-claude-mcp': {
            command: 'node',
            args: ['/server.js'],
            env: { JC_MCP_WORKDIR: '/repo' },
          },
        },
      }),
      [{ type: 'text', text: 'hello' }],
    );

    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: {
          'jean-claude-mcp': {
            type: 'stdio',
            command: 'node',
            args: ['/server.js'],
            env: { JC_MCP_WORKDIR: '/repo' },
          },
        },
      }),
    );
  });

  it('passes runtime MCP servers when resuming Copilot sessions', async () => {
    const backend = createBackend();

    await backend.start(
      createConfig({
        sessionId: 'sdk-session-1',
        mcpServers: {
          'jean-claude-mcp': { command: 'node', args: ['/server.js'] },
        },
      }),
      [{ type: 'text', text: 'hello' }],
    );

    expect(mocks.resumeSession).toHaveBeenCalledWith(
      'sdk-session-1',
      expect.objectContaining({
        mcpServers: {
          'jean-claude-mcp': {
            type: 'stdio',
            command: 'node',
            args: ['/server.js'],
          },
        },
      }),
    );
  });

  it('summarizes by resuming the SDK session and cleans up', async () => {
    const backend = createBackend();

    await expect(
      backend.summarizeSession({
        sessionId: 'source-session-1',
        cwd: '/repo',
        model: 'gpt-5',
      }),
    ).resolves.toBe('Summary text');

    expect(mocks.copilotClientConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ kind: 'stdio' }),
        workingDirectory: '/repo',
        useLoggedInUser: true,
      }),
    );
    expect(mocks.clientStart).toHaveBeenCalledOnce();
    expect(mocks.resumeSession).toHaveBeenCalledWith('source-session-1', {
      model: 'gpt-5',
    });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sessionSendAndWait).toHaveBeenCalledWith({
      prompt: expect.stringContaining(
        'Summarize the prior session context for continuation.',
      ),
    });
    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
  });

  it('omits default model when summarizing', async () => {
    const backend = createBackend();

    await backend.summarizeSession({
      sessionId: 'source-session-1',
      cwd: '/repo',
      model: 'default',
    });

    expect(mocks.resumeSession).toHaveBeenCalledWith('source-session-1', {});
  });

  it('cleans up the temporary summary session when summarization fails', async () => {
    mocks.sessionSendAndWait.mockRejectedValueOnce(new Error('summary failed'));
    const backend = createBackend();

    await expect(
      backend.summarizeSession({ sessionId: 'source-session-1', cwd: '/repo' }),
    ).rejects.toThrow('summary failed');

    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
  });

  it('stops the summary client when startup fails', async () => {
    mocks.clientStart.mockRejectedValueOnce(new Error('start failed'));
    const backend = createBackend();

    await expect(
      backend.summarizeSession({ sessionId: 'source-session-1', cwd: '/repo' }),
    ).rejects.toThrow('start failed');

    expect(mocks.resumeSession).not.toHaveBeenCalled();
    expect(mocks.sessionDisconnect).not.toHaveBeenCalled();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
  });

  it('stops the summary client when resume fails', async () => {
    mocks.resumeSession.mockRejectedValueOnce(new Error('resume failed'));
    const backend = createBackend();

    await expect(
      backend.summarizeSession({ sessionId: 'source-session-1', cwd: '/repo' }),
    ).rejects.toThrow('resume failed');

    expect(mocks.sessionDisconnect).not.toHaveBeenCalled();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
  });

  it('does not return the fallback send message ID as a summary', async () => {
    mocks.resumeSession.mockResolvedValueOnce(
      createSdkSession('copilot-session-1', { sendAndWait: false }),
    );
    const backend = createBackend();

    await expect(
      backend.summarizeSession({ sessionId: 'source-session-1', cwd: '/repo' }),
    ).resolves.toBe('');

    expect(mocks.sessionSend).toHaveBeenCalledWith({
      prompt: expect.stringContaining(
        'Summarize the prior session context for continuation.',
      ),
    });
    expect(mocks.sessionSendAndWait).not.toHaveBeenCalled();
  });

  it('returns an empty summary when response extraction has no content', async () => {
    mocks.sessionSendAndWait.mockResolvedValueOnce({ type: 'session.idle' });
    const backend = createBackend();

    await expect(
      backend.summarizeSession({ sessionId: 'source-session-1', cwd: '/repo' }),
    ).resolves.toBe('');
  });

  it('creates a new SDK session when no session ID is provided', async () => {
    const backend = createBackend();

    await backend.start(createConfig(), [{ type: 'text', text: 'hello' }]);

    expect(mocks.createSession).toHaveBeenCalledOnce();
    expect(mocks.resumeSession).not.toHaveBeenCalled();
  });

  it('resumes the SDK session when session ID is provided', async () => {
    const backend = createBackend();

    await backend.start(createConfig({ sessionId: 'sdk-session-1' }), [
      { type: 'text', text: 'hello' },
    ]);

    expect(mocks.resumeSession).toHaveBeenCalledWith(
      'sdk-session-1',
      expect.objectContaining({
        onPermissionRequest: expect.any(Function),
        onUserInputRequest: expect.any(Function),
      }),
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('sends a new prompt after resuming an SDK session', async () => {
    const backend = createBackend();

    await backend.start(createConfig({ sessionId: 'sdk-session-1' }), [
      { type: 'text', text: 'resumed prompt' },
    ]);

    expect(mocks.sessionSend).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'resumed prompt' }),
    );
  });

  it('returns a Jean-Claude session key distinct from the SDK persistent session ID', async () => {
    mocks.createSession.mockResolvedValueOnce(
      createSdkSession('sdk-persistent-1'),
    );
    const persistRaw = vi.fn<AgentTaskContext['persistRaw']>(
      async () => 'raw-1',
    );
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementationOnce((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const backend = createBackend({ persistRaw });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    expect(session.sessionId).not.toBe('sdk-persistent-1');
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session-id', sessionId: 'sdk-persistent-1' },
    });

    eventHandler({ type: 'assistant.message', data: { content: 'hello' } });
    await iterator.next();

    expect(persistRaw).toHaveBeenCalledWith({
      messageIndex: 3,
      backendSessionId: 'sdk-persistent-1',
      rawData: { type: 'assistant.message', data: { content: 'hello' } },
    });
  });

  it('queues permission callbacks fired during createSession', async () => {
    mocks.createSession.mockImplementationOnce((config) => {
      void config.onPermissionRequest?.({
        kind: 'shell',
        toolCallId: 'perm-startup',
        toolName: 'Bash',
        fullCommandText: 'git status',
      });
      return Promise.resolve(createSdkSession());
    });
    const backend = createBackend();

    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: { requestId: 'perm-startup' },
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session-id', sessionId: 'copilot-session-1' },
    });
  });

  it('emits permission requests that block session creation', async () => {
    mocks.createSession.mockImplementationOnce(async (config) => {
      await config.onPermissionRequest?.({
        kind: 'read',
        toolCallId: 'perm-startup-read',
        path: '/repo/src/index.ts',
      });
      return createSdkSession();
    });
    const backend = createBackend();

    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: {
          requestId: 'perm-startup-read',
          toolName: 'Read',
          input: { filePath: 'src/index.ts' },
        },
      },
    });

    await backend.respondToPermission(session.sessionId, 'perm-startup-read', {
      behavior: 'allow',
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session-id', sessionId: 'copilot-session-1' },
    });
    expect(mocks.sessionSend).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'hello' }),
    );
  });

  it('auto-approves permission requests allowed by existing rules', async () => {
    const backend = createBackend();

    await backend.start(
      createConfig({
        permissionRules: [
          { tool: 'bash', pattern: 'pnpm test', action: 'allow' },
        ],
      }),
      [{ type: 'text', text: 'hello' }],
    );

    await expect(
      Promise.resolve(
        getPermissionHandler()({
          kind: 'shell',
          toolCallId: 'perm-1',
          fullCommandText: 'pnpm test',
        }),
      ),
    ).resolves.toEqual({ kind: 'approve-once' });
  });

  it('auto-denies permission requests denied by existing rules', async () => {
    const backend = createBackend();

    await backend.start(
      createConfig({
        permissionRules: [{ tool: 'bash', pattern: 'rm *', action: 'deny' }],
      }),
      [{ type: 'text', text: 'hello' }],
    );

    await expect(
      Promise.resolve(
        getPermissionHandler()({
          kind: 'shell',
          toolCallId: 'perm-1',
          fullCommandText: 'rm -rf dist',
        }),
      ),
    ).resolves.toEqual({
      kind: 'reject',
      feedback: 'Tool "Bash" is denied by permission rules',
    });
  });

  it('auto-approves permission requests allowed by persisted session rules', async () => {
    const backend = createBackend();

    await backend.start(
      createConfig({
        persistedSessionRules: { read: { 'src/**': 'allow' } },
      }),
      [{ type: 'text', text: 'hello' }],
    );

    await expect(
      Promise.resolve(
        getPermissionHandler()({
          kind: 'read',
          toolCallId: 'perm-1',
          path: '/repo/src/a.ts',
        }),
      ),
    ).resolves.toEqual({ kind: 'approve-once' });
  });

  it('matches file permission rules with relative and absolute paths', async () => {
    const backend = createBackend();

    await backend.start(
      createConfig({
        permissionRules: [
          { tool: 'read', pattern: 'src/**', action: 'allow' },
          { tool: 'write', pattern: '/repo/generated/**', action: 'allow' },
        ],
      }),
      [{ type: 'text', text: 'hello' }],
    );

    await expect(
      Promise.resolve(
        getPermissionHandler()({
          kind: 'read',
          toolCallId: 'perm-read',
          path: '/repo/src/a.ts',
        }),
      ),
    ).resolves.toEqual({ kind: 'approve-once' });
    await expect(
      Promise.resolve(
        getPermissionHandler()({
          kind: 'write',
          toolCallId: 'perm-write',
          fileName: 'generated/a.ts',
        }),
      ),
    ).resolves.toEqual({ kind: 'approve-once' });
  });

  it('pushes a Jean-Claude permission event for ask-mode requests', async () => {
    const backend = createBackend();
    const session = await backend.start(
      createConfig({ interactionMode: 'ask' }),
      [{ type: 'text', text: 'hello' }],
    );
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const decision = getPermissionHandler()({
      kind: 'shell',
      toolCallId: 'perm-1',
      fullCommandText: 'pnpm lint',
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: {
          requestId: 'perm-1',
          toolName: 'Bash',
          input: { command: 'pnpm lint' },
        },
      },
    });
    expect(decision).toBeInstanceOf(Promise);
  });

  it('maps Copilot permission request kinds to Jean-Claude permission requests', async () => {
    const backend = createBackend();
    const session = await backend.start(
      createConfig({ interactionMode: 'ask' }),
      [{ type: 'text', text: 'hello' }],
    );
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();

    const cases = [
      {
        sdkRequest: {
          kind: 'shell',
          toolCallId: 'perm-shell',
          fullCommandText: 'pnpm test',
        },
        expected: {
          requestId: 'perm-shell',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        },
      },
      {
        sdkRequest: {
          kind: 'write',
          toolCallId: 'perm-write',
          toolName: 'edit_file',
          fileName: '/repo/a.ts',
        },
        expected: {
          requestId: 'perm-write',
          toolName: 'Edit',
          input: { filePath: 'a.ts' },
        },
      },
      {
        sdkRequest: {
          kind: 'read',
          toolCallId: 'perm-read',
          path: '/repo/read.ts',
          fileName: '/repo/fallback.ts',
        },
        expected: {
          requestId: 'perm-read',
          toolName: 'Read',
          input: { filePath: 'read.ts' },
        },
      },
      {
        sdkRequest: {
          kind: 'read',
          toolCallId: 'perm-read-fallback',
          fileName: '/repo/fallback.ts',
        },
        expected: {
          requestId: 'perm-read-fallback',
          toolName: 'Read',
          input: { filePath: 'fallback.ts' },
        },
      },
      {
        sdkRequest: {
          kind: 'mcp',
          toolCallId: 'perm-mcp',
          toolName: 'repo_search',
        },
        expected: {
          requestId: 'perm-mcp',
          toolName: 'repo_search',
          input: { toolName: 'repo_search' },
        },
      },
      {
        sdkRequest: {
          kind: 'url',
          toolCallId: 'perm-url',
          url: 'https://example.com',
        },
        expected: {
          requestId: 'perm-url',
          toolName: 'copilot:url',
          input: { kind: 'url', url: 'https://example.com' },
        },
      },
      {
        sdkRequest: { kind: 'memory', toolCallId: 'perm-memory' },
        expected: {
          requestId: 'perm-memory',
          toolName: 'copilot:memory',
          input: { kind: 'memory' },
        },
      },
      {
        sdkRequest: { kind: 'hook', toolCallId: 'perm-hook' },
        expected: {
          requestId: 'perm-hook',
          toolName: 'copilot:hook',
          input: { kind: 'hook' },
        },
      },
      {
        sdkRequest: {
          kind: 'custom-tool',
          toolCallId: 'perm-custom',
          toolName: 'deploy',
        },
        expected: {
          requestId: 'perm-custom',
          toolName: 'copilot:custom-tool',
          input: { kind: 'custom-tool', toolName: 'deploy' },
        },
      },
      {
        sdkRequest: {
          kind: 'future-kind',
          toolCallId: 'perm-unknown',
          toolName: 'Bash',
        },
        expected: {
          requestId: 'perm-unknown',
          toolName: 'copilot:future-kind',
          input: { kind: 'future-kind', toolName: 'Bash' },
        },
      },
    ];

    for (const testCase of cases) {
      const decision = getPermissionHandler()(testCase.sdkRequest);

      await expect(iterator.next()).resolves.toMatchObject({
        value: {
          type: 'permission-request',
          request: testCase.expected,
        },
      });
      await backend.respondToPermission(
        session.sessionId,
        testCase.expected.requestId,
        { behavior: 'allow' },
      );
      await expect(decision).resolves.toEqual({ kind: 'approve-once' });
    }
  });

  it('resolves allowed permission responses as approve-once', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const decision = getPermissionHandler()({
      kind: 'write',
      toolCallId: 'perm-1',
      fileName: '/repo/a.ts',
    });

    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
    });

    await expect(decision).resolves.toEqual({ kind: 'approve-once' });
  });

  it('resolves session-allowed file permission responses as approve-once', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const decision = getPermissionHandler()({
      kind: 'read',
      toolCallId: 'perm-1',
      fileName: '/repo/a.ts',
    });

    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
      allowMode: 'session',
      toolsToAllow: ['read:a.ts'],
    });

    await expect(decision).resolves.toEqual({ kind: 'approve-once' });
    expect(backend.getSessionAllowedTools(session.sessionId)).toEqual([
      'read:a.ts',
    ]);
  });

  it('keeps session-allowed tools after idle cleanup until dispose', async () => {
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementation((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();
    const decision = getPermissionHandler()({
      kind: 'read',
      toolCallId: 'perm-1',
      fileName: '/repo/a.ts',
    });

    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
      allowMode: 'session',
      toolsToAllow: ['read:a.ts'],
    });
    await expect(decision).resolves.toEqual({ kind: 'approve-once' });

    await iterator.next();
    await iterator.next();
    eventHandler({ type: 'session.idle', data: {} });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'complete' },
      done: false,
    });

    expect(backend.getSessionAllowedTools(session.sessionId)).toEqual([
      'read:a.ts',
    ]);

    await backend.dispose();

    expect(backend.getSessionAllowedTools(session.sessionId)).toEqual([]);
  });

  it('uses SDK session approval for narrowly scoped request kinds', async () => {
    const cases = [
      {
        request: {
          kind: 'mcp',
          toolCallId: 'perm-mcp',
          serverName: 'github',
          toolName: 'search',
        },
        requestId: 'perm-mcp',
        expected: {
          kind: 'approve-for-session',
          approval: { kind: 'mcp', serverName: 'github', toolName: 'search' },
        },
      },
      {
        request: {
          kind: 'custom-tool',
          toolCallId: 'perm-custom',
          toolName: 'deploy',
        },
        requestId: 'perm-custom',
        expected: {
          kind: 'approve-for-session',
          approval: { kind: 'custom-tool', toolName: 'deploy' },
        },
      },
    ];

    for (const testCase of cases) {
      const backend = createBackend();
      const session = await backend.start(createConfig(), [
        { type: 'text', text: 'hello' },
      ]);
      const decision = getPermissionHandler()(testCase.request);

      await backend.respondToPermission(session.sessionId, testCase.requestId, {
        behavior: 'allow',
        allowMode: 'session',
      });

      await expect(decision).resolves.toEqual(testCase.expected);
      await backend.stop(session.sessionId);
    }
  });

  it('does not use broad SDK session approval when scope is uncertain', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const decision = getPermissionHandler()({
      kind: 'shell',
      toolCallId: 'perm-1',
      fullCommandText: 'pnpm test',
    });

    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
      allowMode: 'session',
    });

    await expect(decision).resolves.toEqual({ kind: 'approve-once' });
  });

  it('returns approve-once for shell session allow with command identifiers', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const decision = getPermissionHandler()({
      kind: 'commands',
      toolCallId: 'perm-commands',
      fullCommandText: 'pnpm test',
      commands: [{ identifier: 'pnpm' }],
      commandIdentifiers: ['pnpm'],
    });

    await backend.respondToPermission(session.sessionId, 'perm-commands', {
      behavior: 'allow',
      allowMode: 'session',
      toolsToAllow: ['bash:pnpm test'],
    });

    await expect(decision).resolves.toEqual({ kind: 'approve-once' });
  });

  it('does not persist unknown Copilot kinds as session allows', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const firstDecision = getPermissionHandler()({
      kind: 'mystery',
      toolCallId: 'perm-1',
      toolName: 'unknown-tool',
    });

    const firstEvent = await iterator.next();
    expect(firstEvent).toMatchObject({
      value: {
        type: 'permission-request',
        request: {
          requestId: 'perm-1',
          toolName: 'copilot:mystery',
        },
      },
    });
    expect(firstEvent.value).toMatchObject({ type: 'permission-request' });
    if (firstEvent.value.type === 'permission-request') {
      expect(firstEvent.value.request).not.toHaveProperty('sessionAllowButton');
    }
    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
      allowMode: 'session',
      toolsToAllow: ['copilot:mystery'],
    });

    await expect(firstDecision).resolves.toEqual({ kind: 'approve-once' });
    expect(backend.getSessionAllowedTools(session.sessionId)).toEqual([]);

    const secondDecision = getPermissionHandler()({
      kind: 'mystery',
      toolCallId: 'perm-2',
      toolName: 'unknown-tool',
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: { requestId: 'perm-2', toolName: 'copilot:mystery' },
      },
    });
    await backend.respondToPermission(session.sessionId, 'perm-2', {
      behavior: 'deny',
      message: 'Asked again',
    });
    await expect(secondDecision).resolves.toEqual({
      kind: 'reject',
      feedback: 'Asked again',
    });
  });

  it('does not persist commandless shell session allows', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const firstDecision = getPermissionHandler()({
      kind: 'shell',
      toolCallId: 'perm-1',
    });

    const firstEvent = await iterator.next();
    expect(firstEvent).toMatchObject({
      value: {
        type: 'permission-request',
        request: {
          requestId: 'perm-1',
          toolName: 'Bash',
          input: { command: '' },
        },
      },
    });
    expect(firstEvent.value).toMatchObject({ type: 'permission-request' });
    if (firstEvent.value.type === 'permission-request') {
      expect(firstEvent.value.request).not.toHaveProperty('sessionAllowButton');
    }
    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
      allowMode: 'session',
      toolsToAllow: ['bash'],
    });

    await expect(firstDecision).resolves.toEqual({ kind: 'approve-once' });
    expect(backend.getSessionAllowedTools(session.sessionId)).toEqual([]);

    const secondDecision = getPermissionHandler()({
      kind: 'shell',
      toolCallId: 'perm-2',
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: { requestId: 'perm-2', toolName: 'Bash' },
      },
    });
    await backend.respondToPermission(session.sessionId, 'perm-2', {
      behavior: 'deny',
      message: 'Asked again',
    });
    await expect(secondDecision).resolves.toEqual({
      kind: 'reject',
      feedback: 'Asked again',
    });
  });

  it('applies user session allow as a narrow runtime rule', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const firstDecision = getPermissionHandler()({
      kind: 'read',
      toolCallId: 'perm-1',
      path: '/repo/src/a.ts',
    });

    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
      allowMode: 'session',
      toolsToAllow: ['read:src/a.ts'],
    });

    await expect(firstDecision).resolves.toEqual({ kind: 'approve-once' });
    await expect(
      Promise.resolve(
        getPermissionHandler()({
          kind: 'read',
          toolCallId: 'perm-2',
          path: '/repo/src/a.ts',
        }),
      ),
    ).resolves.toEqual({ kind: 'approve-once' });
  });

  it('does not apply allow-once permission responses as session rules', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const firstDecision = getPermissionHandler()({
      kind: 'read',
      toolCallId: 'perm-1',
      path: '/repo/src/a.ts',
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: { requestId: 'perm-1' },
      },
    });
    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'allow',
      toolsToAllow: ['read:src/a.ts'],
    });

    await expect(firstDecision).resolves.toEqual({ kind: 'approve-once' });
    const secondDecision = getPermissionHandler()({
      kind: 'read',
      toolCallId: 'perm-2',
      path: '/repo/src/a.ts',
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'permission-request',
        request: { requestId: 'perm-2' },
      },
    });
    await backend.respondToPermission(session.sessionId, 'perm-2', {
      behavior: 'deny',
      message: 'Asked again',
    });
    await expect(secondDecision).resolves.toEqual({
      kind: 'reject',
      feedback: 'Asked again',
    });
  });

  it('resolves denied permission responses as reject', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const decision = getPermissionHandler()({
      kind: 'mcp',
      toolCallId: 'perm-1',
      toolName: 'repo_search',
    });

    await backend.respondToPermission(session.sessionId, 'perm-1', {
      behavior: 'deny',
      message: 'No thanks',
    });

    await expect(decision).resolves.toEqual({
      kind: 'reject',
      feedback: 'No thanks',
    });
  });

  it('rejects pending permission requests on stop', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const decision = getPermissionHandler()({
      kind: 'custom-tool',
      toolCallId: 'perm-1',
      toolName: 'deploy',
    });

    await backend.stop(session.sessionId);

    await expect(decision).resolves.toEqual({
      kind: 'reject',
      feedback: 'Session stopped',
    });
  });

  it('pushes a Jean-Claude question event for user input requests', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const response = getUserInputHandler()({
      question: 'Which branch?',
      choices: ['main', 'dev'],
      allowFreeform: true,
    });

    const event = await iterator.next();
    expect(event).toMatchObject({
      value: {
        type: 'question',
        request: {
          questions: [
            {
              question: 'Which branch?',
              header: 'Which branch?',
              options: [
                { label: 'main', description: '' },
                { label: 'dev', description: '' },
              ],
              multiSelect: false,
              allowFreeform: true,
            },
          ],
        },
      },
    });
    expect(response).toBeInstanceOf(Promise);

    if (event.value?.type !== 'question') {
      throw new Error('Expected question event');
    }
    await backend.respondToQuestion(
      session.sessionId,
      event.value.request.requestId,
      {
        'Which branch?': 'dev',
      },
    );

    await expect(response).resolves.toEqual({
      answer: 'dev',
      wasFreeform: true,
    });
  });

  it('resolves fixed-choice question answers as not freeform', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const response = getUserInputHandler()({
      question: 'Which branch?',
      choices: ['main', 'dev'],
      allowFreeform: false,
    });
    const event = await iterator.next();
    if (event.value?.type !== 'question') {
      throw new Error('Expected question event');
    }

    await backend.respondToQuestion(
      session.sessionId,
      event.value.request.requestId,
      {
        'Which branch?': 'dev',
      },
      {
        wasFreeform: false,
        wasFreeformByQuestion: { 'Which branch?': false },
      },
    );

    await expect(response).resolves.toEqual({
      answer: 'dev',
      wasFreeform: false,
    });
  });

  it('infers fixed-choice answers as not freeform when metadata is absent', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const response = getUserInputHandler()({
      question: 'Which branch?',
      choices: ['main', 'dev'],
      allowFreeform: false,
    });
    const event = await iterator.next();
    if (event.value?.type !== 'question') {
      throw new Error('Expected question event');
    }

    await backend.respondToQuestion(
      session.sessionId,
      event.value.request.requestId,
      {
        'Which branch?': 'dev',
      },
    );

    await expect(response).resolves.toEqual({
      answer: 'dev',
      wasFreeform: false,
    });
  });

  it('resolves freeform question answers for SDK user input requests', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const response = getUserInputHandler()({
      question: 'Which branch?',
      choices: ['main', 'dev'],
      allowFreeform: true,
    });
    const event = await iterator.next();
    if (event.value?.type !== 'question') {
      throw new Error('Expected question event');
    }

    await backend.respondToQuestion(
      session.sessionId,
      event.value.request.requestId,
      {
        'Which branch?': 'feature/copilot',
      },
      {
        wasFreeform: true,
        wasFreeformByQuestion: { 'Which branch?': true },
      },
    );

    await expect(response).resolves.toEqual({
      answer: 'feature/copilot',
      wasFreeform: true,
    });
  });

  it('joins multiple answer fields for SDK user input requests', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const response = getUserInputHandler()({
      question: 'Deploy details?',
      choices: ['yes', 'no'],
      allowFreeform: true,
    });
    const event = await iterator.next();
    if (event.value?.type !== 'question') {
      throw new Error('Expected question event');
    }

    await backend.respondToQuestion(
      session.sessionId,
      event.value.request.requestId,
      {
        Environment: 'production',
        Confirm: 'yes',
      },
    );

    await expect(response).resolves.toEqual({
      answer: 'Environment: production\nConfirm: yes',
      wasFreeform: true,
    });
  });

  it('propagates disabled freeform input for SDK user input requests', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    getUserInputHandler()({
      question: 'Which branch?',
      choices: ['main', 'dev'],
      allowFreeform: false,
    });

    const event = await iterator.next();
    expect(event).toMatchObject({
      value: {
        type: 'question',
        request: {
          questions: [
            {
              question: 'Which branch?',
              allowFreeform: false,
            },
          ],
        },
      },
    });
  });

  it('resolves pending user input requests with fallback on stop', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const response = getUserInputHandler()({
      question: 'Which branch?',
      choices: ['main', 'dev'],
      allowFreeform: true,
    });

    await backend.stop(session.sessionId);

    await expect(response).resolves.toEqual({ answer: '', wasFreeform: true });
  });

  it('keeps duplicate pending permission request IDs distinct', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    const firstDecision = getPermissionHandler()({
      kind: 'read',
      toolCallId: 'perm-1',
      path: '/repo/a.ts',
    });
    const secondDecision = getPermissionHandler()({
      kind: 'read',
      toolCallId: 'perm-1',
      path: '/repo/b.ts',
    });

    const firstEvent = await iterator.next();
    const secondEvent = await iterator.next();
    const firstRequestId =
      firstEvent.value?.type === 'permission-request'
        ? firstEvent.value.request.requestId
        : '';
    const secondRequestId =
      secondEvent.value?.type === 'permission-request'
        ? secondEvent.value.request.requestId
        : '';

    expect(firstRequestId).toBe('perm-1');
    expect(secondRequestId).not.toBe('perm-1');
    await backend.respondToPermission(session.sessionId, firstRequestId, {
      behavior: 'allow',
    });
    await backend.respondToPermission(session.sessionId, secondRequestId, {
      behavior: 'deny',
      message: 'Denied duplicate',
    });

    await expect(firstDecision).resolves.toEqual({ kind: 'approve-once' });
    await expect(secondDecision).resolves.toEqual({
      kind: 'reject',
      feedback: 'Denied duplicate',
    });
  });

  it('sends prompt text and attachments to the SDK session', async () => {
    const backend = createBackend();

    await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
      { type: 'file', filePath: '/repo/a.ts', filename: 'a.ts' },
      {
        type: 'image',
        data: 'base64-image',
        mimeType: 'image/png',
        filename: 'screenshot.png',
      },
    ]);

    expect(mocks.sessionSend).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello\nworld',
        attachments: [
          { type: 'file', path: '/repo/a.ts', displayName: 'a.ts' },
          {
            type: 'blob',
            data: 'base64-image',
            mimeType: 'image/png',
            displayName: 'screenshot.png',
          },
        ],
      }),
    );
  });

  it('persists SDK assistant.message events and emits entries with raw IDs', async () => {
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementation((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const persistRaw = vi.fn<AgentTaskContext['persistRaw']>(
      async () => 'raw-1',
    );
    const backend = createBackend({ persistRaw });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual({
      type: 'session-id',
      sessionId: 'copilot-session-1',
    });
    eventHandler?.({
      type: 'assistant.message',
      data: { content: 'Hello from Copilot' },
    });

    const event = await iterator.next();
    expect(event.value).toMatchObject({
      type: 'entry',
      rawMessageId: 'raw-1',
      entry: {
        type: 'assistant-message',
        value: 'Hello from Copilot',
      },
    });
    expect(persistRaw).toHaveBeenCalledWith({
      messageIndex: 3,
      backendSessionId: 'copilot-session-1',
      rawData: {
        type: 'assistant.message',
        data: { content: 'Hello from Copilot' },
      },
    });
  });

  it('carries assistant usage into idle completion', async () => {
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementation((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const backend = createBackend({ persistRaw: vi.fn(async () => 'raw-1') });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    eventHandler({
      type: 'assistant.usage',
      data: {
        model: 'claude-sonnet-4.5',
        inputTokens: 10,
        outputTokens: 20,
        cacheWriteTokens: 30,
        reasoningTokens: 4,
        duration: 500,
      },
    });
    eventHandler({ type: 'session.idle', data: {} });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'complete',
        result: {
          isError: false,
          model: 'claude-sonnet-4.5',
          durationMs: 500,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationTokens: 30,
            reasoningTokens: 4,
          },
        },
      },
    });
  });

  it('emits and cleans up SDK session errors', async () => {
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementation((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const backend = createBackend({ persistRaw: vi.fn(async () => 'raw-1') });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    eventHandler({
      type: 'session.error',
      data: { error: { message: 'Copilot failed' } },
    });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'error', error: 'Copilot failed' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'complete',
        result: { isError: true, text: 'Copilot failed' },
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
  });

  it('starts raw message indexes from raw session offset when provided', async () => {
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementation((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const persistRaw = vi.fn<AgentTaskContext['persistRaw']>(
      async () => 'raw-1',
    );
    const backend = createBackend({ persistRaw, rawSessionStartIndex: 7 });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    eventHandler({ type: 'session.idle', data: {} });
    await iterator.next();

    expect(persistRaw).toHaveBeenCalledWith({
      messageIndex: 7,
      backendSessionId: 'copilot-session-1',
      rawData: { type: 'session.idle', data: {} },
    });
  });

  it('serializes SDK events and assigns unique sequential message indexes', async () => {
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementation((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const firstPersist = createDeferred<string>();
    const persistRaw = vi
      .fn<AgentTaskContext['persistRaw']>()
      .mockReturnValueOnce(firstPersist.promise)
      .mockResolvedValueOnce('raw-2');
    const backend = createBackend({ persistRaw });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    eventHandler({ type: 'assistant.message', data: { content: 'first' } });
    eventHandler({ type: 'assistant.message', data: { content: 'second' } });
    await Promise.resolve();

    expect(persistRaw).toHaveBeenCalledTimes(1);
    expect(persistRaw).toHaveBeenNthCalledWith(1, {
      messageIndex: 3,
      backendSessionId: 'copilot-session-1',
      rawData: { type: 'assistant.message', data: { content: 'first' } },
    });

    firstPersist.resolve('raw-1');

    await expect(iterator.next()).resolves.toMatchObject({
      value: { rawMessageId: 'raw-1', entry: { value: 'first' } },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { rawMessageId: 'raw-2', entry: { value: 'second' } },
    });
    expect(persistRaw).toHaveBeenNthCalledWith(2, {
      messageIndex: 4,
      backendSessionId: 'copilot-session-1',
      rawData: { type: 'assistant.message', data: { content: 'second' } },
    });
  });

  it('emits error and completion when raw persistence fails', async () => {
    let eventHandler = (_event: { type: string; data: unknown }) => {};
    mocks.sessionOn.mockImplementation((handler) => {
      eventHandler = handler;
      return mocks.unsubscribe;
    });
    const backend = createBackend({
      persistRaw: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    await iterator.next();
    eventHandler({ type: 'assistant.message', data: { content: 'hello' } });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'error', error: 'database unavailable' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'complete',
        result: { isError: true, text: 'database unavailable' },
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
  });

  it('stops the client when session creation fails after startup', async () => {
    mocks.createSession.mockRejectedValueOnce(new Error('session failed'));
    const backend = createBackend();

    await expect(
      backend.start(createConfig(), [{ type: 'text', text: 'hello' }]),
    ).rejects.toThrow('session failed');

    expect(mocks.clientStart).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
  });

  it('cleans up rejected resume without retaining completed allowed tools', async () => {
    mocks.resumeSession.mockRejectedValueOnce(new Error('resume failed'));
    const backend = createBackend();

    await expect(
      backend.start(
        createConfig({
          sessionId: 'sdk-session-1',
          persistedSessionRules: { read: { 'a.ts': 'allow' } },
        }),
        [{ type: 'text', text: 'hello' }],
      ),
    ).rejects.toThrow('resume failed');

    expect(mocks.clientStop).toHaveBeenCalledOnce();
    await expect(backend.stop('jc-session-1')).resolves.toBeUndefined();
    expect(backend.getSessionAllowedTools('jc-session-1')).toEqual([]);
  });

  it('disconnects, stops, and removes the session when subscription setup throws', async () => {
    mocks.sessionOn.mockImplementationOnce(() => {
      throw new Error('subscribe failed');
    });
    const backend = createBackend();

    await expect(
      backend.start(createConfig(), [{ type: 'text', text: 'hello' }]),
    ).rejects.toThrow('subscribe failed');

    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    await expect(backend.stop('copilot-session-1')).resolves.toBeUndefined();
  });

  it('unsubscribes, disconnects, stops, and removes the session when send throws', async () => {
    mocks.sessionSend.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    const backend = createBackend();

    await expect(
      backend.start(createConfig(), [{ type: 'text', text: 'hello' }]),
    ).rejects.toThrow('send failed');

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    await expect(backend.stop('copilot-session-1')).resolves.toBeUndefined();
  });

  it('aborts, disconnects, and closes the event channel on stop', async () => {
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await backend.stop(session.sessionId);

    expect(mocks.sessionAbort).toHaveBeenCalledOnce();
    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('closes the event channel on stop even when SDK cleanup rejects', async () => {
    mocks.sessionAbort.mockRejectedValueOnce(new Error('abort failed'));
    mocks.sessionDisconnect.mockRejectedValueOnce(
      new Error('disconnect failed'),
    );
    mocks.clientStop.mockRejectedValueOnce(new Error('stop failed'));
    const backend = createBackend();
    const session = await backend.start(createConfig(), [
      { type: 'text', text: 'hello' },
    ]);
    const iterator = session.events[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    await expect(backend.stop(session.sessionId)).resolves.toBeUndefined();

    expect(mocks.sessionAbort).toHaveBeenCalledOnce();
    expect(mocks.sessionDisconnect).toHaveBeenCalledOnce();
    expect(mocks.clientStop).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});

function createBackend(
  overrides: Partial<AgentTaskContext> = {},
): CopilotBackend {
  return new CopilotBackend({
    taskId: 'task-1',
    sessionStartIndex: 3,
    persistRaw: vi.fn(async () => 'raw-1'),
    ...overrides,
  });
}

function createConfig(
  overrides: {
    model?: string;
    thinkingEffort?: 'default' | 'high';
    interactionMode?: 'ask' | 'auto' | 'plan';
    permissionRules?: ResolvedPermissionRule[];
    persistedSessionRules?: PermissionScope;
    sessionId?: string;
    mcpServers?: Record<
      string,
      { command: string; args?: string[]; env?: Record<string, string> }
    >;
  } = {},
) {
  return {
    type: 'copilot' as const,
    cwd: '/repo',
    interactionMode: 'plan' as const,
    model: 'default',
    ...overrides,
  };
}

function getPermissionHandler(): (
  request: Record<string, unknown>,
) => unknown | Promise<unknown> {
  const config = getLastSessionConfig() as {
    onPermissionRequest?: (
      request: Record<string, unknown>,
    ) => unknown | Promise<unknown>;
  };
  if (!config.onPermissionRequest) {
    throw new Error('Missing onPermissionRequest handler');
  }
  return config.onPermissionRequest;
}

function getUserInputHandler(): (
  request: Record<string, unknown>,
) => unknown | Promise<unknown> {
  const config = getLastSessionConfig() as {
    onUserInputRequest?: (
      request: Record<string, unknown>,
    ) => unknown | Promise<unknown>;
  };
  if (!config.onUserInputRequest) {
    throw new Error('Missing onUserInputRequest handler');
  }
  return config.onUserInputRequest;
}

function getLastSessionConfig() {
  return (
    mocks.createSession.mock.calls.at(-1)?.[0] ??
    mocks.resumeSession.mock.calls.at(-1)?.[1]
  );
}

function createSdkSession(
  sessionId = 'copilot-session-1',
  options: { sendAndWait?: boolean } = {},
) {
  const session = {
    sessionId,
    on: mocks.sessionOn,
    send: mocks.sessionSend,
    abort: mocks.sessionAbort,
    disconnect: mocks.sessionDisconnect,
  };
  return options.sendAndWait === false
    ? session
    : { ...session, sendAndWait: mocks.sessionSendAndWait };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
