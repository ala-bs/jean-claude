import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildJcMcpServersConfigForCwd } from './jc-mcp-config';
import { buildSessionIdStepUpdate } from './agent-session-update';
import { JcMcpBridgeService } from './jc-mcp-bridge-service';
import { QuestionBrokerService } from './question-broker-service';

const QUESTIONS = [
  {
    id: 'approach',
    type: 'single_choice' as const,
    label: 'Which approach?',
    options: [{ label: 'Small' }, { label: 'Large' }],
  },
];

describe('buildSessionIdStepUpdate', () => {
  it('does not overwrite model settings when backend stays the same', () => {
    expect(
      buildSessionIdStepUpdate({
        sessionId: 'session-1',
        backendType: 'claude-code',
        requestedBackendType: 'claude-code',
      }),
    ).toEqual({
      sessionId: 'session-1',
      agentBackend: 'claude-code',
    });
  });

  it('clears stale model settings when backend changes without explicit overrides', () => {
    expect(
      buildSessionIdStepUpdate({
        sessionId: 'session-1',
        backendType: 'opencode',
        requestedBackendType: 'claude-code',
      }),
    ).toEqual({
      sessionId: 'session-1',
      agentBackend: 'opencode',
      modelPreference: 'default',
      thinkingEffort: 'default',
    });
  });

  it('persists explicit swap overrides when backend changes', () => {
    expect(
      buildSessionIdStepUpdate({
        sessionId: 'session-1',
        backendType: 'opencode',
        requestedBackendType: 'claude-code',
        swapModel: 'openai/gpt-5.1',
        swapThinkingEffort: 'high',
      }),
    ).toEqual({
      sessionId: 'session-1',
      agentBackend: 'opencode',
      modelPreference: 'openai/gpt-5.1',
      thinkingEffort: 'high',
    });
  });
});

describe('buildJcMcpServersConfigForCwd', () => {
  it('injects question bridge settings through server env by default', () => {
    const config = buildJcMcpServersConfigForCwd({
      cwd: '/tmp/worktree',
      questionBridge: {
        serverUrl: 'http://127.0.0.1:4321',
        sessionId: 'session-1',
        token: 'token-1',
      },
    });

    expect(config['jean-claude-mcp']).toEqual({
      command: 'node',
      args: expect.arrayContaining([
        '--workdir',
        '/tmp/worktree',
      ]),
      env: {
        JC_MCP_BRIDGE_URL: 'http://127.0.0.1:4321',
        JC_MCP_SESSION_ID: 'session-1',
        JC_MCP_AUTH_TOKEN: 'token-1',
      },
    });
    expect(config['jean-claude-mcp'].args.join(' ')).not.toContain('token-1');
  });

  it('can inject question bridge settings through argv for OpenCode runtime MCP', () => {
    const config = buildJcMcpServersConfigForCwd({
      cwd: '/tmp/worktree',
      environmentMode: 'argv',
      questionBridge: {
        serverUrl: 'http://127.0.0.1:4321',
        sessionId: 'session-1',
        token: 'token-1',
      },
    });

    expect(config['jean-claude-mcp']).toEqual({
      command: '/usr/bin/env',
      args: expect.arrayContaining([
        'JC_MCP_BRIDGE_URL=http://127.0.0.1:4321',
        'JC_MCP_SESSION_ID=session-1',
        'JC_MCP_AUTH_TOKEN=token-1',
        'node',
        '--workdir',
        '/tmp/worktree',
      ]),
    });
    expect(config['jean-claude-mcp']).not.toHaveProperty('env');
  });

  it('can omit the per-session id for app-scoped bridge settings', () => {
    const config = buildJcMcpServersConfigForCwd({
      cwd: '/tmp/worktree',
      questionBridge: {
        serverUrl: 'http://127.0.0.1:4321',
        token: 'token-1',
      },
    });

    expect(config['jean-claude-mcp'].env).toEqual({
      JC_MCP_BRIDGE_URL: 'http://127.0.0.1:4321',
      JC_MCP_AUTH_TOKEN: 'token-1',
    });
    expect(config['jean-claude-mcp'].env).not.toHaveProperty(
      'JC_MCP_SESSION_ID',
    );
  });
});

