import { describe, expect, it, vi } from 'vitest';

import type { Project, Task, TaskStep } from '@shared/types';

import {
  buildPrReviewChatPrompt,
  buildPrReviewFollowUpPrompt,
  buildReadOnlyPrReviewSessionRules,
  continuePrReviewChatStep,
  createPrReviewChatStep,
} from './pr-review-agent-service';
import { evaluatePermission, flattenScope } from './permission-settings-service';

const { getAgentBackendProviderMock } = vi.hoisted(
  () => {
    const providerPermissionsSupported = new Map([
      ['claude-code', true],
      ['opencode', true],
      ['codex', false],
      ['copilot', true],
    ]);
    return {
      providerPermissionsSupported,
      getAgentBackendProviderMock: vi.fn((backend: string) => ({
        capabilities: {
          agent: {
            permissions: providerPermissionsSupported.get(backend)
              ? { supported: true, implementation: {} }
              : { supported: false, reason: 'unsupported' },
          },
        },
      })),
    };
  },
);

vi.mock('./agent-backends/providers', () => ({
  getAgentBackendProvider: getAgentBackendProviderMock,
}));

describe('buildReadOnlyPrReviewSessionRules', () => {
  it('allows read and search tools', () => {
    const rules = flattenScope(buildReadOnlyPrReviewSessionRules());

    expect(evaluatePermission(rules, 'read', 'src/app.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'glob', '**/*.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'grep', 'function')).toBe('allow');
  });

  it('denies write and edit tools', () => {
    const rules = flattenScope(buildReadOnlyPrReviewSessionRules());

    expect(evaluatePermission(rules, 'write', 'src/app.ts')).toBe('deny');
    expect(evaluatePermission(rules, 'edit', 'src/app.ts')).toBe('deny');
    expect(evaluatePermission(rules, 'multiedit', 'src/app.ts')).toBe('deny');
  });

  it('denies unlisted tools', () => {
    const rules = flattenScope(buildReadOnlyPrReviewSessionRules());

    expect(evaluatePermission(rules, 'task', '')).toBe('deny');
  });

  it('does not allow bare bash', () => {
    expect(buildReadOnlyPrReviewSessionRules().bash).toBe('deny');
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review: Fix auth',
    prompt: 'Review PR #12: Fix auth',
    status: 'waiting',
    worktreePath: '/repo/.worktrees/review-pr-12',
    startCommitHash: 'abc123',
    sourceBranch: 'feature/fix-auth',
    branchName: 'review-pr-12',
    hasUnread: false,
    userCompleted: false,
    sessionRules: buildReadOnlyPrReviewSessionRules(),
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '12',
    pullRequestUrl: 'https://example.test/pr/12',
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Jean-Claude',
    path: '/repo',
    type: 'local',
    providerId: null,
    remoteUrl: null,
    color: '#000000',
    logoPath: null,
    logoSource: null,
    sortOrder: 0,
    worktreesPath: null,
    defaultBranch: 'main',
    repoProviderId: 'provider-1',
    repoProjectId: 'repo-project-1',
    repoProjectName: 'Repo Project',
    repoId: 'repo-1',
    repoName: 'repo',
    workItemProviderId: null,
    workItemProjectId: null,
    workItemProjectName: null,
    showWorkItemsInFeed: false,
    showPrsInFeed: true,
    autoPullSourceBranch: false,
    commitWithNoVerify: false,
    defaultAgentBackend: 'opencode',
    defaultAgentModelPreference: 'gpt-5.5',
    completionContext: null,
    summary: null,
    aiSkillSlots: null,
    protectedBranches: [],
    favoriteBranches: [],
    prPriority: 'normal',
    workItemPriority: 'normal',
    archivedAt: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 'step-1',
    taskId: 'task-1',
    name: 'Ask Agent: src/auth.ts:4',
    type: 'agent',
    dependsOn: [],
    promptTemplate: 'Prompt',
    resolvedPrompt: null,
    status: 'ready',
    sessionId: null,
    interactionMode: 'ask',
    modelPreference: 'gpt-5.5',
    thinkingEffort: 'default',
    agentBackend: 'opencode',
    output: null,
    images: null,
    meta: {
      kind: 'pr-review-chat',
      pullRequestId: 12,
      filePath: 'src/auth.ts',
      lineStart: 4,
      lineEnd: 6,
      selectedText: 'return user.id;',
    },
    autoStart: false,
    sortOrder: 0,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildPrReviewChatPrompt', () => {
  it('builds a read-only prompt with PR and selected range context', () => {
    const prompt = buildPrReviewChatPrompt({
      prTitle: 'Fix auth',
      prDescription: 'Tightens token validation and session handling.',
      pullRequestId: 12,
      filePath: 'src/auth.ts',
      lineStart: 4,
      lineEnd: 6,
      selectedText: 'return user.id;',
      question: 'Is this safe?',
    });

    expect(prompt).toContain('PR #12: Fix auth');
    expect(prompt).toContain('<pr_description>');
    expect(prompt).toContain('Tightens token validation and session handling.');
    expect(prompt).toContain('</pr_description>');
    expect(prompt).toContain('<selected_context>');
    expect(prompt).toContain('src/auth.ts:4-6');
    expect(prompt).toContain('<selected_lines>');
    expect(prompt).toContain('return user.id;');
    expect(prompt).toContain('</selected_lines>');
    expect(prompt).toContain('</selected_context>');
    expect(prompt).toContain('Is this safe?');
    expect(prompt).toContain('do not modify files');
    expect(prompt).toContain('Lead with the use-case');
    expect(prompt).toContain('Explain intended outcome and constraints');
    expect(prompt).toContain('what problem it solves, what must stay true');
    expect(prompt).toContain('Mention technical wiring only when');
    expect(prompt).toContain('Cite only the 1-3 most relevant files/lines');
    expect(prompt).toContain('Avoid vague phrases');
  });

  it('uses a safe markdown fence for selected code containing triple backticks', () => {
    const prompt = buildPrReviewChatPrompt({
      prTitle: 'Fix markdown',
      pullRequestId: 12,
      filePath: 'src/markdown.ts',
      lineStart: 4,
      selectedText: 'const fence = ```markdown```;',
      question: 'Can this break the prompt?',
    });

    expect(prompt).toContain('````\nconst fence = ```markdown```;\n````');
  });
});

describe('buildPrReviewFollowUpPrompt', () => {
  it('builds a concise read-only follow-up prompt', () => {
    const prompt = buildPrReviewFollowUpPrompt('Can you inspect tests too?');

    expect(prompt).toContain('Can you inspect tests too?');
    expect(prompt).toContain('same PR review context');
    expect(prompt).toContain('do not modify files');
    expect(prompt).toContain('Lead with the use-case');
    expect(prompt).toContain('Explain intended outcome and constraints');
    expect(prompt).toContain('max 5 bullets total');
  });
});

describe('createPrReviewChatStep', () => {
  it('creates an ask-mode anchored agent step and starts it', async () => {
    const createdStep = makeStep();
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      getPullRequest: vi.fn().mockResolvedValue({
        title: 'Fix auth',
        description: 'Tightens token validation and session handling.',
      }),
      getPrReviewAgentSetting: vi.fn().mockResolvedValue({
        backend: null,
        modelPreference: 'default',
        thinkingEffort: 'default',
      }),
      getBackendsSetting: vi.fn().mockResolvedValue({
        enabledBackends: ['claude-code'],
        defaultBackend: 'claude-code',
      }),
      createStep: vi.fn().mockResolvedValue(createdStep),
      startAgent: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      createPrReviewChatStep(
        {
          taskId: 'task-1',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          lineEnd: 6,
          side: 'old',
          selectedText: 'return user.id;',
          question: 'Is this safe?',
        },
        deps,
      ),
    ).resolves.toBe(createdStep);

    expect(deps.createStep).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        type: 'agent',
        interactionMode: 'ask',
        agentBackend: 'opencode',
        modelPreference: 'gpt-5.5',
        thinkingEffort: 'default',
        autoStart: false,
        meta: {
          kind: 'pr-review-chat',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          lineEnd: 6,
          side: 'old',
          selectedText: 'return user.id;',
        },
      }),
    );
    expect(deps.createStep.mock.calls[0][0].promptTemplate).toContain(
      'PR #12: Fix auth',
    );
    expect(deps.createStep.mock.calls[0][0].promptTemplate).toContain(
      'Tightens token validation and session handling.',
    );
    expect(deps.startAgent).toHaveBeenCalledWith('step-1');
  });

  it('falls back to the global default backend before claude-code', async () => {
    const createdStep = makeStep();
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      findProjectById: vi.fn().mockResolvedValue(
        makeProject({
          defaultAgentBackend: null,
        }),
      ),
      getPullRequest: vi.fn().mockResolvedValue({ title: 'Fix auth' }),
      getPrReviewAgentSetting: vi.fn().mockResolvedValue({
        backend: null,
        modelPreference: 'default',
        thinkingEffort: 'default',
      }),
      getBackendsSetting: vi.fn().mockResolvedValue({
        enabledBackends: ['claude-code', 'opencode'],
        defaultBackend: 'opencode',
      }),
      createStep: vi.fn().mockResolvedValue(createdStep),
      startAgent: vi.fn().mockResolvedValue(undefined),
    };

    await createPrReviewChatStep(
      {
        taskId: 'task-1',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
        question: 'Is this safe?',
      },
      deps,
    );

    expect(deps.createStep).toHaveBeenCalledWith(
      expect.objectContaining({
        agentBackend: 'opencode',
      }),
    );
  });

  it('rejects configured codex backend because PR review chat needs permissions', async () => {
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      findProjectById: vi.fn().mockResolvedValue(makeProject()),
      getPullRequest: vi.fn().mockResolvedValue({ title: 'Fix auth' }),
      getPrReviewAgentSetting: vi.fn().mockResolvedValue({
        backend: 'codex',
        modelPreference: 'default',
        thinkingEffort: 'default',
      }),
      getBackendsSetting: vi.fn().mockResolvedValue({
        enabledBackends: ['claude-code', 'codex'],
        defaultBackend: 'claude-code',
      }),
      createStep: vi.fn(),
      startAgent: vi.fn(),
    };

    await expect(
      createPrReviewChatStep(
        {
          taskId: 'task-1',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          selectedText: 'return user.id;',
          question: 'Is this safe?',
        },
        deps,
      ),
    ).rejects.toThrow('requires backend permission support');

    expect(getAgentBackendProviderMock).toHaveBeenCalledWith('codex');
    expect(deps.createStep).not.toHaveBeenCalled();
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it('rejects codex inherited from global default backend', async () => {
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      findProjectById: vi.fn().mockResolvedValue(
        makeProject({
          defaultAgentBackend: null,
        }),
      ),
      getPullRequest: vi.fn().mockResolvedValue({ title: 'Fix auth' }),
      getPrReviewAgentSetting: vi.fn().mockResolvedValue({
        backend: null,
        modelPreference: 'default',
        thinkingEffort: 'default',
      }),
      getBackendsSetting: vi.fn().mockResolvedValue({
        enabledBackends: ['codex'],
        defaultBackend: 'codex',
      }),
      createStep: vi.fn(),
      startAgent: vi.fn(),
    };

    await expect(
      createPrReviewChatStep(
        {
          taskId: 'task-1',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          selectedText: 'return user.id;',
          question: 'Is this safe?',
        },
        deps,
      ),
    ).rejects.toThrow('requires backend permission support');

    expect(getAgentBackendProviderMock).toHaveBeenCalledWith('codex');
    expect(deps.createStep).not.toHaveBeenCalled();
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it('rejects non-pr-review tasks', async () => {
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(makeTask({ type: 'agent' })),
      findProjectById: vi.fn(),
      getPullRequest: vi.fn(),
      getPrReviewAgentSetting: vi.fn(),
      getBackendsSetting: vi.fn(),
      createStep: vi.fn(),
      startAgent: vi.fn(),
    };

    await expect(
      createPrReviewChatStep(
        {
          taskId: 'task-1',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          selectedText: 'return user.id;',
          question: 'Is this safe?',
        },
        deps,
      ),
    ).rejects.toThrow('pr-review tasks');
    expect(deps.createStep).not.toHaveBeenCalled();
    expect(deps.startAgent).not.toHaveBeenCalled();
  });

  it('rejects PR IDs that do not match the review task', async () => {
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(makeTask({ pullRequestId: '99' })),
      findProjectById: vi.fn(),
      getPullRequest: vi.fn(),
      getPrReviewAgentSetting: vi.fn(),
      getBackendsSetting: vi.fn(),
      createStep: vi.fn(),
      startAgent: vi.fn(),
    };

    await expect(
      createPrReviewChatStep(
        {
          taskId: 'task-1',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          selectedText: 'return user.id;',
          question: 'Is this safe?',
        },
        deps,
      ),
    ).rejects.toThrow('pull request does not match');
    expect(deps.getPullRequest).not.toHaveBeenCalled();
    expect(deps.createStep).not.toHaveBeenCalled();
  });

  it('rejects pr-review tasks whose worktree was cleaned up', async () => {
    const deps = {
      findTaskById: vi.fn().mockResolvedValue(makeTask({ worktreePath: null })),
      findProjectById: vi.fn(),
      getPullRequest: vi.fn(),
      getPrReviewAgentSetting: vi.fn(),
      getBackendsSetting: vi.fn(),
      createStep: vi.fn(),
      startAgent: vi.fn(),
    };

    await expect(
      createPrReviewChatStep(
        {
          taskId: 'task-1',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          selectedText: 'return user.id;',
          question: 'Is this safe?',
        },
        deps,
      ),
    ).rejects.toThrow('PR review worktree is unavailable');
    expect(deps.createStep).not.toHaveBeenCalled();
    expect(deps.startAgent).not.toHaveBeenCalled();
  });
});

describe('continuePrReviewChatStep', () => {
  it('marks the existing PR review chat step running and continues same step', async () => {
    const existingStep = makeStep({ status: 'completed', sessionId: 'session-1' });
    const runningStep = makeStep({ status: 'running', sessionId: 'session-1' });
    const deps = {
      findStepById: vi.fn().mockResolvedValue(existingStep),
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      markStepRunning: vi.fn().mockResolvedValue(runningStep),
      continueAgent: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      continuePrReviewChatStep(
        { stepId: 'step-1', question: 'Can you inspect tests too?' },
        deps,
      ),
    ).resolves.toBe(runningStep);

    expect(deps.markStepRunning).toHaveBeenCalledWith('step-1');
    expect(deps.continueAgent).toHaveBeenCalledWith(
      'step-1',
      expect.stringContaining('Can you inspect tests too?'),
    );
  });

  it('rejects immediate continueAgent failures after marking step failed', async () => {
    const existingStep = makeStep({ status: 'completed', sessionId: 'session-1' });
    const runningStep = makeStep({ status: 'running', sessionId: 'session-1' });
    const error = new Error('send failed');
    const deps = {
      findStepById: vi.fn().mockResolvedValue(existingStep),
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      markStepRunning: vi.fn().mockResolvedValue(runningStep),
      continueAgent: vi.fn().mockRejectedValue(error),
      onContinueError: vi.fn(),
    };

    await expect(
      continuePrReviewChatStep(
        { stepId: 'step-1', question: 'Can you inspect tests too?' },
        deps,
      ),
    ).rejects.toThrow('send failed');

    expect(deps.markStepRunning).toHaveBeenCalledWith('step-1');
    expect(deps.onContinueError).toHaveBeenCalledWith(runningStep, error);
  });

  it('rejects non-PR-review-chat steps', async () => {
    const deps = {
      findStepById: vi.fn().mockResolvedValue(makeStep({ meta: {} })),
      findTaskById: vi.fn(),
      markStepRunning: vi.fn(),
      continueAgent: vi.fn(),
    };

    await expect(
      continuePrReviewChatStep(
        { stepId: 'step-1', question: 'Can you inspect tests too?' },
        deps,
      ),
    ).rejects.toThrow('not a PR review chat step');
    expect(deps.markStepRunning).not.toHaveBeenCalled();
    expect(deps.continueAgent).not.toHaveBeenCalled();
  });

  it('rejects running PR review chat steps', async () => {
    const deps = {
      findStepById: vi
        .fn()
        .mockResolvedValue(makeStep({ status: 'running', sessionId: 'session-1' })),
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      markStepRunning: vi.fn(),
      continueAgent: vi.fn(),
    };

    await expect(
      continuePrReviewChatStep(
        { stepId: 'step-1', question: 'Can you inspect tests too?' },
        deps,
      ),
    ).rejects.toThrow('already running');
    expect(deps.markStepRunning).not.toHaveBeenCalled();
    expect(deps.continueAgent).not.toHaveBeenCalled();
  });

  it('rejects PR review chat steps without a session to continue', async () => {
    const deps = {
      findStepById: vi.fn().mockResolvedValue(makeStep({ sessionId: null })),
      findTaskById: vi.fn().mockResolvedValue(makeTask()),
      markStepRunning: vi.fn(),
      continueAgent: vi.fn(),
    };

    await expect(
      continuePrReviewChatStep(
        { stepId: 'step-1', question: 'Can you inspect tests too?' },
        deps,
      ),
    ).rejects.toThrow('no session to continue');
    expect(deps.markStepRunning).not.toHaveBeenCalled();
    expect(deps.continueAgent).not.toHaveBeenCalled();
  });

  it('rejects PR review chat metadata on non-pr-review tasks', async () => {
    const deps = {
      findStepById: vi.fn().mockResolvedValue(makeStep({ sessionId: 'session-1' })),
      findTaskById: vi.fn().mockResolvedValue(makeTask({ type: 'agent' })),
      markStepRunning: vi.fn(),
      continueAgent: vi.fn(),
    };

    await expect(
      continuePrReviewChatStep(
        { stepId: 'step-1', question: 'Can you inspect tests too?' },
        deps,
      ),
    ).rejects.toThrow('pr-review tasks');
    expect(deps.markStepRunning).not.toHaveBeenCalled();
    expect(deps.continueAgent).not.toHaveBeenCalled();
  });

  it('rejects PR review chat follow-ups after worktree cleanup', async () => {
    const deps = {
      findStepById: vi.fn().mockResolvedValue(makeStep({ sessionId: 'session-1' })),
      findTaskById: vi.fn().mockResolvedValue(makeTask({ worktreePath: null })),
      markStepRunning: vi.fn(),
      continueAgent: vi.fn(),
    };

    await expect(
      continuePrReviewChatStep(
        { stepId: 'step-1', question: 'Can you inspect tests too?' },
        deps,
      ),
    ).rejects.toThrow('PR review worktree is unavailable');
    expect(deps.markStepRunning).not.toHaveBeenCalled();
    expect(deps.continueAgent).not.toHaveBeenCalled();
  });
});
