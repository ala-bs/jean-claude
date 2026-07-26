import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentBackendConfig,
  AgentEvent,
  AgentTaskContext,
  PromptPart,
} from '@shared/agent-backend-types';
import type { AgentMemoryTaskReviewCapture } from '@shared/agent-memory-types';
import type { AgentRunHandle } from '@shared/agent-backend-provider-types';
import type { Task } from '@shared/types';

import { buildJcMcpServersConfigForCwd } from './jc-mcp-config';
import { buildSessionIdStepUpdate } from './agent-session-update';
import { deleteAllPrWorkspaces } from './pr-workspace-deletion-service';
import { JcMcpBridgeService } from './jc-mcp-bridge-service';
import { QuestionBrokerService } from './question-broker-service';

const TEST_ALLOWED_DIRECTORY = fs.realpathSync.native(os.tmpdir());
const TEST_REQUESTED_DIRECTORY = path.join(TEST_ALLOWED_DIRECTORY, 'repo');
const TEST_REQUESTED_PATH = path.join(TEST_REQUESTED_DIRECTORY, 'file.ts');
const TEST_DIRECTORY_PATTERN = `${TEST_ALLOWED_DIRECTORY}/**`;

const QUESTIONS = [
  {
    id: 'approach',
    type: 'single_choice' as const,
    label: 'Which approach?',
    options: [{ label: 'Small' }, { label: 'Large' }],
  },
];

function submittedReviewPrompt(
  text: string,
  reviews: AgentMemoryTaskReviewCapture[],
): string {
  const comments = reviews.map((review, index) => {
    const type = review.filePath ? 'file' : 'message';
    const lineRange = review.lineStart
      ? ` line_range="L${review.lineStart}${
          review.lineEnd && review.lineEnd !== review.lineStart
            ? `-L${review.lineEnd}`
            : ''
        }"`
      : '';
    const filePath = review.filePath ? ` file_path="${review.filePath}"` : '';
    const selectedTag = type === 'file' ? 'selected_lines' : 'quoted_text';
    return `<comment index="${index + 1}" comment_id="${review.commentId}" type="${type}"${filePath}${lineRange}>
${review.presets.length ? `  <tags>${review.presets.join(', ')}</tags>\n` : ''}${review.selectedText ? `  <${selectedTag}>\n${review.selectedText}\n  </${selectedTag}>\n` : ''}  <instruction>
${review.body}
  </instruction>
</comment>`;
  });
  return `${text}\n\n<user_review>\n${comments.join('\n')}\n</user_review>`;
}

const {
  agentMessageRepositoryMock,
  captureAgentMemoryEventSafeMock,
  captureAgentMemoryPromptSubmissionSafeMock,
  applyConfiguredPromptPrefaceMock,
  browserWindowGetAllWindowsMock,
  buildToolPermissionConfigMock,
  claudeCompactRawMessagesForTaskMock,
  debugAgentMock,
  emitStepUpsertMock,
  emitTaskPatchMock,
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
    permissionRuleUpdates: [] as unknown[],
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
          permissionRuleUpdates: supported({
            update: async (input: unknown) => {
              providerCalls.permissionRuleUpdates.push(input);
            },
          }),
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
    providerCalls.permissionRuleUpdates.length = 0;
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
      findLatestResultByStepId: vi.fn(),
      findWithRawDataByTaskId: vi.fn(),
      reprocessNormalization: vi.fn(),
    },
    captureAgentMemoryPromptSubmissionSafeMock: vi.fn(),
    captureAgentMemoryEventSafeMock: vi.fn(),
    applyConfiguredPromptPrefaceMock: vi.fn(),
    browserWindowGetAllWindowsMock: vi.fn(() => []),
    buildToolPermissionConfigMock: vi.fn(),
    claudeCompactRawMessagesForTaskMock: vi.fn(),
    debugAgentMock: vi.fn(),
    emitStepUpsertMock: vi.fn(),
    emitTaskPatchMock: vi.fn(),
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
      getNextMessageIndexByStepId: vi.fn(),
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
      get: (_, property) =>
        property === 'agent' ? debugAgentMock : vi.fn(),
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

vi.mock('./agent-memory-capture-service', () => ({
  captureAgentMemoryEventSafe: captureAgentMemoryEventSafeMock,
  captureAgentMemoryPromptSubmissionSafe:
    captureAgentMemoryPromptSubmissionSafeMock,
}));

vi.mock('./ai-usage-tracking-service', () => ({
  aiUsageTrackingService: usageTrackingServiceMock,
}));

vi.mock('./cache-event-service', () => ({
  emitStepUpsert: emitStepUpsertMock,
  emitTaskPatch: emitTaskPatchMock,
  emitTaskUpsert: emitTaskUpsertMock,
}));