describe('JcMcpBridgeService', () => {
  let bridge: JcMcpBridgeService | null = null;

  afterEach(async () => {
    await bridge?.close('test cleanup');
    bridge = null;
  });

  it('registers multiple active step routes on one app bridge', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const onStep1QuestionRequest = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Small' });
    });
    const onStep2QuestionRequest = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Large' });
    });

    const step1Config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: onStep1QuestionRequest,
    });
    const step2Config = await bridge.registerStep({
      taskId: 'task-2',
      stepId: 'step-2',
      onQuestionRequest: onStep2QuestionRequest,
    });

    expect(step2Config).toMatchObject({
      serverUrl: step1Config.serverUrl,
      token: step1Config.token,
    });
    expect(step2Config.registrationId).not.toBe(step1Config.registrationId);

    const step1Response = await askQuestion({
      config: step1Config,
      stepId: 'step-1',
    });
    const step2Response = await askQuestion({
      config: step2Config,
      stepId: 'step-2',
    });

    await expect(step1Response.json()).resolves.toEqual({
      summary: 'Which approach?: Small',
    });
    await expect(step2Response.json()).resolves.toEqual({
      summary: 'Which approach?: Large',
    });
    expect(step1Response.status).toBe(200);
    expect(step2Response.status).toBe(200);
    expect(onStep1QuestionRequest).toHaveBeenCalledTimes(1);
    expect(onStep2QuestionRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps step question answers isolated by stepId', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const onStep1QuestionRequest = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Small' });
    });
    const onStep2QuestionRequest = vi.fn();
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: onStep1QuestionRequest,
    });
    await bridge.registerStep({
      taskId: 'task-2',
      stepId: 'step-2',
      onQuestionRequest: onStep2QuestionRequest,
    });

    const response = await askQuestion({ config, stepId: 'step-1' });

    await expect(response.json()).resolves.toEqual({
      summary: 'Which approach?: Small',
    });
    expect(response.status).toBe(200);
    expect(onStep1QuestionRequest).toHaveBeenCalledTimes(1);
    expect(onStep2QuestionRequest).not.toHaveBeenCalled();
    expect(broker.getPendingRequestsForStep('step-2')).toHaveLength(0);
  });

  it('rejects step routing without the matching registration id', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const onStep1QuestionRequest = vi.fn();
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: onStep1QuestionRequest,
    });

    const response = await askQuestion({
      config: { serverUrl: config.serverUrl, token: config.token },
      stepId: 'step-1',
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Invalid registration',
    });
    expect(onStep1QuestionRequest).not.toHaveBeenCalled();
  });

  it('routes missing stepId to the only active step', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(async (request) => {
        broker.answerRequest(request.requestId, { approach: 'Small' });
      }),
    });

    const response = await askQuestion({ config });

    await expect(response.json()).resolves.toEqual({
      summary: 'Which approach?: Small',
    });
    expect(response.status).toBe(200);
  });

  it('rejects missing stepId when multiple steps are active', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(),
    });
    await bridge.registerStep({
      taskId: 'task-2',
      stepId: 'step-2',
      onQuestionRequest: vi.fn(),
    });

    const response = await askQuestion({ config });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Missing stepId' });
  });

  it('unregisters a step route on session cleanup', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(),
    });

    await bridge.unregisterStep('step-1');

    const response = await askQuestion({ config, stepId: 'step-1' });

    expect(response.status).toBe(404);
  });

  it('updates an existing step route when the same step is registered again', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const firstHandler = vi.fn();
    const secondHandler = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Large' });
    });

    const firstConfig = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: firstHandler,
    });
    const secondConfig = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: secondHandler,
    });

    expect(secondConfig).toMatchObject({
      serverUrl: firstConfig.serverUrl,
      token: firstConfig.token,
    });
    expect(secondConfig.registrationId).not.toBe(firstConfig.registrationId);

    const response = await askQuestion({ config: secondConfig, stepId: 'step-1' });

    await expect(response.json()).resolves.toEqual({
      summary: 'Which approach?: Large',
    });
    expect(response.status).toBe(200);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it('does not let stale unregister remove a newer registration for the same step', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    const firstHandler = vi.fn();
    const secondHandler = vi.fn(async (request) => {
      broker.answerRequest(request.requestId, { approach: 'Large' });
    });

    const firstConfig = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: firstHandler,
    });
    const secondConfig = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: secondHandler,
    });

    await bridge.unregisterStep('step-1', firstConfig.registrationId);

    const response = await askQuestion({ config: secondConfig, stepId: 'step-1' });

    await expect(response.json()).resolves.toEqual({
      summary: 'Which approach?: Large',
    });
    expect(response.status).toBe(200);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it('does not let stale unregister cancel a newer in-flight request for the same step', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    let requestId: string | null = null;
    const firstConfig = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(),
    });
    const secondConfig = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
      }),
    });

    const responsePromise = askQuestion({
      config: secondConfig,
      stepId: 'step-1',
    });
    responsePromise.catch(() => {});

    await vi.waitFor(() => {
      expect(requestId).not.toBeNull();
    });

    await bridge.unregisterStep('step-1', firstConfig.registrationId);

    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(1);

    broker.answerRequest(requestId!, { approach: 'Large' });
    const response = await responsePromise;

    await expect(response.json()).resolves.toEqual({
      summary: 'Which approach?: Large',
    });
    expect(response.status).toBe(200);
  });

  it('closes while a shared bridge request is still notifying the agent service', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    let requestId: string | null = null;
    const onQuestionCancelled = vi.fn();
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
        await new Promise(() => {});
      }),
      onQuestionCancelled,
    });

    const responsePromise = askQuestion({ config, stepId: 'step-1' });
    responsePromise.catch(() => {});

    await vi.waitFor(() => {
      expect(requestId).not.toBeNull();
    });

    await expect(withTimeout(bridge.close('shutdown during notify'))).resolves.toBe(
      undefined,
    );
    bridge = null;

    await expect(responsePromise).rejects.toThrow();
    expect(onQuestionCancelled).toHaveBeenCalledWith(requestId);
    expect(broker.getPendingRequestsForStep('step-1')).toHaveLength(0);
  });
});

async function askQuestion({
  config,
  stepId,
}: {
  config: { serverUrl: string; token: string; registrationId?: string };
  stepId?: string;
}): Promise<Response> {
  return fetch(`${config.serverUrl}/ask-question`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ...(stepId ? { stepId } : {}),
      ...(config.registrationId
        ? { registrationId: config.registrationId }
        : {}),
      questions: QUESTIONS,
    }),
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 1_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
