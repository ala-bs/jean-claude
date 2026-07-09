import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent, PromptPart } from '@shared/agent-backend-types';
import type { AgentRunHandle } from '@shared/agent-backend-provider-types';

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

const {
  agentMessageRepositoryMock,
  applyConfiguredPromptPrefaceMock,
  browserWindowGetAllWindowsMock,
  buildToolPermissionConfigMock,
  claudeCompactRawMessagesForTaskMock,
  emitStepUpsertMock,
  emitTaskUpsertMock,
  getProviderMock,
  legacyBackendConstructorMock,
  normalizeToolRequestMock,
  openCodeCompactRawMessagesForTaskMock,
  pathExistsMock,
  projectRepositoryMock,
  providerCalls,
  providerState,
  rawMessageRepositoryMock,
  readSettingsMock,
  resetProviderState,
  resolveGlobalRulesMock,
  resolveRulesMock,
  settingsRepositoryMock,
  stepServiceMock,
  taskRepositoryMock,
  taskStepRepositoryMock,
  notificationServiceMock,
  resourceMonitorMock,
  usageTrackingServiceMock,
  webContentsSendMock,
} = vi.hoisted(() => {
  const providerCalls = {
    runStarts: [] as unknown[],
    permissions: [] as unknown[],
    questions: [] as unknown[],
    modes: [] as unknown[],
    sessionAllowedTools: [] as unknown[],
    stops: [] as string[],
  };

  const providerState = {
    permissionsSupported: true,
    questionsSupported: true,
    runtimeModeSwitchSupported: true,
    sessionAllowedToolsSupported: true,
    permissionResponseError: null as Error | null,
    questionResponseError: null as Error | null,
    runStartImplementation: null as
      | ((input: unknown) => Promise<AgentRunHandle>)
      | null,
    sessionAllowedTools: [] as string[],
  };

  const unsupported = (reason: string) => ({ supported: false, reason });
  const supported = (implementation: unknown) => ({
    supported: true,
    implementation,
  });

  function createProvider() {
    return {
      id: 'claude-code',
      label: 'Claude Code',
      capabilities: {
        agent: {
          run: supported({
            start: async (input: unknown) => {
              providerCalls.runStarts.push(input);
              if (!providerState.runStartImplementation) {
                throw new Error('runStartImplementation not configured');
              }
              return providerState.runStartImplementation(input);
            },
          }),
          permissions: providerState.permissionsSupported
            ? supported({
                respond: async (input: unknown) => {
                  if (providerState.permissionResponseError) {
                    throw providerState.permissionResponseError;
                  }
                  providerCalls.permissions.push(input);
                },
              })
            : unsupported('permissions unsupported'),
          questions: providerState.questionsSupported
            ? supported({
                respond: async (input: unknown) => {
                  if (providerState.questionResponseError) {
                    throw providerState.questionResponseError;
                  }
                  providerCalls.questions.push(input);
                },
              })
            : unsupported('questions unsupported'),
          runtimeModeSwitch: providerState.runtimeModeSwitchSupported
            ? supported({
                setMode: async (input: unknown) => {
                  providerCalls.modes.push(input);
                },
              })
            : unsupported('mode switching unsupported'),
          sessionAllowedTools: providerState.sessionAllowedToolsSupported
            ? supported({
                list: (input: unknown) => {
                  providerCalls.sessionAllowedTools.push(input);
                  return providerState.sessionAllowedTools;
                },
              })
            : unsupported('session tools unsupported'),
          resourceTracking: supported({
            getRootPid: ({ handle }: { handle: AgentRunHandle }) =>
              handle.rootPid ?? null,
          }),
        },
      },
    };
  }

  function resetProviderState() {
    providerCalls.runStarts.length = 0;
    providerCalls.permissions.length = 0;
    providerCalls.questions.length = 0;
    providerCalls.modes.length = 0;
    providerCalls.sessionAllowedTools.length = 0;
    providerCalls.stops.length = 0;
    providerState.permissionsSupported = true;
    providerState.questionsSupported = true;
    providerState.runtimeModeSwitchSupported = true;
    providerState.sessionAllowedToolsSupported = true;
    providerState.permissionResponseError = null;
    providerState.questionResponseError = null;
    providerState.runStartImplementation = null;
    providerState.sessionAllowedTools = [];
  }

  return {
    agentMessageRepositoryMock: {
      getMessageCountByStepId: vi.fn(),
      create: vi.fn(),
      updateEntry: vi.fn(),
      updateToolResult: vi.fn(),
      findByStepId: vi.fn(),
      findWithRawDataByTaskId: vi.fn(),
      reprocessNormalization: vi.fn(),
    },
    applyConfiguredPromptPrefaceMock: vi.fn(),
    browserWindowGetAllWindowsMock: vi.fn(() => []),
    buildToolPermissionConfigMock: vi.fn(),
    claudeCompactRawMessagesForTaskMock: vi.fn(),
    emitStepUpsertMock: vi.fn(),
    emitTaskUpsertMock: vi.fn(),
    getProviderMock: vi.fn(() => createProvider()),
    legacyBackendConstructorMock: vi.fn(() => {
      throw new Error('legacy backend class should not be constructed');
    }),
    normalizeToolRequestMock: vi.fn(),
    openCodeCompactRawMessagesForTaskMock: vi.fn(),
    notificationServiceMock: {
      close: vi.fn(),
      notify: vi.fn(),
    },
    pathExistsMock: vi.fn(),
    projectRepositoryMock: {
      findById: vi.fn(),
    },
    providerCalls,
    providerState,
    rawMessageRepositoryMock: {
      getMessageCountByStepId: vi.fn(),
      create: vi.fn(),
      updateRawData: vi.fn(),
    },
    readSettingsMock: vi.fn(),
    resetProviderState,
    resolveGlobalRulesMock: vi.fn(),
    resolveRulesMock: vi.fn(),
    settingsRepositoryMock: {
      get: vi.fn(),
    },
    stepServiceMock: {
      update: vi.fn(),
      syncTaskStatus: vi.fn(),
      resolveAndValidate: vi.fn(),
      completeStep: vi.fn(),
      errorStep: vi.fn(),
      interruptStep: vi.fn(),
    },
    taskRepositoryMock: {
      findById: vi.fn(),
      update: vi.fn(),
      setHasUnread: vi.fn(),
      findByStatuses: vi.fn(),
    },
    taskStepRepositoryMock: {
      findById: vi.fn(),
      update: vi.fn(),
      findByTaskId: vi.fn(),
      findByStatus: vi.fn(),
    },
    resourceMonitorMock: {
      setSnapshotListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    },
    usageTrackingServiceMock: {
      recordUsage: vi.fn(),
      recordUsageSafe: vi.fn(),
    },
    webContentsSendMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/app'),
  },
  BrowserWindow: {
    getAllWindows: browserWindowGetAllWindowsMock,
  },
}));