vi.mock('./global-permissions-service', () => ({
  addGlobalPermission: vi.fn(),
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
  addProjectPermissionRule: vi.fn(),
  addWorktreePermission: vi.fn(),
  buildToolPermissionConfig: buildToolPermissionConfigMock,
  flattenScope: (scope: Record<string, string | Record<string, string>>) =>
    Object.entries(scope).flatMap(([tool, config]) => {
      if (tool === 'extends') return [];
      if (typeof config === 'string') {
        return [{ tool, pattern: '*', action: config }];
      }
      return Object.entries(config).map(([pattern, action]) => ({
        tool,
        pattern,
        action,
      }));
    }),
  isUnrestrictedBashPattern: (tool: string, pattern: string) =>
    tool.toLowerCase() === 'bash' &&
    pattern.replaceAll(/[*?]/g, '').trim() === '',
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
import { emitPermissionsChanged } from './permission-event-service';
import { buildReadOnlyPrReviewSessionRules } from './pr-review-agent-service';

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
  sessionRules: {},
  autoStart: false,
  sortOrder: 0,
  createdAt: '2026-06-21T00:00:00.000Z',
  updatedAt: '2026-06-21T00:00:00.000Z',
};

const defaultTask: Task = {
  id: 'task-1',
  projectId: 'project-1',
  type: 'agent',
  name: 'Task 1',
  prompt: 'Task prompt',
  status: 'waiting',
  worktreePath: '/repo/worktree',
  startCommitHash: null,
  sourceBranch: null,
  branchName: null,
  prWorkspaceState: null,
  hasUnread: false,
  userCompleted: false,
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
  rawMessageRepositoryMock.getNextMessageIndexByStepId.mockResolvedValue(0);
  agentMessageRepositoryMock.create.mockResolvedValue({ id: 'message-1' });
  agentMessageRepositoryMock.updateEntry.mockResolvedValue(undefined);
  agentMessageRepositoryMock.updateToolResult.mockResolvedValue(undefined);
  agentMessageRepositoryMock.findByStepId.mockResolvedValue([]);
  agentMessageRepositoryMock.findLatestResultByStepId.mockResolvedValue(null);
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
  captureAgentMemoryPromptSubmissionSafeMock.mockResolvedValue(undefined);
  captureAgentMemoryEventSafeMock.mockResolvedValue(undefined);
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
    expect(config['jean-claude-mcp'].env).not.toHaveProperty(
      'JC_MCP_ENABLE_AGENT_TOOL',
    );
  });

  it('enables the agent tool only when requested', () => {
    const config = buildJcMcpServersConfigForCwd({
      cwd: '/tmp/worktree',
      enableAgentTool: true,
      questionBridge: {
        serverUrl: 'http://127.0.0.1:4321',
        token: 'token-1',
      },
    });

    expect(config['jean-claude-mcp'].env).toMatchObject({
      JC_MCP_ENABLE_AGENT_TOOL: '1',
    });
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

  it('enables the agent tool through argv for OpenCode runtime MCP', () => {
    const config = buildJcMcpServersConfigForCwd({
      cwd: '/tmp/worktree',
      environmentMode: 'argv',
      enableAgentTool: true,
      questionBridge: {
        serverUrl: 'http://127.0.0.1:4321',
        token: 'token-1',
      },
    });

    expect(config['jean-claude-mcp']).toEqual({
      command: '/usr/bin/env',
      args: expect.arrayContaining([
        'JC_MCP_ENABLE_AGENT_TOOL=1',
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

  it('corrects an unread write when task becomes focused while it is pending', async () => {
    const unreadWrite = createDeferred<typeof defaultTask>();
    let windowDestroyed = false;
    let windowFocused = false;
    agentService.setMainWindow({
      isDestroyed: () => windowDestroyed,
      isFocused: () => windowFocused,
      webContents: { isDestroyed: () => windowDestroyed },
    } as never);
    agentService.setFocusedTask(null);
    taskRepositoryMock.setHasUnread
      .mockReturnValueOnce(unreadWrite.promise)
      .mockResolvedValueOnce({ ...defaultTask, hasUnread: false });

    const markUnread = (
      agentService as unknown as {
        markTaskUnreadIfBackground: (taskId: string) => Promise<void>;
      }
    ).markTaskUnreadIfBackground('task-1');
    await waitForAssertion(() => {
      expect(taskRepositoryMock.setHasUnread).toHaveBeenCalledWith(
        'task-1',
        true,
      );
    });

    windowFocused = true;
    agentService.setFocusedTask('task-1');
    unreadWrite.resolve({ ...defaultTask, hasUnread: true });
    await markUnread;

    expect(taskRepositoryMock.setHasUnread.mock.calls).toEqual([
      ['task-1', true],
      ['task-1', false],
    ]);
    expect(emitTaskPatchMock).toHaveBeenCalledTimes(1);
    expect(emitTaskPatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        patch: expect.objectContaining({ hasUnread: false }),
      }),
    );

    windowDestroyed = true;
    agentService.setFocusedTask(null);
  });

  it('keeps PR workspaces available when recovering stale tasks', async () => {
    const prWorkspace = {
      ...defaultTask,
      id: 'pr-workspace-1',
      type: 'pr-review' as const,
      status: 'interrupted' as const,
      pullRequestId: '1128',
    };
    const genericTask = {
      ...defaultTask,
      id: 'generic-task-1',
      status: 'running' as const,
    };
    taskRepositoryMock.findByStatuses.mockResolvedValue([
      prWorkspace,
      genericTask,
    ]);
    taskRepositoryMock.update.mockImplementation(async (id, update) => ({
      ...(id === prWorkspace.id ? prWorkspace : genericTask),
      ...update,
    }));

    await agentService.recoverStaleTasks();

    expect(taskRepositoryMock.update).toHaveBeenCalledWith(prWorkspace.id, {
      status: 'waiting',
    });
    expect(taskRepositoryMock.update).toHaveBeenCalledWith(genericTask.id, {
      status: 'interrupted',
    });
  });

  it('keeps PR workspace containers waiting when recovering active steps', async () => {
    const prWorkspace = {
      ...defaultTask,
      id: 'pr-workspace-1',
      type: 'pr-review' as const,
      status: 'running' as const,
      pullRequestId: '1128',
    };
    const runningStep = { ...defaultStep, taskId: prWorkspace.id };
    taskRepositoryMock.findByStatuses.mockResolvedValue([prWorkspace]);
    taskStepRepositoryMock.findByStatus.mockResolvedValue([runningStep]);
    taskRepositoryMock.update.mockResolvedValue({
      ...prWorkspace,
      status: 'waiting',
    });

    await agentService.recoverStaleTasks();

    expect(taskRepositoryMock.update).toHaveBeenCalledWith(prWorkspace.id, {
      status: 'waiting',
    });
    expect(stepServiceMock.syncTaskStatus).not.toHaveBeenCalled();
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

  it('rejects PR review task starts when backend permissions are unsupported', async () => {
    providerState.permissionsSupported = false;
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    await expect(agentService.start('step-1')).rejects.toThrow(
      'requires backend permission support',
    );

    expect(stepServiceMock.update).not.toHaveBeenCalled();
    expect(providerCalls.runStarts).toHaveLength(0);
  });

  it('rejects PR review chat metadata under a normal task before backend start', async () => {
    taskRepositoryMock.findById.mockResolvedValue(defaultTask);
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    await expect(agentService.start('step-1')).rejects.toThrow(
      'can only run under PR review tasks',
    );
    expect(stepServiceMock.update).not.toHaveBeenCalled();
    expect(providerCalls.runStarts).toHaveLength(0);
  });

  it('rejects PR review chat with a mismatched parent PR before backend start', async () => {
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '99',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    await expect(agentService.start('step-1')).rejects.toThrow(
      'pull request does not match review task',
    );
    expect(stepServiceMock.update).not.toHaveBeenCalled();
    expect(providerCalls.runStarts).toHaveLength(0);
  });

  it.each([
    {
      drift: 'an extra permission',
      buildRules: () => ({
        ...buildReadOnlyPrReviewSessionRules(),
        task: 'deny' as const,
      }),
    },
    {
      drift: 'a missing permission',
      buildRules: () => {
        const { read: _read, ...rules } = buildReadOnlyPrReviewSessionRules();
        return rules;
      },
    },
    {
      drift: 'a changed permission',
      buildRules: () => ({
        ...buildReadOnlyPrReviewSessionRules(),
        read: 'deny' as const,
      }),
    },
  ])('rejects PR review chat rules with $drift', async ({ buildRules }) => {
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: buildRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    await expect(agentService.start('step-1')).rejects.toThrow(
      'must use read-only session rules',
    );
    expect(stepServiceMock.update).not.toHaveBeenCalled();
    expect(providerCalls.runStarts).toHaveLength(0);
  });

  it('rejects PR review chat persisted with a non-ask mode', async () => {
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      interactionMode: 'auto',
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    await expect(agentService.start('step-1')).rejects.toThrow(
      'must use ask interaction mode',
    );
    expect(stepServiceMock.update).not.toHaveBeenCalled();
    expect(providerCalls.runStarts).toHaveLength(0);
  });

  it('runs generic steps under PR review tasks with their own mutable rules', async () => {
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: { write: 'allow' },
    });
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await expect(agentService.start('step-1')).resolves.toBeUndefined();

    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });
    expect(providerCalls.runStarts[0]).toMatchObject({
      config: {
        persistedSessionRules: { write: 'allow' },
      },
    });
  });

  it.each([
    {
      order: 'wildcard-first',
      reorder: () => {
        const { '*': wildcard, ...specific } =
          buildReadOnlyPrReviewSessionRules();
        return {
          '*': wildcard,
          ...Object.fromEntries(Object.entries(specific).reverse()),
        };
      },
    },
    {
      order: 'wildcard-last',
      reorder: () =>
        Object.fromEntries(
          Object.entries(buildReadOnlyPrReviewSessionRules()).reverse(),
        ),
    },
  ])('canonicalizes semantically identical $order PR chat rules', async ({ reorder }) => {
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: reorder(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await expect(agentService.start('step-1')).resolves.toBeUndefined();
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });
    const { config } = providerCalls.runStarts[0] as {
      config: AgentBackendConfig;
    };
    const permissionRules = config.permissionRules ?? [];
    const canonicalRules = buildReadOnlyPrReviewSessionRules();
    expect(config.persistedSessionRules).toEqual(canonicalRules);
    expect(permissionRules).toEqual([
      { tool: '*', pattern: '*', action: 'deny' },
      { tool: 'read', pattern: '*', action: 'allow' },
      { tool: 'glob', pattern: '*', action: 'allow' },
      { tool: 'grep', pattern: '*', action: 'allow' },
      { tool: 'bash', pattern: '*', action: 'deny' },
      { tool: 'write', pattern: '*', action: 'deny' },
      { tool: 'edit', pattern: '*', action: 'deny' },
      { tool: 'multiedit', pattern: '*', action: 'deny' },
      { tool: 'notebookedit', pattern: '*', action: 'deny' },
      { tool: 'todowrite', pattern: '*', action: 'deny' },
    ]);
    const evaluate = (tool: string) =>
      permissionRules
        .filter((rule) => rule.tool === '*' || rule.tool === tool)
        .at(-1)?.action;
    expect(evaluate('read')).toBe('allow');
    expect(evaluate('glob')).toBe('allow');
    expect(evaluate('grep')).toBe('allow');
    expect(evaluate('write')).toBe('deny');
    expect(evaluate('bash')).toBe('deny');
  });

  it('completes read-only PR review chat when provider reports persisted tools', async () => {
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });
    providerState.sessionAllowedTools = ['read', 'bash:git diff'];
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await expect(agentService.start('step-1')).resolves.toBeUndefined();

    await waitForAssertion(() => {
      expect(stepServiceMock.completeStep).toHaveBeenCalledWith('step-1');
    });
    expect(stepServiceMock.errorStep).not.toHaveBeenCalled();
    expect(taskStepRepositoryMock.update).not.toHaveBeenCalledWith('step-1', {
      sessionRules: expect.anything(),
    });
  });

  it('passes persisted step session deny rules after project rules', async () => {
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      agentBackend: 'opencode',
      interactionMode: 'ask',
      sessionRules: {
        read: 'allow',
        write: 'deny',
        bash: {
          'npm test': 'deny',
        },
      },
    });
    resolveRulesMock.mockReturnValueOnce([
      { tool: 'write', pattern: '*', action: 'allow' },
      { tool: 'bash', pattern: 'npm test', action: 'allow' },
    ]);

    const handle = createHandle({ events: [completeEvent()] });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    expect(providerCalls.runStarts[0]).toMatchObject({
      config: {
        type: 'opencode',
        interactionMode: 'auto',
        persistedSessionRules: {
          read: 'allow',
          write: 'deny',
          bash: {
            'npm test': 'deny',
          },
        },
        permissionRules: [
          { tool: 'write', pattern: '*', action: 'allow' },
          { tool: 'bash', pattern: 'npm test', action: 'allow' },
          { tool: 'read', pattern: '*', action: 'allow' },
          { tool: 'write', pattern: '*', action: 'deny' },
          { tool: 'bash', pattern: 'npm test', action: 'deny' },
        ],
      },
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

  it('drains an admitted start before stopAll snapshots sessions', async () => {
    const stepLookup = createDeferred<typeof defaultStep>();
    taskStepRepositoryMock.findById.mockReturnValueOnce(stepLookup.promise);
    const startPromise = agentService.start('step-1');
    let stopSettled = false;
    const stopPromise = agentService.stopAll({ reason: 'user' }).then(() => {
      stopSettled = true;
    });

    await Promise.resolve();
    expect(stopSettled).toBe(false);

    stepLookup.resolve(defaultStep);
    await startPromise;
    await stopPromise;

    expect(providerCalls.runStarts).toHaveLength(0);
    expect(stepServiceMock.interruptStep).toHaveBeenCalledWith('step-1');
    expect(stepServiceMock.errorStep).not.toHaveBeenCalled();
  });

  it('does not start a backend after stopAll interrupts a registered session', async () => {
    const promptResolution = createDeferred<{
      resolvedPrompt: string;
      step: typeof defaultStep;
      warnings: never[];
    }>();
    stepServiceMock.resolveAndValidate.mockReturnValueOnce(
      promptResolution.promise,
    );
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(stepServiceMock.resolveAndValidate).toHaveBeenCalled();
    });

    await agentService.stopAll({ reason: 'user' });
    promptResolution.resolve({
      resolvedPrompt: 'Resolved prompt',
      step: defaultStep,
      warnings: [],
    });
    await startPromise;
    await Promise.resolve();

    expect(providerCalls.runStarts).toHaveLength(0);
    expect(stepServiceMock.errorStep).not.toHaveBeenCalled();
  });

  it('holds sendMessage registration through running-status updates', async () => {
    const statusSync = createDeferred<void>();
    const ordering: string[] = [];
    stepServiceMock.syncTaskStatus.mockImplementationOnce(async () => {
      ordering.push('status-sync-start');
      await statusSync.promise;
      ordering.push('status-sync-end');
    });
    stepServiceMock.interruptStep.mockImplementationOnce(async () => {
      ordering.push('interrupt');
    });
    const sendPromise = agentService.sendMessage('step-1', [
      { type: 'text', text: 'follow up' },
    ]);
    await waitForAssertion(() => {
      expect(ordering).toContain('status-sync-start');
    });
    let stopSettled = false;
    const stopPromise = agentService.stopAll({ reason: 'user' }).then(() => {
      stopSettled = true;
    });

    await Promise.resolve();
    expect(stopSettled).toBe(false);

    statusSync.resolve();
    await Promise.all([sendPromise, stopPromise]);

    expect(providerCalls.runStarts).toHaveLength(0);
    expect(ordering).toEqual([
      'status-sync-start',
      'status-sync-end',
      'interrupt',
    ]);
    expect(stepServiceMock.errorStep).not.toHaveBeenCalled();
  });

  it('rejects concurrent sendMessage registration for the same step', async () => {
    const stepLookup = createDeferred<typeof defaultStep>();
    taskStepRepositoryMock.findById.mockReturnValueOnce(stepLookup.promise);
    const firstSend = agentService.sendMessage('step-1', [
      { type: 'text', text: 'first' },
    ]);

    await expect(
      agentService.sendMessage('step-1', [{ type: 'text', text: 'second' }]),
    ).rejects.toThrow('Session registration already in progress for step step-1');

    const stopPromise = agentService.stopAll({ reason: 'user' });
    stepLookup.resolve(defaultStep);
    await Promise.all([firstSend, stopPromise]);

    expect(
      agentMessageRepositoryMock.getMessageCountByStepId,
    ).toHaveBeenCalledOnce();
    expect(providerCalls.runStarts).toHaveLength(0);
    expect(stepServiceMock.interruptStep).toHaveBeenCalledTimes(1);
  });

  it('captures an admitted immediate follow-up with the previous result snapshot', async () => {
    agentMessageRepositoryMock.findLatestResultByStepId.mockResolvedValue(
      'previous result',
    );
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await agentService.sendMessage(
      'step-1',
      [{ type: 'text', text: 'fix this' }],
      {
        submissionId: 'submission-1',
        userText: 'fix this',
        reviews: [],
      },
    );

    expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith({
      source: 'follow-up-prompt',
      sourceId: 'follow-up-prompt:submission-1',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      userText: 'fix this',
      previousAgentResult: 'previous result',
      reviews: [],
    });
    expect(
      agentMessageRepositoryMock.findLatestResultByStepId,
    ).toHaveBeenCalledWith('step-1');
  });

  it('starts the backend while the admitted previous-result snapshot is unresolved', async () => {
    const previousResult = createDeferred<string | null>();
    agentMessageRepositoryMock.findLatestResultByStepId.mockReturnValue(
      previousResult.promise,
    );
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    const sendPromise = agentService.sendMessage(
      'step-1',
      [{ type: 'text', text: 'fix this' }],
      {
        submissionId: 'submission-deferred',
        userText: 'fix this',
        reviews: [],
      },
    );

    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });
    expect(captureAgentMemoryPromptSubmissionSafeMock).not.toHaveBeenCalled();

    previousResult.resolve('snapshot before new run');
    await sendPromise;
    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'follow-up-prompt:submission-deferred',
          previousAgentResult: 'snapshot before new run',
        }),
      );
    });
  });

  it('snapshots an active session result before stopping without delaying the next backend', async () => {
    const activeRun = createIdleHandle('active-prior-run');
    const previousResult = createDeferred<string | null>();
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(activeRun.handle)
      .mockResolvedValueOnce(createHandle({ events: [completeEvent()] }));

    const activeStart = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    agentMessageRepositoryMock.findLatestResultByStepId.mockImplementation(() => {
      expect(activeRun.handle.stop).not.toHaveBeenCalled();
      return previousResult.promise;
    });

    const sendPromise = agentService.sendMessage(
      'step-1',
      [{ type: 'text', text: 'follow up active run' }],
      {
        submissionId: 'active-session-submission',
        userText: 'follow up active run',
      },
    );

    await waitForAssertion(() => {
      expect(activeRun.handle.stop).toHaveBeenCalledTimes(1);
      expect(providerCalls.runStarts).toHaveLength(2);
    });
    expect(captureAgentMemoryPromptSubmissionSafeMock).not.toHaveBeenCalled();

    previousResult.resolve('actual prior agent result');
    await Promise.all([activeStart, sendPromise]);
    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'follow-up-prompt:active-session-submission',
          previousAgentResult: 'actual prior agent result',
        }),
      );
    });
  });

  it('falls back to captured step output when no result row exists', async () => {
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      output: 'persisted step output',
    });
    agentMessageRepositoryMock.findLatestResultByStepId.mockResolvedValue(null);
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await agentService.sendMessage(
      'step-1',
      [{ type: 'text', text: 'follow up' }],
      {
        submissionId: 'submission-output',
        userText: 'follow up',
      },
    );

    expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ previousAgentResult: 'persisted step output' }),
    );
  });

  it('captures only explicit user text when backend preface and images are present', async () => {
    applyConfiguredPromptPrefaceMock.mockImplementation(
      async ({ parts }: { parts: PromptPart[] }) => [
        { type: 'text', text: 'Generated automation preface' },
        ...parts,
      ],
    );
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await agentService.sendMessage(
      'step-1',
      [
        { type: 'text', text: 'User instruction' },
        { type: 'image', data: 'base64-secret', mimeType: 'image/png' },
      ],
      {
        submissionId: 'submission-user-only',
        userText: 'User instruction',
      },
    );

    expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'User instruction' }),
    );
    expect(
      JSON.stringify(captureAgentMemoryPromptSubmissionSafeMock.mock.calls),
    ).not.toContain('Generated automation preface');
    expect(
      JSON.stringify(captureAgentMemoryPromptSubmissionSafeMock.mock.calls),
    ).not.toContain('base64-secret');
  });

  it('does not capture generated follow-ups without submission metadata', async () => {
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await agentService.sendMessage('step-1', [
      { type: 'text', text: 'continue' },
    ]);

    expect(captureAgentMemoryPromptSubmissionSafeMock).not.toHaveBeenCalled();
  });

  it('rejects immediate review metadata not represented in submitted prompt XML', async () => {
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });
    const fabricatedReview = {
      commentId: 'Bearer immediate-id-secret',
      body: 'immediate body secret',
      selectedText: 'immediate selected secret',
      filePath: 'src/forged.ts',
      lineStart: 40,
      lineEnd: 50,
      presets: ['refactor'],
    };

    await agentService.sendMessage(
      'step-1',
      [{ type: 'text', text: 'Actual prompt without review XML' }],
      {
        submissionId: 'immediate-forged-metadata',
        userText: 'renderer replacement prompt',
        reviews: [fabricatedReview],
      },
    );

    expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: 'Actual prompt without review XML',
        reviews: [],
      }),
    );
    const logs = JSON.stringify(debugAgentMock.mock.calls);
    expect(logs).toContain('agent-memory-prompt-admission-mismatch');
    expect(logs).not.toContain('immediate-id-secret');
    expect(logs).not.toContain('immediate body secret');
    expect(logs).not.toContain('immediate selected secret');
    expect(logs).not.toContain('renderer replacement prompt');
  });

  it('admits immediate review evidence only from matching submitted XML', async () => {
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });
    const rendererReview = {
      commentId: 'immediate-stable-review',
      body: 'Renderer draft body',
      selectedText: 'value',
      filePath: 'src/value.ts',
      lineStart: 7,
      lineEnd: 7,
      presets: ['tests'],
    };
    const finalReview = { ...rendererReview, body: 'Final XML body' };
    const content = submittedReviewPrompt('Immediate review prompt', [
      finalReview,
    ]);

    await agentService.sendMessage(
      'step-1',
      [{ type: 'text', text: content }],
      {
        submissionId: 'immediate-valid-review',
        userText: 'Immediate review prompt',
        reviews: [rendererReview],
      },
    );

    expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userText: content,
        reviews: [finalReview],
      }),
    );
  });

  it('restores interruption when completion wins a terminal status race', async () => {
    const terminalMutation = createDeferred<void>();
    const ordering: string[] = [];
    stepServiceMock.completeStep.mockImplementationOnce(async () => {
      ordering.push('complete-start');
      await terminalMutation.promise;
      ordering.push('complete-end');
      return ['step-2'];
    });
    stepServiceMock.interruptStep.mockImplementation(async () => {
      ordering.push('interrupt');
    });
    browserWindowGetAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: webContentsSendMock,
        },
      },
    ] as never);
    const handle = createHandle({ events: [completeEvent()] });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(ordering).toContain('complete-start');
    });

    await agentService.stopAll({ reason: 'user' });
    terminalMutation.resolve();
    await waitForAssertion(() => {
      expect(ordering).toContain('complete-end');
    });

    expect(ordering).toEqual([
      'complete-start',
      'interrupt',
      'complete-end',
      'interrupt',
    ]);
    expect(providerCalls.runStarts).toHaveLength(1);
    expect(
      webContentsSendMock.mock.calls.some(
        ([, payload]) => payload?.type === 'status' && payload.status === 'completed',
      ),
    ).toBe(false);
    expect(notificationServiceMock.notify).not.toHaveBeenCalled();
  });

  it('restores interruption when backend error handling races stopAll', async () => {
    const terminalMutation = createDeferred<void>();
    const ordering: string[] = [];
    stepServiceMock.errorStep.mockImplementationOnce(async () => {
      ordering.push('error-start');
      await terminalMutation.promise;
      ordering.push('error-end');
    });
    stepServiceMock.interruptStep.mockImplementation(async () => {
      ordering.push('interrupt');
    });
    browserWindowGetAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: webContentsSendMock,
        },
      },
    ] as never);
    const handle = createHandle({
      events: [{ type: 'error', error: 'backend failed' }],
    });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(ordering).toContain('error-start');
    });

    await agentService.stopAll({ reason: 'user' });
    terminalMutation.resolve();
    await waitForAssertion(() => {
      expect(ordering).toContain('error-end');
    });

    expect(ordering).toEqual([
      'error-start',
      'interrupt',
      'error-end',
      'interrupt',
    ]);
    expect(
      webContentsSendMock.mock.calls.some(
        ([, payload]) => payload?.type === 'status' && payload.status === 'errored',
      ),
    ).toBe(false);
    expect(notificationServiceMock.notify).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', completeEvent()],
    ['errored', { type: 'error', error: 'backend failed' } as AgentEvent],
  ])(
    'skips stale %s notification when stopAll wins during notification lookup',
    async (_, terminalEvent) => {
      const notificationSettings = createDeferred<{
        modes: {
          completed: 'always';
          'permission-required': 'disabled';
          question: 'disabled';
          errored: 'always';
        };
      }>();
      settingsRepositoryMock.get.mockReturnValueOnce(
        notificationSettings.promise,
      );
      let windowDestroyed = false;
      agentService.setMainWindow({
        isDestroyed: () => windowDestroyed,
        isFocused: () => false,
        isMinimized: () => false,
        focus: vi.fn(),
        restore: vi.fn(),
        webContents: {
          isDestroyed: () => windowDestroyed,
          send: vi.fn(),
        },
      } as never);
      const terminalFinished = createDeferred<void>();
      const baseHandle = createHandle();
      const handle: AgentRunHandle = {
        ...baseHandle,
        events: (async function* () {
          yield terminalEvent;
          terminalFinished.resolve();
        })(),
      };
      providerState.runStartImplementation = async () => handle;

      try {
        await agentService.start('step-1');
        await waitForAssertion(() => {
          expect(settingsRepositoryMock.get).toHaveBeenCalledWith(
            'taskEventNotifications',
          );
        });

        await agentService.stopAll({ reason: 'user' });
        notificationSettings.resolve({
          modes: {
            completed: 'always',
            'permission-required': 'disabled',
            question: 'disabled',
            errored: 'always',
          },
        });
        await terminalFinished.promise;

        expect(notificationServiceMock.notify).not.toHaveBeenCalled();
      } finally {
        windowDestroyed = true;
      }
    },
  );

  it('rejects new session producers and shares concurrent stopAll calls', async () => {
    const sessions = (
      agentService as unknown as { sessions: Map<string, unknown> }
    ).sessions;
    sessions.set('active-step', {});
    const stopRelease = createDeferred<void>();
    const stopMock = vi
      .spyOn(agentService, 'stop')
      .mockImplementation(async (stepId) => {
        await stopRelease.promise;
        sessions.delete(stepId);
      });

    try {
      const firstStop = agentService.stopAll({ reason: 'user' });
      const secondStop = agentService.stopAll({ reason: 'user' });
      await Promise.resolve();
      expect(stopMock).toHaveBeenCalledOnce();

      await expect(agentService.start('step-1')).rejects.toThrow(
        'Cannot start agent sessions while stopAll is active',
      );
      await expect(
        agentService.sendMessage('step-1', [{ type: 'text', text: 'hello' }]),
      ).rejects.toThrow('Cannot start agent sessions while stopAll is active');

      stopRelease.resolve();
      await Promise.all([firstStop, secondStop]);
      expect(stopMock).toHaveBeenCalledOnce();
    } finally {
      stopMock.mockRestore();
      sessions.delete('active-step');
    }
  });

  it('waits for pre-session startup before stop can complete', async () => {
    const stepLookup = createDeferred<typeof defaultStep>();
    const { handle } = createIdleHandle();
    taskStepRepositoryMock.findById.mockReturnValueOnce(stepLookup.promise);
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    expect(agentService.isRunningOrStarting('step-1')).toBe(true);
    let stopSettled = false;
    const stopPromise = agentService.stop('step-1').then(() => {
      stopSettled = true;
    });

    await Promise.resolve();
    expect(stopSettled).toBe(false);
    stepLookup.resolve(defaultStep);

    await Promise.all([startPromise, stopPromise]);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(agentService.isRunningOrStarting('step-1')).toBe(false);
  });

  it('tracks and stops follow-up startup before session registration', async () => {
    const stepLookup = createDeferred<typeof defaultStep>();
    const { handle } = createIdleHandle();
    taskStepRepositoryMock.findById.mockReturnValueOnce(stepLookup.promise);
    providerState.runStartImplementation = async () => handle;

    const followUp = await agentService.beginSendMessage('step-1', [
      { type: 'text', text: 'follow up' },
    ]);
    expect(agentService.isRunningOrStarting('step-1')).toBe(true);
    let stopSettled = false;
    const stopPromise = agentService.stop('step-1').then(() => {
      stopSettled = true;
    });

    await Promise.resolve();
    expect(stopSettled).toBe(false);
    stepLookup.resolve(defaultStep);

    await Promise.all([followUp.completion, stopPromise]);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(agentService.isRunningOrStarting('step-1')).toBe(false);
  });

  it.each(['initial', 'follow-up'] as const)(
    'waits for paused raw persistence before starting a replacement after %s run',
    async (runKind) => {
      const rawPersist = createDeferred<{ id: string }>();
      const replacementRun = createIdleHandle('replacement-run');
      let oldCompletion: Promise<void> | undefined;
      providerState.runStartImplementation = vi
        .fn()
        .mockImplementationOnce(async (input: unknown) => {
          const context = (input as { context: AgentTaskContext }).context;
          return {
            runId: 'raw-persistence-run',
            events: (async function* () {
              await context.persistRaw({
                messageIndex: 0,
                backendSessionId: null,
                rawData: { type: 'message' },
              });
              yield completeEvent();
            })(),
            rootPid: 123,
            stop: vi.fn(async () => {
              providerCalls.stops.push('raw-persistence-run');
            }),
            dispose: vi.fn(),
          } satisfies AgentRunHandle;
        })
        .mockResolvedValueOnce(replacementRun.handle);
      rawMessageRepositoryMock.create.mockReturnValueOnce(rawPersist.promise);

      if (runKind === 'initial') {
        await agentService.start('step-1');
      } else {
        const followUp = await agentService.beginSendMessage('step-1', [
          { type: 'text', text: 'old follow up' },
        ]);
        oldCompletion = followUp.completion;
        await followUp.started;
      }
      await waitForAssertion(() => {
        expect(rawMessageRepositoryMock.create).toHaveBeenCalledOnce();
      });

      let replacementRegistered = false;
      const replacementRequest = agentService
        .beginSendMessage('step-1', [{ type: 'text', text: 'replacement' }])
        .then((result) => {
          replacementRegistered = true;
          return result;
        });
      await waitForAssertion(() => {
        expect(providerCalls.stops).toContain('raw-persistence-run');
      });
      expect(replacementRegistered).toBe(false);
      expect(providerCalls.runStarts).toHaveLength(1);

      rawPersist.resolve({ id: 'raw-blocked' });
      const replacement = await replacementRequest;
      await replacement.started;
      await oldCompletion;
      expect(providerCalls.runStarts).toHaveLength(2);

      await agentService.stop('step-1');
      await replacement.completion;
    },
  );

  it.each(['initial', 'follow-up'] as const)(
    'holds PR deletion before Git while %s run is paused in error finalization',
    async (runKind) => {
    const prTask = {
      ...defaultTask,
      type: 'pr-review' as const,
      pullRequestId: '12',
      prWorkspaceState: 'active' as const,
    };
    taskRepositoryMock.findById.mockResolvedValue(prTask);
      const errorFinalization = createDeferred<void>();
      const handle = createHandle({
        runId: 'error-finalization-run',
        events: [{ type: 'error', error: 'provider failed' }],
      });
      providerState.runStartImplementation = async () => handle;
      stepServiceMock.errorStep.mockReturnValueOnce(errorFinalization.promise);

      let oldCompletion: Promise<void> | undefined;
      if (runKind === 'initial') {
        await agentService.start('step-1');
      } else {
        const followUp = await agentService.beginSendMessage('step-1', [
          { type: 'text', text: 'follow up' },
        ]);
        oldCompletion = followUp.completion;
        await followUp.started;
      }
      await waitForAssertion(() => {
        expect(stepServiceMock.errorStep).toHaveBeenCalledWith('step-1');
      });

    const order: string[] = [];
      const gitCleanup = vi.fn(async () => {
        order.push('git');
        return { task: prTask, changed: false };
      });
      const deletion = deleteAllPrWorkspaces(
      { projectId: 'project-1', pullRequestId: 12 },
      {
        findTaskById: vi.fn().mockResolvedValue(prTask),
        findPrReviewTasksByPullRequest: vi.fn().mockResolvedValue([prTask]),
        findStepsByTaskIds: vi.fn().mockResolvedValue({
          'task-1': [defaultStep],
        }),
        findProjectById: vi.fn().mockResolvedValue({
          id: 'project-1',
          path: '/repo/project',
        }),
        stopCommandsForTask: vi.fn().mockResolvedValue(true),
        stopAgent: vi.fn(async () => {
          await agentService.stop('step-1');
          order.push('stop');
        }),
        closeEditorWindowsForTaskWorktree: vi.fn(),
          cleanupPrWorkspaceGit: gitCleanup,
        deleteTasks: vi.fn(),
        keepPrWorkspaces: vi.fn(),
        emitTaskUpsert: vi.fn(),
        emitTaskDelete: vi.fn(),
      },
    );
      await waitForAssertion(() => {
        expect(handle.stop).toHaveBeenCalledOnce();
      });
      expect(gitCleanup).not.toHaveBeenCalled();

      errorFinalization.resolve();
      await Promise.all([deletion, oldCompletion]);
      expect(order).toEqual(['stop', 'git']);
    },
  );

  it('clears a rejected backend completion barrier before a retry', async () => {
    const replacementRun = createIdleHandle('replacement-after-rejection');
    providerState.runStartImplementation = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider startup failed'))
      .mockResolvedValueOnce(replacementRun.handle);
    stepServiceMock.errorStep.mockRejectedValueOnce(
      new Error('failed to persist error status'),
    );

    const failedRun = await agentService.beginSendMessage('step-1', [
      { type: 'text', text: 'first attempt' },
    ]);
    await expect(failedRun.completion).rejects.toThrow(
      'failed to persist error status',
    );

    const replacement = await agentService.beginSendMessage('step-1', [
      { type: 'text', text: 'retry' },
    ]);
    await replacement.started;
    expect(providerCalls.runStarts).toHaveLength(2);

    await agentService.stop('step-1');
    await replacement.completion;
  });

  it('does not self-deadlock when finalization joins an external stop', async () => {
    const finishErrorStep = createDeferred<void>();
    const handle = createHandle({
      runId: 'self-stopping-run',
      events: [{ type: 'error', error: 'provider failed' }],
    });
    providerState.runStartImplementation = async () => handle;
    stepServiceMock.errorStep.mockImplementationOnce(async () => {
      await finishErrorStep.promise;
      await agentService.stop('step-1');
    });

    const run = await agentService.beginSendMessage('step-1', [
      { type: 'text', text: 'follow up' },
    ]);
    await waitForAssertion(() => {
      expect(stepServiceMock.errorStep).toHaveBeenCalledWith('step-1');
    });
    const externalStop = agentService.stop('step-1');
    await waitForAssertion(() => {
      expect(handle.stop).toHaveBeenCalledOnce();
    });
    finishErrorStep.resolve();
    await expect(Promise.all([run.completion, externalStop])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(stepServiceMock.interruptStep).toHaveBeenCalledWith('step-1');
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

  it('attempts every active session before reporting stopAll failures', async () => {
    const sessions = (
      agentService as unknown as { sessions: Map<string, unknown> }
    ).sessions;
    sessions.set('step-1', {});
    sessions.set('step-2', {});
    const stopMock = vi
      .spyOn(agentService, 'stop')
      .mockImplementation(async (stepId, options) => {
        if (stepId === 'step-1') throw new Error('stop failed');
        expect(options).toEqual({ reason: 'user' });
      });

    try {
      await expect(
        agentService.stopAll({ reason: 'user' }),
      ).rejects.toThrow('Failed to stop 1 active agent sessions');
      expect(stopMock).toHaveBeenCalledTimes(2);
      expect(stopMock).toHaveBeenCalledWith('step-1', { reason: 'user' });
      expect(stopMock).toHaveBeenCalledWith('step-2', { reason: 'user' });
    } finally {
      stopMock.mockRestore();
      sessions.delete('step-1');
      sessions.delete('step-2');
    }
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

  it('captures final queued text only when dequeued with current completion context', async () => {
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
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const { promptId } = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'draft queued text' }],
      {
        submissionId: 'queue-final-text',
        userText: 'draft queued text',
        reviews: [],
      },
    );
    agentService.updateQueuedPrompt('step-1', promptId, 'edited queued text');

    expect(captureAgentMemoryPromptSubmissionSafeMock).not.toHaveBeenCalled();
    outerComplete.resolve();
    await startPromise;
    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalled();
    });

    expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith({
      source: 'queued-prompt',
      sourceId: `queued-prompt:${promptId}`,
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      userText: 'edited queued text',
      previousAgentResult: 'done',
      reviews: [],
    });
  });

  it('rejects queued review metadata not represented in submitted prompt XML', async () => {
    const outerComplete = createDeferred<void>();
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        createCompleteThenWaitHandle({
          runId: 'outer-forged-queue-review',
          waitBeforeComplete: outerComplete.promise,
        }),
      )
      .mockResolvedValueOnce(createHandle({ events: [completeEvent()] }));
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));

    agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'Queued prompt without review XML' }],
      {
        submissionId: 'queued-forged-metadata',
        userText: 'renderer queued replacement',
        reviews: [
          {
            commentId: 'Bearer queued-id-secret',
            body: 'queued body secret',
            selectedText: 'queued selected secret',
            filePath: 'src/forged.ts',
            lineStart: 4,
            lineEnd: 5,
            presets: ['tests'],
          },
        ],
      },
    );
    outerComplete.resolve();
    await startPromise;

    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: 'Queued prompt without review XML',
          reviews: [],
        }),
      );
    });
    const logs = JSON.stringify(debugAgentMock.mock.calls);
    expect(logs).toContain('agent-memory-prompt-admission-mismatch');
    expect(logs).not.toContain('queued-id-secret');
    expect(logs).not.toContain('queued body secret');
    expect(logs).not.toContain('queued selected secret');
    expect(logs).not.toContain('renderer queued replacement');
  });

  it('clears queued review capture when an edit omits review metadata', async () => {
    const outerComplete = createDeferred<void>();
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        createCompleteThenWaitHandle({
          runId: 'outer-remove-review',
          waitBeforeComplete: outerComplete.promise,
        }),
      )
      .mockResolvedValueOnce(
        createHandle({
          runId: 'nested-remove-review',
          events: [completeEvent()],
        }),
    );
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const removedReview = {
      commentId: 'removed-review',
      body: 'Remove this review',
      selectedText: 'x',
      filePath: 'src/a.ts',
      lineStart: 1,
      lineEnd: 1,
      presets: [],
    };
    const { promptId } = agentService.queuePrompt(
      'step-1',
      [
        {
          type: 'text',
          text: submittedReviewPrompt('draft with review', [removedReview]),
        },
      ],
      {
        submissionId: 'queue-remove-review',
        userText: 'draft with review',
        reviews: [removedReview],
      },
    );

    agentService.updateQueuedPrompt('step-1', promptId, 'edited without review');
    outerComplete.resolve();
    await startPromise;
    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: 'edited without review',
          reviews: [],
        }),
      );
    });
    const logs = JSON.stringify(debugAgentMock.mock.calls);
    expect(logs).toContain('agent-memory-queue-review-xml-missing');
    expect(logs).toContain('agent-memory-queue-renderer-mismatch');
    expect(logs).not.toContain('Remove this review');
    expect(logs).not.toContain('edited without review');
  });

  it('drops queued review context omitted from final stable-ID XML', async () => {
    const outerComplete = createDeferred<void>();
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        createCompleteThenWaitHandle({
          runId: 'outer-reconcile-review',
          waitBeforeComplete: outerComplete.promise,
        }),
      )
      .mockResolvedValueOnce(
        createHandle({
          runId: 'nested-reconcile-review',
          events: [completeEvent()],
        }),
      );
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const firstReview = {
      commentId: 'review-first',
      body: 'Keep first',
      selectedText: 'first',
      filePath: 'src/first.ts',
      lineStart: 1,
      lineEnd: 1,
      presets: [],
    };
    const removedReview = {
      commentId: 'review-removed',
      body: 'Remove middle',
      selectedText: 'middle',
      filePath: 'src/middle.ts',
      lineStart: 2,
      lineEnd: 2,
      presets: [],
    };
    const lastReview = {
      commentId: 'review-last',
      body: 'Keep last',
      selectedText: 'last',
      filePath: 'src/last.ts',
      lineStart: 3,
      lineEnd: 3,
      presets: [],
    };
    const { promptId } = agentService.queuePrompt(
      'step-1',
      [
        {
          type: 'text',
          text: submittedReviewPrompt('draft reviews', [
            firstReview,
            removedReview,
            lastReview,
          ]),
        },
      ],
      {
        submissionId: 'queue-reconcile-review',
        userText: 'draft reviews',
        reviews: [firstReview, removedReview, lastReview],
      },
    );
    const finalContent = `<user_review>
<comment index="1" comment_id="review-first"><instruction>Keep first</instruction></comment>
<comment index="3" comment_id="review-last"><instruction>Updated last</instruction></comment>
</user_review>`;

    agentService.updateQueuedPrompt('step-1', promptId, finalContent);
    outerComplete.resolve();
    await startPromise;
    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: finalContent,
          reviews: [
            {
              ...firstReview,
              selectedText: null,
              filePath: null,
              lineStart: null,
              lineEnd: null,
            },
            {
              ...lastReview,
              body: 'Updated last',
              selectedText: null,
              filePath: null,
              lineStart: null,
              lineEnd: null,
            },
          ],
        }),
      );
    });
  });

  it('treats renderer queued review metadata as advisory', async () => {
    const outerComplete = createDeferred<void>();
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        createCompleteThenWaitHandle({
          runId: 'outer-replace-review',
          waitBeforeComplete: outerComplete.promise,
        }),
      )
      .mockResolvedValueOnce(
        createHandle({
          runId: 'nested-replace-review',
          events: [completeEvent()],
        }),
      );
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const oldReview = {
      commentId: 'old-review',
      body: 'Old body',
      selectedText: null,
      filePath: null,
      lineStart: null,
      lineEnd: null,
      presets: [],
    };
    const { promptId } = agentService.queuePrompt(
      'step-1',
      [
        {
          type: 'text',
          text: submittedReviewPrompt('draft', [oldReview]),
        },
      ],
      {
        submissionId: 'queue-advisory-review',
        userText: 'draft',
        reviews: [oldReview],
      },
    );
    const fabricatedReview = {
      commentId: 'Bearer renderer-id-secret',
      body: 'renderer secret body',
      selectedText: 'renderer selected secret',
      filePath: 'src/fabricated.ts',
      lineStart: 400,
      lineEnd: 500,
      presets: ['refactor'],
    };
    const finalContent = `<user_review>
<comment index="1" comment_id="old-review"><instruction>Edited old body</instruction></comment>
<comment index="2" comment_id="Bearer renderer-id-secret"><instruction>renderer secret body</instruction></comment>
</user_review>`;

    agentService.updateQueuedPrompt(
      'step-1',
      promptId,
      finalContent,
      {
        userText: 'renderer replacement text',
        reviews: [fabricatedReview],
      },
    );
    outerComplete.resolve();
    await startPromise;
    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: finalContent,
          reviews: [
            {
              commentId: 'old-review',
              body: 'Edited old body',
              selectedText: null,
              filePath: null,
              lineStart: null,
              lineEnd: null,
              presets: [],
            },
          ],
        }),
      );
    });
    const logs = JSON.stringify(debugAgentMock.mock.calls);
    expect(logs).toContain('agent-memory-queue-review-ids-rejected');
    expect(logs).toContain('agent-memory-queue-renderer-mismatch');
    expect(logs).not.toContain('renderer secret body');
    expect(logs).not.toContain('renderer selected secret');
    expect(logs).not.toContain('renderer-id-secret');
  });

  it('captures coalesced queued user text and deduplicated reviews under the first queue id', async () => {
    const outerComplete = createDeferred<void>();
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        createCompleteThenWaitHandle({
          runId: 'outer-coalesced',
          waitBeforeComplete: outerComplete.promise,
        }),
      )
      .mockResolvedValueOnce(
        createHandle({ runId: 'nested-coalesced', events: [completeEvent()] }),
      );
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const review = {
      commentId: 'review-1',
      body: 'Rename this',
      selectedText: 'x',
      filePath: 'src/a.ts',
      lineStart: 1,
      lineEnd: 1,
      presets: ['rename'],
    };
    const first = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: submittedReviewPrompt('first', [review]) }],
      { submissionId: 'queue-coalesce-first', userText: 'first', reviews: [review] },
    );
    const second = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: submittedReviewPrompt('second', [review]) }],
      {
        submissionId: 'queue-coalesce-second',
        userText: 'second',
        reviews: [review],
      },
    );
    expect(second.promptId).toBe(first.promptId);

    outerComplete.resolve();
    await startPromise;
    await waitForAssertion(() => {
      expect(captureAgentMemoryPromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: `queued-prompt:${first.promptId}`,
          userText: expect.stringContaining('first'),
          reviews: [review],
        }),
      );
    });
  });

  it('deduplicates queued retries by submission id but keeps identical new submissions', async () => {
    const idle = createIdleHandle('queue-retry-run');
    providerState.runStartImplementation = async () => idle.handle;
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const capture = {
      submissionId: 'stable-queued-submission',
      userText: 'same prompt',
      reviews: [],
    };

    const first = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'same prompt' }],
      capture,
    );
    const retry = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'retry payload must be ignored' }],
      capture,
    );
    expect(retry).toEqual(first);
    expect(agentService.getQueuedPrompts('step-1')[0].content).toBe(
      'same prompt',
    );

    agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'same prompt' }],
      { ...capture, submissionId: 'distinct-queued-submission' },
    );
    expect(agentService.getQueuedPrompts('step-1')[0].content).toBe(
      'same prompt\n\nsame prompt',
    );

    agentService.cancelQueuedPrompt('step-1', first.promptId);
    const delayedRetry = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'same prompt' }],
      capture,
    );
    expect(delayedRetry).toEqual(first);
    expect(agentService.getQueuedPrompts('step-1')).toEqual([]);

    const intentionalResubmission = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'same prompt' }],
      { ...capture, submissionId: 'intentional-resubmission' },
    );
    expect(intentionalResubmission.promptId).not.toBe(first.promptId);
    agentService.cancelQueuedPrompt(
      'step-1',
      intentionalResubmission.promptId,
    );
    await agentService.stop('step-1');
    await startPromise;

    const restarted = createIdleHandle('queue-retry-restarted-run');
    providerState.runStartImplementation = async () => restarted.handle;
    const restartedPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(2));
    expect(
      agentService.queuePrompt(
        'step-1',
        [{ type: 'text', text: 'late retry after session replacement' }],
        capture,
      ),
    ).toEqual(first);
    expect(agentService.getQueuedPrompts('step-1')).toEqual([]);
    await agentService.stop('step-1');
    await restartedPromise;
  });

  it('keeps queued submission tombstones after dequeue', async () => {
    const outerComplete = createDeferred<void>();
    const nested = createIdleHandle('dequeued-retry-run');
    providerState.runStartImplementation = vi
      .fn()
      .mockResolvedValueOnce(
        createCompleteThenWaitHandle({
          runId: 'dequeued-retry-outer',
          waitBeforeComplete: outerComplete.promise,
        }),
      )
      .mockResolvedValueOnce(nested.handle);
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const capture = {
      submissionId: 'dequeued-stable-submission',
      userText: 'dequeue once',
      reviews: [],
    };
    const first = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'dequeue once' }],
      capture,
    );

    outerComplete.resolve();
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(2));
    const delayedRetry = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'must not resurrect' }],
      capture,
    );

    expect(delayedRetry).toEqual(first);
    expect(agentService.getQueuedPrompts('step-1')).toEqual([]);
    await agentService.stop('step-1');
    await startPromise;
  });

  it('keeps queued submission tombstones when stop clears the queue', async () => {
    const idle = createIdleHandle('stopped-queue-retry-run');
    providerState.runStartImplementation = async () => idle.handle;
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const capture = {
      submissionId: 'stopped-queue-stable-submission',
      userText: 'stop before dequeue',
      reviews: [],
    };
    const first = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'stop before dequeue' }],
      capture,
    );

    await agentService.stop('step-1');
    await startPromise;

    const restarted = createIdleHandle('stopped-queue-restarted-run');
    providerState.runStartImplementation = async () => restarted.handle;
    const restartedPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(2));
    expect(
      agentService.queuePrompt(
        'step-1',
        [{ type: 'text', text: 'delayed retry must not resurrect' }],
        capture,
      ),
    ).toEqual(first);
    expect(agentService.getQueuedPrompts('step-1')).toEqual([]);
    await agentService.stop('step-1');
    await restartedPromise;
  });

  it('tombstones pending submission ids evicted by the per-session cap', async () => {
    const idle = createIdleHandle('queue-cap-run');
    providerState.runStartImplementation = async () => idle.handle;
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const firstCapture = {
      submissionId: 'queue-cap-first',
      userText: 'capped prompt',
      reviews: [],
    };
    const first = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'capped prompt' }],
      firstCapture,
    );
    for (let index = 0; index < 256; index += 1) {
      agentService.queuePrompt(
        'step-1',
        [{ type: 'text', text: `prompt ${index}` }],
        {
          submissionId: `queue-cap-${index}`,
          userText: `prompt ${index}`,
          reviews: [],
        },
      );
    }
    const contentBeforeRetry = agentService.getQueuedPrompts('step-1')[0].content;

    expect(
      agentService.queuePrompt(
        'step-1',
        [{ type: 'text', text: 'evicted retry must not append' }],
        firstCapture,
      ),
    ).toEqual(first);
    expect(agentService.getQueuedPrompts('step-1')[0].content).toBe(
      contentBeforeRetry,
    );

    agentService.cancelQueuedPrompt('step-1', first.promptId);
    await agentService.stop('step-1');
    await startPromise;
  });

  it('evicts the oldest process-wide queued submission tombstone at the cap', async () => {
    const idle = createIdleHandle('tombstone-cap-run');
    providerState.runStartImplementation = async () => idle.handle;
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));

    let oldestPromptId = '';
    let newestPromptId = '';
    for (let index = 0; index <= 2_048; index += 1) {
      const { promptId } = agentService.queuePrompt(
        'step-1',
        [{ type: 'text', text: '' }],
        {
          submissionId: `global-tombstone-cap-${index}`,
          userText: '',
          reviews: [],
        },
      );
      if (index === 0) oldestPromptId = promptId;
      if (index === 2_048) newestPromptId = promptId;
      agentService.cancelQueuedPrompt('step-1', promptId);
    }

    const evictedRetry = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'oldest tombstone was evicted' }],
      {
        submissionId: 'global-tombstone-cap-0',
        userText: 'oldest tombstone was evicted',
        reviews: [],
      },
    );
    expect(evictedRetry.promptId).not.toBe(oldestPromptId);
    expect(
      agentService.queuePrompt(
        'step-1',
        [{ type: 'text', text: 'newest tombstone remains' }],
        {
          submissionId: 'global-tombstone-cap-2048',
          userText: 'newest tombstone remains',
          reviews: [],
        },
      ),
    ).toEqual({ promptId: newestPromptId });
    expect(agentService.getQueuedPrompts('step-1')).toEqual([
      expect.objectContaining({ id: evictedRetry.promptId }),
    ]);

    await agentService.stop('step-1');
    await startPromise;
  });

  it('never captures a cancelled queued prompt', async () => {
    const idle = createIdleHandle();
    providerState.runStartImplementation = async () => idle.handle;
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => expect(providerCalls.runStarts).toHaveLength(1));
    const { promptId } = agentService.queuePrompt(
      'step-1',
      [{ type: 'text', text: 'cancel me' }],
      {
        submissionId: 'queue-cancel',
        userText: 'cancel me',
        reviews: [],
      },
    );

    agentService.cancelQueuedPrompt('step-1', promptId);
    await agentService.stop('step-1');
    await startPromise;

    expect(captureAgentMemoryPromptSubmissionSafeMock).not.toHaveBeenCalled();
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

  it('pushes refreshed permission rules to live sessions when project rules change', async () => {
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
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    resolveRulesMock.mockReturnValue([
      { tool: 'bash', pattern: 'npm test', action: 'allow' },
    ]);

    // Unrelated project — must be ignored.
    emitPermissionsChanged({ scope: 'project', projectPath: '/other/project' });
    emitPermissionsChanged({
      scope: 'project',
      projectPath: defaultProject.path,
    });

    await waitForAssertion(() => {
      expect(providerCalls.permissionRuleUpdates).toEqual([
        {
          handle,
          rules: [{ tool: 'bash', pattern: 'npm test', action: 'allow' }],
        },
      ]);
    });

    release();
    await startPromise;
  });

  it('refreshes only the named step on session-scoped permission changes', async () => {
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
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    // Session grant persisted by step-permission-service.
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: { bash: { 'npm test': 'allow' } },
    });

    // Another step's session change must not touch this one.
    emitPermissionsChanged({ scope: 'session', stepId: 'step-2' });
    emitPermissionsChanged({ scope: 'session', stepId: 'step-1' });

    await waitForAssertion(() => {
      expect(providerCalls.permissionRuleUpdates).toEqual([
        {
          handle,
          rules: [{ tool: 'bash', pattern: 'npm test', action: 'allow' }],
        },
      ]);
    });

    release();
    await startPromise;
  });

  it('pushes refreshed permission rules to live sessions on global changes', async () => {
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
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    resolveGlobalRulesMock.mockResolvedValue([
      { tool: 'read', pattern: '*', action: 'allow' },
    ]);
    resolveRulesMock.mockReturnValue([
      { tool: 'read', pattern: '*', action: 'allow' },
    ]);

    emitPermissionsChanged({ scope: 'global' });

    await waitForAssertion(() => {
      expect(providerCalls.permissionRuleUpdates).toHaveLength(1);
    });
    expect(providerCalls.permissionRuleUpdates[0]).toMatchObject({
      handle,
      rules: [{ tool: 'read', pattern: '*', action: 'allow' }],
    });

    release();
    await startPromise;
  });

  it('ignores permission changes when no session is active', async () => {
    emitPermissionsChanged({ scope: 'global' });
    await Promise.resolve();
    expect(providerCalls.permissionRuleUpdates).toEqual([]);
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

  it('validates and persists selected parent directory before responding', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'external_directory',
        input: {
          filepath: TEST_REQUESTED_PATH,
          parentDir: TEST_REQUESTED_DIRECTORY,
        },
        directoryAccess: {
          requestedPath: TEST_REQUESTED_PATH,
          requestedDirectory: TEST_REQUESTED_DIRECTORY,
          parentDirectories: [
            { path: TEST_ALLOWED_DIRECTORY },
            { path: path.dirname(TEST_ALLOWED_DIRECTORY) },
          ],
        },
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

    await agentService.respond('step-1', 'permission-1', {
      behavior: 'allow',
      allowMode: 'session',
      allowedDirectory: TEST_ALLOWED_DIRECTORY,
    });

    expect(buildToolPermissionConfigMock).toHaveBeenCalledWith({
      existing: undefined,
      matchValue: TEST_DIRECTORY_PATTERN,
    });
    expect(taskStepRepositoryMock.update).toHaveBeenCalledWith('step-1', {
      sessionRules: {
        external_directory: { [TEST_DIRECTORY_PATTERN]: 'allow' },
      },
    });
    expect(providerCalls.permissions).toEqual([
      {
        handle,
        requestId: 'permission-1',
        response: {
          behavior: 'allow',
          allowMode: 'session',
          allowedDirectory: TEST_ALLOWED_DIRECTORY,
        },
      },
    ]);

    release();
    await startPromise;
  });

  it('coalesces concurrent responses for the same permission request', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'external_directory',
        input: {},
        directoryAccess: {
          requestedPath: TEST_REQUESTED_PATH,
          requestedDirectory: TEST_REQUESTED_DIRECTORY,
          parentDirectories: [{ path: TEST_ALLOWED_DIRECTORY }],
        },
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).not.toBeNull();
    });

    await Promise.all([
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
        allowedDirectory: TEST_ALLOWED_DIRECTORY,
      }),
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
        allowedDirectory: TEST_ALLOWED_DIRECTORY,
      }),
    ]);

    expect(providerCalls.permissions).toHaveLength(1);
    expect(buildToolPermissionConfigMock).toHaveBeenCalledTimes(1);

    release();
    await startPromise;
  });

  it('clears a provider-resolved request when directory persistence fails', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'external_directory',
        input: {},
        directoryAccess: {
          requestedPath: TEST_REQUESTED_PATH,
          requestedDirectory: TEST_REQUESTED_DIRECTORY,
          parentDirectories: [{ path: TEST_ALLOWED_DIRECTORY }],
        },
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).not.toBeNull();
    });
    taskStepRepositoryMock.update.mockImplementation(async (_id, update) => {
      if ('sessionRules' in update) throw new Error('database unavailable');
      return { ...defaultStep, ...update };
    });

    await expect(
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
        allowedDirectory: TEST_ALLOWED_DIRECTORY,
      }),
    ).resolves.toBeUndefined();

    expect(providerCalls.permissions).toHaveLength(1);
    expect(agentService.getPendingRequest('step-1')).toBeNull();

    release();
    await startPromise;
  });

  it('does not restore running status when completion races directory persistence', async () => {
    const complete = createDeferred<void>();
    const persistenceStarted = createDeferred<void>();
    const persistence = createDeferred<void>();
    const handle = createHandle();
    handle.events = (async function* () {
      yield {
        type: 'permission-request',
        request: {
          requestId: 'permission-1',
          toolName: 'external_directory',
          input: {},
          directoryAccess: {
            requestedPath: TEST_REQUESTED_PATH,
            requestedDirectory: TEST_REQUESTED_DIRECTORY,
            parentDirectories: [{ path: TEST_ALLOWED_DIRECTORY }],
          },
        },
      } satisfies AgentEvent;
      await complete.promise;
      yield completeEvent();
    })();
    providerState.runStartImplementation = async () => handle;
    taskStepRepositoryMock.update.mockImplementation(async (_id, update) => {
      if ('sessionRules' in update) {
        persistenceStarted.resolve();
        await persistence.promise;
      }
      return { ...defaultStep, ...update };
    });

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).not.toBeNull();
    });

    const response = agentService.respond('step-1', 'permission-1', {
      behavior: 'allow',
      allowedDirectory: TEST_ALLOWED_DIRECTORY,
    });
    await persistenceStarted.promise;
    complete.resolve();
    await waitForAssertion(() => {
      expect(stepServiceMock.completeStep).toHaveBeenCalledWith('step-1');
      expect(agentService.getPendingRequest('step-1')).toBeNull();
    });
    persistence.resolve();
    await response;

    expect(taskRepositoryMock.update).not.toHaveBeenCalledWith('task-1', {
      status: 'running',
    });
  });

  it('does not restore running status when stop races directory persistence', async () => {
    const persistenceStarted = createDeferred<void>();
    const persistence = createDeferred<void>();
    const waiting = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'external_directory',
        input: {},
        directoryAccess: {
          requestedPath: TEST_REQUESTED_PATH,
          requestedDirectory: TEST_REQUESTED_DIRECTORY,
          parentDirectories: [{ path: TEST_ALLOWED_DIRECTORY }],
        },
      },
    });
    providerState.runStartImplementation = async () => waiting.handle;
    taskStepRepositoryMock.update.mockImplementation(async (_id, update) => {
      if ('sessionRules' in update) {
        persistenceStarted.resolve();
        await persistence.promise;
      }
      return { ...defaultStep, ...update };
    });

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).not.toBeNull();
    });

    const response = agentService.respond('step-1', 'permission-1', {
      behavior: 'allow',
      allowedDirectory: TEST_ALLOWED_DIRECTORY,
    });
    await persistenceStarted.promise;
    await agentService.stop('step-1');
    persistence.resolve();
    await response;

    expect(taskRepositoryMock.update).not.toHaveBeenCalledWith('task-1', {
      status: 'running',
    });
  });

  it('rejects a directory not offered by the pending request', async () => {
    const waiting = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'external_directory',
        input: {},
        directoryAccess: {
          requestedPath: TEST_REQUESTED_PATH,
          requestedDirectory: TEST_REQUESTED_DIRECTORY,
          parentDirectories: [{ path: TEST_ALLOWED_DIRECTORY }],
        },
      },
    });
    providerState.runStartImplementation = async () => waiting.handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).not.toBeNull();
    });

    await expect(
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
        allowedDirectory: path.dirname(TEST_ALLOWED_DIRECTORY),
      }),
    ).rejects.toThrow('not a valid parent choice');
    expect(providerCalls.permissions).toEqual([]);
    expect(agentService.getPendingRequest('step-1')).not.toBeNull();

    waiting.release();
    await startPromise;
  });

  it('does not persist a new directory rule when provider response fails', async () => {
    providerState.permissionResponseError = new Error('permission failed');
    const waiting = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'external_directory',
        input: {},
        directoryAccess: {
          requestedPath: TEST_REQUESTED_PATH,
          requestedDirectory: TEST_REQUESTED_DIRECTORY,
          parentDirectories: [{ path: TEST_ALLOWED_DIRECTORY }],
        },
      },
    });
    providerState.runStartImplementation = async () => waiting.handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).not.toBeNull();
    });
    await expect(
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
        allowedDirectory: TEST_ALLOWED_DIRECTORY,
      }),
    ).rejects.toThrow('permission failed');

    expect(
      taskRepositoryMock.update.mock.calls.filter(
        ([, update]) => 'sessionRules' in update,
      ),
    ).toEqual([]);
    expect(agentService.getPendingRequest('step-1')).not.toBeNull();

    providerState.permissionResponseError = null;
    waiting.release();
    await startPromise;
  });

  it('leaves a prior directory deny unchanged when provider response fails', async () => {
    providerState.permissionResponseError = new Error('permission failed');
    const waiting = createWaitingHandle({
      type: 'permission-request',
      request: {
        requestId: 'permission-1',
        toolName: 'external_directory',
        input: {},
        directoryAccess: {
          requestedPath: TEST_REQUESTED_PATH,
          requestedDirectory: TEST_REQUESTED_DIRECTORY,
          parentDirectories: [{ path: TEST_ALLOWED_DIRECTORY }],
        },
      },
    });
    providerState.runStartImplementation = async () => waiting.handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).not.toBeNull();
    });
    await expect(
      agentService.respond('step-1', 'permission-1', {
        behavior: 'allow',
        allowedDirectory: TEST_ALLOWED_DIRECTORY,
      }),
    ).rejects.toThrow('permission failed');

    expect(
      taskRepositoryMock.update.mock.calls.filter(
        ([, update]) => 'sessionRules' in update,
      ),
    ).toEqual([]);

    providerState.permissionResponseError = null;
    waiting.release();
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
            options: [
              { label: 'A', description: 'Pick A' },
              { label: 'B', description: 'Do not pick B' },
            ],
          },
          {
            id: 'context',
            type: 'text',
            question: 'Anything else?',
            header: 'Context',
            multiSelect: false,
            options: [],
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
    captureAgentMemoryEventSafeMock.mockReturnValue(new Promise(() => {}));

    await withTimeout(
      agentService.respond('step-1', 'question-1', {
        answers: {
          'Which option?': 'A, Notes: Keep scope narrow',
          context: 'Preserve APIs',
        },
        memoryDetails: [
          {
            questionKey: 'Which option?',
            selectedLabels: ['A'],
            customAnswer: null,
            notes: 'Keep scope narrow',
          },
          {
            questionKey: 'context',
            selectedLabels: [],
            customAnswer: 'Preserve APIs',
            notes: null,
          },
        ],
      }),
    );

    expect(providerCalls.questions).toEqual([
      {
        handle,
        requestId: 'question-1',
        answer: {
          'Which option?': 'A, Notes: Keep scope narrow',
          context: 'Preserve APIs',
        },
        metadata: {
          questionKeys: ['Which option?', 'context'],
          wasFreeform: undefined,
          wasFreeformByQuestion: undefined,
        },
      },
    ]);
    expect(notificationServiceMock.close).toHaveBeenCalledWith(
      'task-1:question',
    );
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledWith({
      source: 'question-answer',
      sourceId: 'question:question-1:Which option?',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      text: 'A\nKeep scope narrow',
      context: {
        question: 'Which option?',
        selectedLabels: ['A'],
        customAnswer: null,
        notes: 'Keep scope narrow',
      },
      createdAt: expect.any(String),
    });
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledWith({
      source: 'question-answer',
      sourceId: 'question:question-1:context',
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      text: 'Preserve APIs',
      context: {
        question: 'Anything else?',
        selectedLabels: [],
        customAnswer: 'Preserve APIs',
        notes: null,
      },
      createdAt: expect.any(String),
    });
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(captureAgentMemoryEventSafeMock.mock.calls),
    ).not.toContain('Do not pick B');

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
            options: [
              { label: 'A', description: 'Pick A', recommended: true },
            ],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: {
          requestId: 'question-1',
          questions: [
            {
              options: [{ label: 'A', recommended: true }],
            },
          ],
        },
      });
    });

    await expect(
      agentService.respond('step-1', 'question-1', {
        answers: { 'Which option?': 'A' },
        memoryDetails: [
          {
            questionKey: 'Which option?',
            selectedLabels: ['A'],
            customAnswer: null,
            notes: null,
          },
        ],
      }),
    ).rejects.toThrow('Unsupported backend capability');

    expect(agentService.getPendingRequest('step-1')).toMatchObject({
      type: 'question',
      data: { requestId: 'question-1' },
    });

    release();
    await startPromise;
  });

  it.each([
    {
      name: 'forged question text',
      sensitiveValue: 'SENSITIVE_FORGED_QUESTION',
      memoryDetails: [
        {
          questionKey: 'choice',
          question: 'SENSITIVE_FORGED_QUESTION',
          selectedLabels: ['A'],
          customAnswer: null,
          notes: null,
        },
      ],
    },
    {
      name: 'extra selected option',
      sensitiveValue: 'SENSITIVE_UNSELECTED_OPTION',
      memoryDetails: [
        {
          questionKey: 'choice',
          selectedLabels: ['A', 'SENSITIVE_UNSELECTED_OPTION'],
          customAnswer: null,
          notes: null,
        },
      ],
    },
    {
      name: 'notes absent from delivered answer',
      sensitiveValue: 'SENSITIVE_FORGED_NOTES',
      memoryDetails: [
        {
          questionKey: 'choice',
          selectedLabels: ['A'],
          customAnswer: null,
          notes: 'SENSITIVE_FORGED_NOTES',
        },
      ],
    },
    {
      name: 'custom answer absent from delivered answer',
      sensitiveValue: 'SENSITIVE_FORGED_CUSTOM',
      memoryDetails: [
        {
          questionKey: 'choice',
          selectedLabels: [],
          customAnswer: 'SENSITIVE_FORGED_CUSTOM',
          notes: null,
        },
      ],
    },
  ])(
    'rejects $name from question memory capture',
    async ({ memoryDetails, sensitiveValue }) => {
      const { handle, release } = createWaitingHandle({
        type: 'question',
        request: {
          requestId: 'question-forged',
          questions: [
            {
              id: 'choice',
              question: 'Which option?',
              header: 'Choice',
              multiSelect: false,
              options: [
                { label: 'A', description: 'Pick A' },
                { label: 'B', description: 'Pick B' },
              ],
            },
          ],
        },
      });
      providerState.runStartImplementation = async () => handle;

      const startPromise = agentService.start('step-1');
      await waitForAssertion(() => {
        expect(agentService.getPendingRequest('step-1')).toMatchObject({
          type: 'question',
          data: { requestId: 'question-forged' },
        });
      });

      await expect(
        agentService.respond('step-1', 'question-forged', {
          answers: { choice: 'A' },
          memoryDetails,
        }),
      ).rejects.toThrow('Invalid question response');

      expect(providerCalls.questions).toEqual([]);
      expect(captureAgentMemoryEventSafeMock).not.toHaveBeenCalled();
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId: 'question-forged' },
      });
      expect(
        debugAgentMock.mock.calls.some(([message]) =>
          String(message).includes('Rejecting question response'),
        ),
      ).toBe(true);
      expect(JSON.stringify(debugAgentMock.mock.calls)).not.toContain(
        sensitiveValue,
      );

      release();
      await startPromise;
    },
  );

  it('assigns distinct keys and captures duplicate ID-less questions', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'question',
      request: {
        requestId: 'question-duplicates',
        questions: [
          {
            question: 'Choose one',
            header: 'First',
            multiSelect: false,
            options: [{ label: 'A', description: '' }],
          },
          {
            question: 'Choose one',
            header: 'Second',
            multiSelect: false,
            options: [{ label: 'B', description: '' }],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId: 'question-duplicates' },
      });
    });
    const pending = agentService.getPendingRequest('step-1');
    expect(pending?.type).toBe('question');
    if (pending?.type !== 'question') throw new Error('Expected question');
    expect(pending.data.questions.map((question) => question.key)).toEqual([
      'Choose one#1',
      'Choose one#2',
    ]);

    const rendererAnswers = {
      'Choose one#2': 'B',
      untrusted: 'SENSITIVE_EXTRA_ANSWER',
      'Choose one#1': 'A',
    };
    const canonicalAnswers = {
      'Choose one#1': 'A',
      'Choose one#2': 'B',
    };
    await agentService.respond('step-1', 'question-duplicates', {
      answers: rendererAnswers,
      memoryDetails: [
        {
          questionKey: 'Choose one#2',
          selectedLabels: ['B'],
          customAnswer: null,
          notes: null,
        },
        {
          questionKey: 'Choose one#1',
          selectedLabels: ['A'],
          customAnswer: null,
          notes: null,
        },
      ],
    });

    expect(providerCalls.questions).toEqual([
      expect.objectContaining({
        answer: canonicalAnswers,
        metadata: expect.objectContaining({
          questionKeys: ['Choose one#1', 'Choose one#2'],
        }),
      }),
    ]);
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledTimes(2);
    expect(
      captureAgentMemoryEventSafeMock.mock.calls.map(
        ([event]) => [event.sourceId, event.context.selectedLabels],
      ),
    ).toEqual([
      ['question:question-duplicates:Choose one#1', ['A']],
      ['question:question-duplicates:Choose one#2', ['B']],
    ]);

    release();
    await startPromise;
  });

  // "Decide for me" is a deferral, not a stated preference. It must still reach
  // the agent, but recording it would teach memory something the user never said.
  it('delivers Decide for me without capturing it as a preference', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'question',
      request: {
        requestId: 'question-decide',
        questions: [
          {
            id: 'choice',
            question: 'Which option?',
            header: 'Choice',
            multiSelect: false,
            allowFreeform: false,
            options: [{ label: 'A', description: '' }],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId: 'question-decide' },
      });
    });

    await agentService.respond('step-1', 'question-decide', {
      answers: { choice: 'Decide for me' },
      wasFreeform: true,
      wasFreeformByQuestion: { choice: true },
      memoryDetails: [
        {
          questionKey: 'choice',
          selectedLabels: [],
          customAnswer: 'Decide for me',
          notes: null,
        },
      ],
    });

    expect(providerCalls.questions).toEqual([
      expect.objectContaining({
        answer: { choice: 'Decide for me' },
      }),
    ]);
    expect(captureAgentMemoryEventSafeMock).not.toHaveBeenCalled();

    release();
    await startPromise;
  });

  it('still captures the note attached to a Decide for me answer', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'question',
      request: {
        requestId: 'question-decide-note',
        questions: [
          {
            id: 'choice',
            question: 'Which option?',
            header: 'Choice',
            multiSelect: false,
            allowFreeform: false,
            options: [{ label: 'A', description: '' }],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId: 'question-decide-note' },
      });
    });

    await agentService.respond('step-1', 'question-decide-note', {
      answers: { choice: 'Decide for me, Notes: prefer the cheap path' },
      wasFreeform: true,
      wasFreeformByQuestion: { choice: true },
      memoryDetails: [
        {
          questionKey: 'choice',
          selectedLabels: [],
          customAnswer: 'Decide for me',
          notes: 'prefer the cheap path',
        },
      ],
    });

    // The deferral is dropped, the user's actual note survives.
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledOnce();
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'question:question-decide-note:choice',
        text: 'prefer the cheap path',
        context: expect.objectContaining({ customAnswer: null }),
      }),
    );

    release();
    await startPromise;
  });

  it('rejects arbitrary custom answers for fixed-choice questions', async () => {
    const { handle, release } = createWaitingHandle({
      type: 'question',
      request: {
        requestId: 'question-fixed-custom',
        questions: [
          {
            id: 'choice',
            question: 'Which option?',
            header: 'Choice',
            multiSelect: false,
            allowFreeform: false,
            options: [{ label: 'A', description: '' }],
          },
        ],
      },
    });
    providerState.runStartImplementation = async () => handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId: 'question-fixed-custom' },
      });
    });

    await expect(
      agentService.respond('step-1', 'question-fixed-custom', {
        answers: { choice: 'Fabricated custom' },
        memoryDetails: [
          {
            questionKey: 'choice',
            selectedLabels: [],
            customAnswer: 'Fabricated custom',
            notes: null,
          },
        ],
      }),
    ).rejects.toThrow('Invalid question response');
    expect(providerCalls.questions).toEqual([]);
    expect(captureAgentMemoryEventSafeMock).not.toHaveBeenCalled();

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
        memoryDetails: [
          {
            questionKey: 'Which option?',
            selectedLabels: ['A'],
            customAnswer: null,
            notes: null,
          },
        ],
      }),
    ).rejects.toThrow('question failed');

    expect(captureAgentMemoryEventSafeMock).not.toHaveBeenCalled();

    expect(agentService.getPendingRequest('step-1')).toMatchObject({
      type: 'question',
      data: { requestId: 'question-1' },
    });

    providerState.questionResponseError = null;
    await agentService.respond('step-1', 'question-1', {
      answers: { 'Which option?': 'A' },
      memoryDetails: [
        {
          questionKey: 'Which option?',
          selectedLabels: ['A'],
          customAnswer: null,
          notes: null,
        },
      ],
    });

    expect(providerCalls.questions).toEqual([
      {
        handle,
        requestId: 'question-1',
        answer: { 'Which option?': 'A' },
        metadata: {
          questionKeys: ['Which option?'],
          wasFreeform: undefined,
          wasFreeformByQuestion: undefined,
        },
      },
    ]);
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledTimes(1);
    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'question:question-1:Which option?',
      }),
    );
    expect(agentService.getPendingRequest('step-1')).toBeNull();

    release();
    await startPromise;
  });

  it('captures structured question answers after the MCP broker accepts them', async () => {
    const idle = createIdleHandle();
    providerState.runStartImplementation = async () => idle.handle;

    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });
    const runInput = providerCalls.runStarts[0] as {
      config: {
        mcpServers: Record<
          string,
          { env: Record<string, string> }
        >;
      };
    };
    const env = runInput.config.mcpServers['jean-claude-mcp'].env;
    const config = {
      serverUrl: env.JC_MCP_BRIDGE_URL,
      token: env.JC_MCP_AUTH_TOKEN,
      registrationId: env.JC_MCP_REGISTRATION_ID,
    };
    const submission = await submitQuestion({ config, stepId: 'step-1' });
    const { requestId } = (await submission.json()) as { requestId: string };
    await waitForAssertion(() => {
      expect(agentService.getPendingRequest('step-1')).toMatchObject({
        type: 'question',
        data: { requestId },
      });
    });

    await expect(
      agentService.respond('step-1', requestId, {
        answers: { approach: '' },
        memoryDetails: [
          {
            questionKey: 'approach',
            selectedLabels: [],
            customAnswer: 'Invalid draft',
            notes: null,
          },
        ],
      }),
    ).rejects.toThrow('Invalid question response');
    expect(captureAgentMemoryEventSafeMock).not.toHaveBeenCalled();

    await agentService.respond('step-1', requestId, {
      answers: { approach: 'Small' },
      memoryDetails: [
        {
          questionKey: 'approach',
          selectedLabels: ['Small'],
          customAnswer: null,
          notes: null,
        },
      ],
    });

    expect(captureAgentMemoryEventSafeMock).toHaveBeenCalledWith({
      source: 'question-answer',
      sourceId: `question:${requestId}:approach`,
      projectId: 'project-1',
      taskId: 'task-1',
      stepId: 'step-1',
      text: 'Small',
      context: {
        question: 'Which approach?',
        selectedLabels: ['Small'],
        customAnswer: null,
        notes: null,
      },
      createdAt: expect.any(String),
    });

    idle.release();
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

  it('rejects inactive PR review chat mode changes', async () => {
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    await expect(agentService.setMode('step-1', 'auto')).rejects.toThrow(
      'read-only',
    );
    expect(providerCalls.modes).toEqual([]);
    expect(taskStepRepositoryMock.update).not.toHaveBeenCalled();
  });

  it('rejects active PR review chat mode changes without changing the backend', async () => {
    const chatStep = {
      ...defaultStep,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat' as const,
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    };
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue(chatStep);
    const { handle, release } = createWaitingHandle({
      type: 'rate-limit',
      message: 'waiting',
    });
    providerState.runStartImplementation = async () => handle;
    const startPromise = agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.runStarts).toHaveLength(1);
    });

    await expect(agentService.setMode('step-1', 'auto')).rejects.toThrow(
      'read-only',
    );
    expect(providerCalls.modes).toEqual([]);
    expect(taskStepRepositoryMock.update).not.toHaveBeenCalledWith('step-1', {
      interactionMode: 'auto',
    });

    release();
    await startPromise;
  });

  it('restores ask mode when a backend reports a PR review chat mode change', async () => {
    taskRepositoryMock.findById.mockResolvedValue({
      ...defaultTask,
      type: 'pr-review',
      pullRequestId: '12',
    });
    taskStepRepositoryMock.findById.mockResolvedValue({
      ...defaultStep,
      sessionRules: buildReadOnlyPrReviewSessionRules(),
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });
    const handle = createHandle({
      events: [{ type: 'mode-change', mode: 'auto' }, completeEvent()],
    });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(stepServiceMock.completeStep).toHaveBeenCalledWith('step-1');
    });

    expect(providerCalls.modes).toEqual([{ handle, mode: 'ask' }]);
    expect(taskStepRepositoryMock.update).not.toHaveBeenCalledWith('step-1', {
      interactionMode: 'auto',
    });
  });

  it('syncs session allowed tools through the provider only when supported', async () => {
    const sibling = {
      ...defaultStep,
      id: 'step-2',
      sessionRules: { write: 'allow' as const },
    };
    const storedSteps = new Map([
      ['step-1', defaultStep],
      ['step-2', sibling],
    ]);
    taskStepRepositoryMock.findById.mockImplementation(async (stepId) =>
      storedSteps.get(stepId),
    );
    taskStepRepositoryMock.update.mockImplementation(async (stepId, update) => {
      const updated = { ...storedSteps.get(stepId)!, ...update };
      storedSteps.set(stepId, updated);
      return updated;
    });
    providerState.sessionAllowedTools = ['bash:npm test', 'read'];
    const handle = createHandle({ events: [completeEvent()] });
    providerState.runStartImplementation = async () => handle;

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(providerCalls.sessionAllowedTools).toEqual([{ handle }]);
    });

    expect(taskStepRepositoryMock.update).toHaveBeenCalledWith('step-1', {
      sessionRules: {
        bash: { 'npm test': 'allow' },
        read: 'allow',
      },
    });
    expect(taskStepRepositoryMock.update).not.toHaveBeenCalledWith(
      'step-2',
      expect.objectContaining({ sessionRules: expect.anything() }),
    );
    expect(storedSteps.get('step-2')).toBe(sibling);
    expect(emitStepUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'step-1',
        sessionRules: {
          bash: { 'npm test': 'allow' },
          read: 'allow',
        },
      }),
    );

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
    expect(taskStepRepositoryMock.update).not.toHaveBeenCalledWith('step-1', {
      sessionRules: expect.anything(),
    });
  });

  it('ignores provider-reported bare Bash without failing completion', async () => {
    providerState.sessionAllowedTools = ['bash', 'bash:'];
    providerState.runStartImplementation = async () =>
      createHandle({ events: [completeEvent()] });

    await agentService.start('step-1');
    await waitForAssertion(() => {
      expect(stepServiceMock.completeStep).toHaveBeenCalledWith('step-1');
    });

    expect(stepServiceMock.errorStep).not.toHaveBeenCalled();
    expect(taskStepRepositoryMock.update).not.toHaveBeenCalledWith('step-1', {
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
