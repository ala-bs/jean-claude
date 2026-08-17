import { describe, expect, it } from 'vitest';

import type {
  NewTask,
  NewTaskStep,
  Task,
  TaskStep,
  UpdateTask,
} from '@shared/types';

import {
  sanitizeRendererTaskCreate,
  validateRendererStepArchive,
  validateRendererStepCreate,
  validateRendererStepModeChange,
  validateRendererStepUpdate,
  validateRendererTaskUpdate,
} from './task-update-validation';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    type: 'pr-review',
    name: 'Review workspace',
    prompt: 'Review PR',
    status: 'waiting',
    worktreePath: '/repo/.worktrees/review',
    startCommitHash: 'abc',
    sourceBranch: 'main',
    branchName: 'review-12',
    prWorkspaceState: 'active',
    hasUnread: false,
    userCompleted: false,
    workItemIds: null,
    workItemUrls: null,
    pullRequestId: '12',
    pullRequestUrl: 'https://example.test/pr/12',
    pendingMessage: null,
    todoItems: [],
    parentTaskId: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function makeStep(overrides: Partial<TaskStep> = {}): TaskStep {
  return {
    id: 'step-1',
    taskId: 'task-1',
    name: 'Implement fix',
    type: 'agent',
    dependsOn: [],
    promptTemplate: 'Implement fix',
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
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

const newStep: NewTaskStep = {
  taskId: 'task-1',
  name: 'Implement fix',
  type: 'agent',
  promptTemplate: 'Implement fix',
};

describe('validateRendererTaskUpdate', () => {
  it.each([
    'projectId',
    'pullRequestId',
    'pullRequestUrl',
    'worktreePath',
    'startCommitHash',
    'sourceBranch',
    'branchName',
    'prWorkspaceState',
    'status',
    'userCompleted',
  ] as const)('rejects renderer mutation of PR review %s', (field) => {
    expect(() =>
      validateRendererTaskUpdate(makeTask(), {
        [field]: 'renderer-controlled',
      } as unknown as UpdateTask),
    ).toThrow(new RegExp(`${field}.*renderer`));
  });

  it.each([
    'projectId',
    'worktreePath',
    'startCommitHash',
    'sourceBranch',
    'branchName',
    'prWorkspaceState',
  ] as const)('rejects renderer mutation of normal task %s', (field) => {
    expect(() =>
      validateRendererTaskUpdate(makeTask({ type: 'agent' }), {
        [field]: 'renderer-controlled',
      } as unknown as UpdateTask),
    ).toThrow(`Cannot update backend-owned task ${field} from renderer`);
  });

  it.each(['pr-review', 'agent'] as const)(
    'rejects valid and invalid pending timestamps for %s tasks',
    (type) => {
      for (const prWorkspacePendingAt of [
        '2026-07-14T00:00:00.000Z',
        'attacker-controlled',
      ]) {
        expect(() =>
          validateRendererTaskUpdate(makeTask({ type }), {
            prWorkspacePendingAt,
          } as unknown as UpdateTask),
        ).toThrow(
          'Cannot update backend-owned task prWorkspacePendingAt from renderer',
        );
      }
    },
  );

  it('allows non-lifecycle updates for PR review tasks', () => {
    expect(() =>
      validateRendererTaskUpdate(makeTask(), {
        name: 'Renamed workspace',
        prompt: 'Updated prompt',
      }),
    ).not.toThrow();
  });
});

describe('sanitizeRendererTaskCreate', () => {
  it('removes caller-controlled cleanup identity during task creation', () => {
    expect(
      sanitizeRendererTaskCreate({
        projectId: 'project-1',
        prompt: 'Task',
        updatedAt: '2026-07-14T00:00:00.000Z',
        worktreePath: '/other/task',
        branchName: 'other-task',
        startCommitHash: 'attacker',
      }),
    ).toEqual({
      projectId: 'project-1',
      prompt: 'Task',
      updatedAt: '2026-07-14T00:00:00.000Z',
    });
  });

  it.each(['tasks:create', 'tasks:createWithWorktree'])(
    'strips valid and invalid PR workspace state for %s',
    () => {
      for (const prWorkspaceState of ['active', 'invalid-state']) {
        const result = sanitizeRendererTaskCreate({
          projectId: 'project-1',
          prompt: 'Task',
          updatedAt: '2026-07-14T00:00:00.000Z',
          prWorkspaceState,
        } as NewTask);

        expect(result).not.toHaveProperty('prWorkspaceState');
      }
    },
  );

  it.each(['tasks:create', 'tasks:createWithWorktree'])(
    'strips valid and invalid pending detection timestamps for %s',
    () => {
      for (const prWorkspacePendingAt of [
        '2026-07-14T00:00:00.000Z',
        'attacker-controlled',
      ]) {
        const result = sanitizeRendererTaskCreate({
          projectId: 'project-1',
          prompt: 'Task',
          updatedAt: '2026-07-14T00:00:00.000Z',
          prWorkspacePendingAt,
        } as NewTask);

        expect(result).not.toHaveProperty('prWorkspacePendingAt');
      }
    },
  );

  it.each(['tasks:create', 'tasks:createWithWorktree'])(
    'rejects generic PR review task creation through %s',
    () => {
      expect(() =>
        sanitizeRendererTaskCreate({
          projectId: 'project-1',
          type: 'pr-review',
          prompt: 'Forged PR workspace',
          updatedAt: '2026-07-14T00:00:00.000Z',
        }),
      ).toThrow('PR review tasks must be created through the PR Workspace API');
    },
  );

  it.each(['tasks:create', 'tasks:createWithWorktree'])(
    'leaves normal task creation unaffected for %s',
    () => {
      expect(
        sanitizeRendererTaskCreate({
          projectId: 'project-1',
          type: 'agent',
          name: 'Normal task',
          prompt: 'Task',
          updatedAt: '2026-07-14T00:00:00.000Z',
        }),
      ).toEqual({
        projectId: 'project-1',
        type: 'agent',
        name: 'Normal task',
        prompt: 'Task',
        updatedAt: '2026-07-14T00:00:00.000Z',
      });
    },
  );
});

describe('renderer generic step validation', () => {
  it('allows generic agent steps to be created and updated in PR workspaces', () => {
    expect(() => validateRendererStepCreate(makeTask(), newStep)).not.toThrow();
    expect(() =>
      validateRendererStepUpdate(makeStep(), {
        promptTemplate: 'Updated prompt',
      }),
    ).not.toThrow();
  });

  it.each<NonNullable<NewTaskStep['sessionRules']>>([
    { write: 'allow' } as const,
    { bash: 'allow' } as const,
  ])('rejects renderer-supplied session rules on generic create', (sessionRules) => {
    expect(() =>
      validateRendererStepCreate(makeTask(), { ...newStep, sessionRules }),
    ).toThrow('session rules cannot be set');
  });

  it.each<NonNullable<NewTaskStep['sessionRules']>>([
    { write: 'allow' } as const,
    { bash: 'allow' } as const,
  ])('rejects renderer-supplied session rules on generic update', (sessionRules) => {
    expect(() =>
      validateRendererStepUpdate(makeStep(), { sessionRules }),
    ).toThrow('session rules cannot be updated');
  });

  it('rejects forged PR review chat metadata on generic create', () => {
    expect(() =>
      validateRendererStepCreate(makeTask(), {
        ...newStep,
        meta: {
          kind: 'pr-review-chat',
          pullRequestId: 12,
          filePath: 'src/auth.ts',
          lineStart: 4,
          selectedText: 'return user.id;',
        },
      }),
    ).toThrow('PR review chat');

    expect(() =>
      validateRendererStepCreate(makeTask({ type: 'agent' }), {
        ...newStep,
        meta: { kind: 'pr-review-chat' } as NewTaskStep['meta'],
      }),
    ).toThrow('PR review chat');
  });

  it('rejects forging chat metadata on generic update', () => {
    expect(() =>
      validateRendererStepUpdate(makeStep(), {
        meta: { kind: 'pr-review-chat' } as TaskStep['meta'],
      }),
    ).toThrow('PR review chat');
  });

  it('keeps genuine PR review chat steps immutable through generic update', () => {
    expect(() =>
      validateRendererStepUpdate(
        makeStep({
          meta: {
            kind: 'pr-review-chat',
            pullRequestId: 12,
            filePath: 'src/auth.ts',
            lineStart: 4,
            selectedText: 'return user.id;',
          },
        }),
        { name: 'Forged rename' },
      ),
    ).toThrow('cannot be updated');
  });

  it('rejects direct mode changes for PR review chat steps', () => {
    const chatStep = makeStep({
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    expect(() => validateRendererStepModeChange(chatStep)).toThrow('read-only');
    expect(() => validateRendererStepModeChange(makeStep())).not.toThrow();
  });

  it('rejects archiving PR review chat steps through the generic API', () => {
    const chatStep = makeStep({
      meta: {
        kind: 'pr-review-chat',
        pullRequestId: 12,
        filePath: 'src/auth.ts',
        lineStart: 4,
        selectedText: 'return user.id;',
      },
    });

    expect(() => validateRendererStepArchive(chatStep)).toThrow(
      'cannot be archived',
    );
    expect(() => validateRendererStepArchive(makeStep())).not.toThrow();
  });
});