vi.mock('../database/repositories', () => ({
  AgentMessageRepository: agentMessageRepositoryMock,
  ProjectRepository: projectRepositoryMock,
  RawMessageRepository: rawMessageRepositoryMock,
  TaskRepository: taskRepositoryMock,
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: settingsRepositoryMock,
}));

vi.mock('../database/repositories/task-steps', () => ({
  TaskStepRepository: taskStepRepositoryMock,
}));

vi.mock('../lib/debug', () => ({
  dbg: new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ),
}));

vi.mock('../lib/fs', () => ({
  pathExists: pathExistsMock,
}));

vi.mock('./agent-backends', () => ({
  AGENT_BACKEND_CLASSES: {
    'claude-code': legacyBackendConstructorMock,
    opencode: legacyBackendConstructorMock,
    codex: legacyBackendConstructorMock,
  },
}));

vi.mock('./agent-backends/claude/claude-code-backend', () => ({
  ClaudeCodeBackend: {
    compactRawMessagesForTask: claudeCompactRawMessagesForTaskMock,
  },
}));

vi.mock('./agent-backends/opencode/opencode-backend', () => ({
  OpenCodeBackend: {
    compactRawMessagesForTask: openCodeCompactRawMessagesForTaskMock,
  },
}));

vi.mock('./agent-backends/providers', () => ({
  getAgentBackendProvider: getProviderMock,
}));

vi.mock('./agent-resource-monitor-service', () => ({
  agentResourceMonitorService: resourceMonitorMock,
}));

vi.mock('./ai-usage-tracking-service', () => ({
  aiUsageTrackingService: usageTrackingServiceMock,
}));

vi.mock('./cache-event-service', () => ({
  emitStepUpsert: emitStepUpsertMock,
  emitTaskUpsert: emitTaskUpsertMock,
}));

vi.mock('./global-permissions-service', () => ({
  resolveGlobalRules: resolveGlobalRulesMock,
}));

vi.mock('./mcp-template-service', () => ({
  getJcMcpServerPath: vi.fn(() => '/tmp/jc-mcp.js'),
}));

vi.mock('./name-generation-service', () => ({
  generateTaskName: vi.fn(),
}));

vi.mock('./notification-service', () => ({
  notificationService: notificationServiceMock,
}));

vi.mock('./permission-settings-service', () => ({
  buildToolPermissionConfig: buildToolPermissionConfigMock,
  normalizeToolRequest: normalizeToolRequestMock,
  readSettings: readSettingsMock,
  resolveRules: resolveRulesMock,
}));

vi.mock('./prompt-preface-service', () => ({
  applyConfiguredPromptPreface: applyConfiguredPromptPrefaceMock,
}));

vi.mock('./step-service', () => ({
  StepService: stepServiceMock,
}));

vi.mock('./system-project-service', () => ({
  assertValidWorkspacePath: vi.fn(),
}));

import { agentService } from './agent-service';

const defaultStep = {
  id: 'step-1',
  taskId: 'task-1',
  name: 'Step 1',
  type: 'agent',
  dependsOn: [],
  promptTemplate: 'Original prompt',
  resolvedPrompt: null,
  status: 'ready',
  sessionId: null,
  interactionMode: 'ask',
  modelPreference: 'default',
  thinkingEffort: 'default',
  agentBackend: 'claude-code',
  output: null,
  images: null,
  meta: {},
  autoStart: false,
  sortOrder: 0,
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

const defaultTask = {
  id: 'task-1',
  projectId: 'project-1',
  type: 'agent',
  name: 'Task 1',
  prompt: 'Task prompt',
  status: 'ready',
  worktreePath: '/repo/worktree',
  startCommitHash: null,
  sourceBranch: null,
  branchName: null,
  hasUnread: false,
  userCompleted: false,
  sessionRules: {},
  workItemIds: null,
  workItemUrls: null,
  pullRequestId: null,
  pullRequestUrl: null,
  pendingMessage: null,
  todoItems: [],
  parentTaskId: null,
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

const defaultProject = {
  id: 'project-1',
  name: 'Project 1',
  path: '/repo/project',
};

function createHandle({
  events = [],
  runId = 'provider-run-1',
  rootPid = 123,
}: {
  events?: AgentEvent[];
  runId?: string;
  rootPid?: number;
} = {}): AgentRunHandle {
  const handle: AgentRunHandle = {
    runId,
    events: (async function* () {
      for (const event of events) {
        yield event;
      }
    })(),
    rootPid,
    stop: vi.fn(async () => {
      providerCalls.stops.push(runId);
    }),
    dispose: vi.fn(),
  };
  return handle;
}

function createWaitingHandle(firstEvent: AgentEvent): {
  handle: AgentRunHandle;
  release: () => void;
} {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const handle: AgentRunHandle = {
    runId: 'provider-run-1',
    events: (async function* () {
      yield firstEvent;
      await released;
    })(),
    rootPid: 123,
    stop: vi.fn(async () => {
      providerCalls.stops.push('provider-run-1');
      release();
    }),
    dispose: vi.fn(),
  };

  return { handle, release };
}

function createIdleHandle(runId = 'provider-run-1'): {
  handle: AgentRunHandle;
  release: () => void;
} {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const handle: AgentRunHandle = {
    runId,
    events: {
      [Symbol.asyncIterator]() {
        let completed = false;
        return {
          async next() {
            if (!completed) {
              completed = true;
              await released;
            }
            return {
              done: true,
              value: undefined as unknown as AgentEvent,
            };
          },
        };
      },
    },
    rootPid: 123,
    stop: vi.fn(async () => {
      providerCalls.stops.push(runId);
      release();
    }),
    dispose: vi.fn(),
  };

  return { handle, release };
}

function createCompleteThenWaitHandle({
  runId,
  waitBeforeComplete,
}: {
  runId: string;
  waitBeforeComplete: Promise<void>;
}): AgentRunHandle {
  const handle: AgentRunHandle = {
    runId,
    events: (async function* () {
      await waitBeforeComplete;
      yield completeEvent();
    })(),
    rootPid: 123,
    stop: vi.fn(async () => {
      providerCalls.stops.push(runId);
    }),
    dispose: vi.fn(),
  };

  return handle;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function completeEvent(isError = false): AgentEvent {
  return {
    type: 'complete',
    result: {
      isError,
      text: isError ? 'failed' : 'done',
    },
  };
}

function setDefaultMocks(): void {
  browserWindowGetAllWindowsMock.mockReturnValue([]);

  taskStepRepositoryMock.findById.mockResolvedValue(defaultStep);
  taskStepRepositoryMock.update.mockImplementation(async (_id, update) => ({
    ...defaultStep,
    ...update,
  }));
  taskStepRepositoryMock.findByTaskId.mockResolvedValue([defaultStep]);
  taskStepRepositoryMock.findByStatus.mockResolvedValue([]);

  taskRepositoryMock.findById.mockResolvedValue(defaultTask);
  taskRepositoryMock.update.mockImplementation(async (_id, update) => ({
    ...defaultTask,
    ...update,
  }));
  taskRepositoryMock.setHasUnread.mockResolvedValue(undefined);
  taskRepositoryMock.findByStatuses.mockResolvedValue([]);

  projectRepositoryMock.findById.mockResolvedValue(defaultProject);
  rawMessageRepositoryMock.create.mockResolvedValue({ id: 'raw-1' });
  rawMessageRepositoryMock.updateRawData.mockResolvedValue(undefined);
  agentMessageRepositoryMock.getMessageCountByStepId.mockResolvedValue(0);
  rawMessageRepositoryMock.getMessageCountByStepId.mockResolvedValue(0);
  agentMessageRepositoryMock.create.mockResolvedValue({ id: 'message-1' });
  agentMessageRepositoryMock.updateEntry.mockResolvedValue(undefined);
  agentMessageRepositoryMock.updateToolResult.mockResolvedValue(undefined);
  agentMessageRepositoryMock.findByStepId.mockResolvedValue([]);
  agentMessageRepositoryMock.findWithRawDataByTaskId.mockResolvedValue([]);
  agentMessageRepositoryMock.reprocessNormalization.mockResolvedValue(0);

  settingsRepositoryMock.get.mockResolvedValue({
    modes: {
      completed: 'disabled',
      'permission-required': 'disabled',
      question: 'disabled',
      errored: 'disabled',
    },
  });

  stepServiceMock.update.mockResolvedValue(defaultStep);
  stepServiceMock.syncTaskStatus.mockResolvedValue(undefined);
  stepServiceMock.resolveAndValidate.mockResolvedValue({
    resolvedPrompt: 'Resolved prompt',
    step: defaultStep,
    warnings: [],
  });
  stepServiceMock.completeStep.mockResolvedValue([]);
  stepServiceMock.errorStep.mockResolvedValue(undefined);
  stepServiceMock.interruptStep.mockResolvedValue(undefined);

  readSettingsMock.mockResolvedValue({ version: 1, permissions: { project: {} } });
  resolveGlobalRulesMock.mockResolvedValue([]);
  resolveRulesMock.mockReturnValue([]);
  pathExistsMock.mockResolvedValue(true);
  applyConfiguredPromptPrefaceMock.mockImplementation(
    async ({ parts }: { parts: PromptPart[] }) => parts,
  );
  normalizeToolRequestMock.mockReturnValue({
    tool: 'bash',
    matchValue: 'npm test',
  });
  buildToolPermissionConfigMock.mockImplementation(
    ({ existing, matchValue }) => ({
      ...(typeof existing === 'object' && existing !== null ? existing : {}),
      [matchValue]: 'allow',
    }),
  );
}

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

  it('returns a question request id before the user answers', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    let requestId: string | null = null;
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
      }),
    });

    const response = await submitQuestion({ config, stepId: 'step-1' });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ requestId });
    expect(requestId).not.toBeNull();
    const pendingResponse = await getQuestionResult({ config, requestId: requestId! });
    expect(pendingResponse.status).toBe(202);
    await expect(pendingResponse.json()).resolves.toEqual({ status: 'pending' });
  });

  it('returns a completed question result once and then forgets it', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    let requestId: string | null = null;
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
      }),
    });

    const response = await submitQuestion({ config, stepId: 'step-1' });
    expect(response.status).toBe(202);
    broker.answerRequest(requestId!, { approach: 'Small' });

    const resultResponse = await getQuestionResult({
      config,
      requestId: requestId!,
    });
    expect(resultResponse.status).toBe(200);
    await expect(resultResponse.json()).resolves.toEqual({
      summary: 'Which approach?: Small',
    });

    const secondResultResponse = await getQuestionResult({
      config,
      requestId: requestId!,
    });
    expect(secondResultResponse.status).toBe(404);
  });

  it('returns cancelled question results after a step unregisters', async () => {
    const broker = new QuestionBrokerService();
    bridge = new JcMcpBridgeService(broker);
    let requestId: string | null = null;
    const onQuestionCancelled = vi.fn();
    const config = await bridge.registerStep({
      taskId: 'task-1',
      stepId: 'step-1',
      onQuestionRequest: vi.fn(async (request) => {
        requestId = request.requestId;
      }),
      onQuestionCancelled,
    });

    const response = await submitQuestion({ config, stepId: 'step-1' });
    expect(response.status).toBe(202);

    await bridge.unregisterStep('step-1', config.registrationId);

    const resultResponse = await getQuestionResult({
      config,
      requestId: requestId!,
    });
    expect(resultResponse.status).toBe(409);
    await expect(resultResponse.json()).resolves.toEqual({
      error: 'Agent session ended',
    });
    expect(onQuestionCancelled).toHaveBeenCalledWith(requestId);
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
  const response = await submitQuestion({ config, stepId });
  if (response.status !== 202) {
    return response;
  }

  const body = (await response.json()) as { requestId: string };
  while (true) {
    const resultResponse = await getQuestionResult({
      config,
      requestId: body.requestId,
    });
    if (resultResponse.status !== 202) {
      return resultResponse;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function submitQuestion({
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

async function getQuestionResult({
  config,
  requestId,
}: {
  config: { serverUrl: string; token: string };
  requestId: string;
}): Promise<Response> {
  return fetch(`${config.serverUrl}/question-result`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ requestId }),
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
describe('agentService provider runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderState();
    setDefaultMocks();
  });

  afterEach(async () => {
    await agentService.stopAll({ reason: 'shutdown' }).catch(() => {});
  });

  it('starts active runs through the provider without constructing legacy backend classes', async () => {
    const handle = createHandle({ events: [completeEvent()] });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    expect(getProviderMock).toHaveBeenCalledWith('claude-code');
    expect(legacyBackendConstructorMock).not.toHaveBeenCalled();
    expect(providerCalls.runStarts[0]).toMatchObject({
      context: {
        taskId: 'task-1',
        sessionStartIndex: 0,
      },
      config: {
        type: 'claude-code',
        cwd: '/repo/worktree',
        interactionMode: 'ask',
        persistedSessionRules: {},
        permissionRules: [],
      },
      parts: [{ type: 'text', text: 'Resolved prompt' }],
    });
    expect(resourceMonitorMock.start).toHaveBeenCalledWith({
      taskId: 'task-1',
      stepId: 'step-1',
      backend: 'claude-code',
      rootPid: 123,
    });
    await waitForAssertion(() => {
      expect(handle.stop).toHaveBeenCalled();
      expect(handle.dispose).toHaveBeenCalledTimes(1);
    });
  });

  it('persists a synthetic user prompt for Vibe so prompt groups can form', async () => {
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      agentBackend: 'vibe',
    });
    const handle = createHandle({ events: [completeEvent()] });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');

    await waitForAssertion(() => {
      expect(agentMessageRepositoryMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          stepId: 'step-1',
          rawMessageId: null,
          entry: expect.objectContaining({
            isSynthetic: true,
            type: 'user-prompt',
            value: 'Resolved prompt',
            isSDKSynthetic: true,
          }),
        }),
      );
    });
    expect(providerCalls.runStarts[0]).toMatchObject({
      config: { type: 'vibe' },
      parts: [{ type: 'text', text: 'Resolved prompt' }],
    });
  });

  it('records result update usage snapshots in event order with a stable source id', async () => {
    const firstUsageRecorded = createDeferred<void>();
    const handle = createHandle({
      events: [
        { type: 'session-id', sessionId: 'vibe-session-1' },
        {
          type: 'result-update',
          result: {
            isError: false,
            cost: { costUsd: 0.25 },
            usage: { inputTokens: 42, outputTokens: 0 },
          },
        },
        {
          type: 'result-update',
          result: {
            isError: false,
            cost: { costUsd: 0.5 },
            usage: { inputTokens: 84, outputTokens: 0 },
          },
        },
        completeEvent(),
      ],
    });
    providerState.runStartImplementation = async () => handle;
    usageTrackingServiceMock.recordUsage
      .mockReturnValueOnce(firstUsageRecorded.promise)
      .mockResolvedValueOnce(undefined);

    const startPromise = agentService.start('step-1');

    await waitForAssertion(() => {
      expect(usageTrackingServiceMock.recordUsage).toHaveBeenCalledTimes(1);
    });
    expect(usageTrackingServiceMock.recordUsage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceId: 'agent-result-update:vibe-session-1',
        usage: { inputTokens: 42, outputTokens: 0 },
      }),
    );
    await expect(startPromise).resolves.toBeUndefined();
    expect(usageTrackingServiceMock.recordUsage).toHaveBeenCalledTimes(1);

    firstUsageRecorded.resolve();
    await waitForAssertion(() => {
      expect(usageTrackingServiceMock.recordUsage).toHaveBeenCalledTimes(2);
    });
    expect(usageTrackingServiceMock.recordUsage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceId: 'agent-result-update:vibe-session-1',
        usage: { inputTokens: 84, outputTokens: 0 },
      }),
    );
  });

  it('cleans up startup session when prompt resolution fails', async () => {
    stepServiceMock.resolveAndValidate
      .mockRejectedValueOnce(new Error('summary failed'))
      .mockResolvedValueOnce({
        resolvedPrompt: 'Resolved prompt after retry',
        step: defaultStep,
        warnings: [],
      });
    const handle = createHandle({ events: [completeEvent()] });
    providerState.runStartImplementation = async () => handle;

    await expect(agentService.start('step-1')).resolves.toBeUndefined();
    await agentService.start('step-1');

    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });
    expect((providerCalls.runStarts[0] as { parts: PromptPart[] }).parts).toEqual([
      { type: 'text', text: 'Resolved prompt after retry' },
    ]);
    expect(stepServiceMock.errorStep).toHaveBeenCalledWith('step-1');
  });

  it('stops the provider run handle when stop races with startup', async () => {
    const startDeferred = createDeferred<AgentRunHandle>();
    const handle = createHandle();
    providerState.runStartImplementation = async () => startDeferred.promise;

    const startPromise = agentService.start('step-1');

    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    const stopPromise = agentService.stop('step-1');
    startDeferred.resolve(handle);

    await stopPromise;
    await startPromise;

    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(providerCalls.stops).toContain('provider-run-1');
  });

  it('shares one stop workflow for concurrent stop calls', async () => {
    const { handle } = createIdleHandle();
    providerState.runStartImplementation = async () => handle;
    browserWindowGetAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: webContentsSendMock,
        },
      },
    ] as never);

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    const stopOne = agentService.stop('step-1');
    const stopTwo = agentService.stop('step-1');

    await Promise.all([stopOne, stopTwo]);
    await startPromise;

    const interruptionEntries = agentMessageRepositoryMock.create.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry) => entry.entry?.value === 'Task interrupted by user',
      );
    const interruptedStatusEvents = webContentsSendMock.mock.calls.filter(
      ([, payload]) => payload?.type === 'status' && payload.status === 'interrupted',
    );

    expect(interruptionEntries).toHaveLength(1);
    expect(stepServiceMock.interruptStep).toHaveBeenCalledTimes(1);
    expect(interruptedStatusEvents).toHaveLength(1);
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
  });

  it('stops queued run handles independently when runBackend is nested', async () => {
    const outerComplete = createDeferred<void>();
    const outerHandle = createCompleteThenWaitHandle({
      runId: 'outer-run',
      waitBeforeComplete: outerComplete.promise,
    });
    const nestedHandle = createHandle({
      runId: 'nested-run',
      events: [completeEvent()],
    });
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(outerHandle)
      .mockResolvedValueOnce(nestedHandle);

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    agentService.queuePrompt('step-1', [{ type: 'text', text: 'follow up' }]);
    outerComplete.resolve();

    await startPromise;
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(2);
    });

    expect(outerHandle.stop).toHaveBeenCalledTimes(1);
    expect(nestedHandle.stop).toHaveBeenCalledTimes(1);
    expect(outerHandle.dispose).toHaveBeenCalledTimes(1);
    expect(nestedHandle.dispose).toHaveBeenCalledTimes(1);
    expect(providerCalls.stops).toEqual(['nested-run', 'outer-run']);
  });

  it('stops a queued run handle when stop races with nested startup', async () => {
    const outerComplete = createDeferred<void>();
    const nestedStart = createDeferred<AgentRunHandle>();
    const outerHandle = createCompleteThenWaitHandle({
      runId: 'outer-run',
      waitBeforeComplete: outerComplete.promise,
    });
    const nested = createIdleHandle('nested-run');
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(outerHandle)
      .mockReturnValueOnce(nestedStart.promise);

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    agentService.queuePrompt('step-1', [{ type: 'text', text: 'follow up' }]);
    outerComplete.resolve();
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(2);
    });

    let stopSettled = false;
    const stopPromise = agentService.stop('step-1').then(() => {
      stopSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopSettled).toBe(false);

    nestedStart.resolve(nested.handle);

    await stopPromise;
    await startPromise;

    expect(outerHandle.stop).toHaveBeenCalledTimes(1);
    expect(nested.handle.stop).toHaveBeenCalledTimes(1);
    expect(outerHandle.dispose).toHaveBeenCalledTimes(1);
    expect(nested.handle.dispose).toHaveBeenCalledTimes(1);
    expect(providerCalls.stops.sort()).toEqual(['nested-run', 'outer-run']);
  });

  it('routes permission responses through the provider permission capability', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'Bash',
        input: { command: 'npm test' },
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(taskRepositoryMock.update).toHaveBeenCalledWith('task-1', {
        status: 'waiting',
      });
    });

    await agentService.respond('step-1', 'permission-1', {
      behavior: 'allow',
      allowMode: 'session',
    });

    expect(providerCalls.permissions).toEqual([
      {
        handle,
        requestId: 'permission-1',
        response: {
          behavior: 'allow',
          allowMode: 'session',
          toolsToAllow: ['bash:npm test'],
        },
      },
    ]);
    expect(notificationServiceMock.close).toHaveBeenCalledWith(
      'task-1:permission',
    );

    release();
    await startPromise;
  });

  it('preserves pending permission requests when the capability is unsupported', async () => {
    providerState.permissionsSupported = false;
    const waiting = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'Bash',
        input: { command: 'npm test' },
      },
    });
    providerState.runStartImplementation = async () => waiting.handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'permission',
        data: { requestId: 'permission-1' },
      });
    });

    await expect(
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
      }),
    ).rejects.toThrow('Unsupported backend capability');

    expect(agentService.getPendingRequest('step-1')).toMatchObject({
      type: 'permission',
      data: { requestId: 'permission-1' },
    });

    waiting.release();
    await startPromise;
  });

  it('preserves and retries pending permission requests when provider response rejects', async () => {
    providerState.permissionResponseError = new Error('permission failed');
    const { handle, release } = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'Bash',
        input: { command: 'npm test' },
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'permission',
        data: { requestId: 'permission-1' },
      });
    });

    await expect(
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
      }),
    ).rejects.toThrow('permission failed');

    expect(agentService.getPendingRequest('step-1')).toMatchObject({
      type: 'permission',
      data: { requestId: 'permission-1' },
    });

    providerState.permissionResponseError = null;
    await agentService.respond('step-1', 'permission-1', {
      behavior: 'allow',
    });

    expect(providerCalls.permissions).toEqual([
      {
        handle,
        requestId: 'permission-1',
        response: {
          behavior: 'allow',
          toolsToAllow: ['bash:npm test'],
        },
      },
    ]);
    expect(agentService.getPendingRequest('step-1')).toBeNull();

    release();
    await startPromise;
  });

  it('routes question responses through the provider question capability', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'question',
      request: {
        requestId: 'question-1',
        questions: [
          {
            question: 'Which option?',
            header: 'Choice',
            multiSelect: false,
            options: [{ label: 'A', description: 'Pick A' }],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(taskRepositoryMock.update).toHaveBeenCalledWith('task-1', {
        status: 'waiting',
      });
    });

    await agentService.respond('step-1', 'question-1', {
      answers: { 'Which option?': 'A' },
    });

    expect(providerCalls.questions).toEqual([
      {
        handle,
        requestId: 'question-1',
        answer: { 'Which option?': 'A' },
        metadata: {
          wasFreeform: undefined,
          wasFreeformByQuestion: undefined,
        },
      },
    ]);
    expect(notificationServiceMock.close).toHaveBeenCalledWith(
      'task-1:question',
    );

    release();
    await startPromise;
  });

  it('preserves pending question requests when the capability is unsupported', async () => {
    providerState.questionsSupported = false;
    const { handle, release } = createWaitingHandle({
      type: 'question',
      request: {
        requestId: 'question-1',
        questions: [
          {
            question: 'Which option?',
            header: 'Choice',
            multiSelect: false,
            options: [{ label: 'A', description: 'Pick A' }],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId: 'question-1' },
      });
    });

    await expect(
      agentService.respond('step-1', 'question-1', {
        answers: { 'Which option?': 'A' },
      }),
    ).rejects.toThrow('Unsupported backend capability');

    expect(agentService.getPendingRequest('step-1')).toMatchObject({
      type: 'question',
      data: { requestId: 'question-1' },
    });

    release();
    await startPromise;
  });

  it('preserves and retries pending question requests when provider response rejects', async () => {
    providerState.questionResponseError = new Error('question failed');
    const { handle, release } = createWaitingHandle({
      type: 'question',
      request: {
        requestId: 'question-1',
        questions: [
          {
            question: 'Which option?',
            header: 'Choice',
            multiSelect: false,
            options: [{ label: 'A', description: 'Pick A' }],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId: 'question-1' },
      });
    });

    await expect(
      agentService.respond('step-1', 'question-1', {
        answers: { 'Which option?': 'A' },
      }),
    ).rejects.toThrow('question failed');

    expect(agentService.getPendingRequest('step-1')).toMatchObject({
      type: 'question',
      data: { requestId: 'question-1' },
    });

    providerState.questionResponseError = null;
    await agentService.respond('step-1', 'question-1', {
      answers: { 'Which option?': 'A' },
    });

    expect(providerCalls.questions).toEqual([
      {
        handle,
        requestId: 'question-1',
        answer: { 'Which option?': 'A' },
        metadata: {
          wasFreeform: undefined,
          wasFreeformByQuestion: undefined,
        },
      },
    ]);
    expect(agentService.getPendingRequest('step-1')).toBeNull();

    release();
    await startPromise;
  });

  it('routes active mode changes through the provider only when supported', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'rate-limit',
      message: 'waiting',
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    await agentService.setMode('step-1', 'auto');

    expect(providerCalls.modes).toEqual([{ handle, mode: 'auto' }]);

    release();
    await startPromise;
    await waitForAssertion(() => {
      expect(handle.dispose).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    resetProviderState();
    setDefaultMocks();
    providerState.runtimeModeSwitchSupported = false;
    const unsupported = createWaitingHandle({
      type: 'rate-limit',
      message: 'waiting',
    });
    providerState.runStartImplementation = async () => unsupported.handle;

    const unsupportedStartPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    await agentService.setMode('step-1', 'plan');

    expect(providerCalls.modes).toEqual([]);
    expect(taskStepRepositoryMock.update).toHaveBeenCalledWith('step-1', {
      interactionMode: 'plan',
    });

    unsupported.release();
    await unsupportedStartPromise;
  });

  it('syncs session allowed tools through the provider only when supported', async () => {
    providerState.sessionAllowedTools = ['bash:npm test', 'read'];
    const handle = createHandle({ events: [completeEvent()] });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.sessionAllowedTools).toEqual([{ handle }]);
    });

    expect(taskRepositoryMock.update).toHaveBeenCalledWith('task-1', {
      sessionRules: {
        bash: { 'npm test': 'allow' },
        read: 'allow',
      },
    });

    vi.clearAllMocks();
    resetProviderState();
    setDefaultMocks();
    providerState.sessionAllowedToolsSupported = false;
    providerState.sessionAllowedTools = ['bash:npm test'];
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    expect(providerCalls.sessionAllowedTools).toEqual([]);
    expect(taskRepositoryMock.update).not.toHaveBeenCalledWith('task-1', {
      sessionRules: expect.anything(),
    });
  });

  it('does not route Codex raw-message compaction through Claude', async () => {
    taskStepRepositoryMock.findByTaskId.mockResolvedValue([
      { ...defaultStep, id: 'step-claude', agentBackend: 'claude-code' },
      { ...defaultStep, id: 'step-opencode', agentBackend: 'opencode' },
      { ...defaultStep, id: 'step-codex', agentBackend: 'codex' },
    ]);

    await agentService.compactRawMessages('task-1');

    expect(claudeCompactRawMessagesForTaskMock).toHaveBeenCalledTimes(1);
    expect(claudeCompactRawMessagesForTaskMock).toHaveBeenCalledWith('task-1');
    expect(openCodeCompactRawMessagesForTaskMock).toHaveBeenCalledTimes(1);
    expect(openCodeCompactRawMessagesForTaskMock).toHaveBeenCalledWith(
      'task-1',
    );
  });
});
