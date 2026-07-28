import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findMessagesByStepIdMock,
  findProjectByIdMock,
  getSettingMock,
  findStepByIdMock,
  findStepsByTaskIdMock,
  updateStepMock,
  prepareSummaryGenerationPromptMock,
  findTaskByIdMock,
  updateTaskMock,
  runProvisionalTransitionMock,
  stopTaskRuntimeMock,
  resetTaskRuntimeMock,
  summarizeNormalizedMessagesMock,
  archiveAndDeleteRawMessagesMock,
} = vi.hoisted(() => ({
  findMessagesByStepIdMock: vi.fn(),
  findProjectByIdMock: vi.fn(),
  getSettingMock: vi.fn(),
  findStepByIdMock: vi.fn(),
  findStepsByTaskIdMock: vi.fn(),
  updateStepMock: vi.fn(),
  prepareSummaryGenerationPromptMock: vi.fn(),
  findTaskByIdMock: vi.fn(),
  updateTaskMock: vi.fn(),
  runProvisionalTransitionMock: vi.fn(),
  stopTaskRuntimeMock: vi.fn(),
  resetTaskRuntimeMock: vi.fn(),
  summarizeNormalizedMessagesMock: vi.fn(),
  archiveAndDeleteRawMessagesMock: vi.fn(),
}));

vi.mock('../database/repositories/agent-messages', () => ({
  AgentMessageRepository: {
    findByStepId: findMessagesByStepIdMock,
  },
}));

vi.mock('../database/repositories/projects', () => ({
  ProjectRepository: {
    findById: findProjectByIdMock,
  },
}));

vi.mock('../database/repositories/settings', () => ({
  SettingsRepository: {
    get: getSettingMock,
  },
}));

vi.mock('../database/repositories/task-steps', () => ({
  TaskStepRepository: {
    findById: findStepByIdMock,
    findByTaskId: findStepsByTaskIdMock,
    update: updateStepMock,
    archiveAndDeleteRawMessages: archiveAndDeleteRawMessagesMock,
  },
}));

vi.mock('../database/repositories/tasks', () => ({
  TaskRepository: {
    findById: findTaskByIdMock,
    update: updateTaskMock,
  },
}));

vi.mock('./task-runtime-cleanup-service', () => ({
  taskRuntimeCleanupService: {
    runProvisionalTransition: runProvisionalTransitionMock,
    stopByTask: stopTaskRuntimeMock,
    resetAfterReactivation: resetTaskRuntimeMock,
  },
}));

vi.mock('./session-summary-service', () => {
  return {
    prepareSummaryGenerationPrompt: prepareSummaryGenerationPromptMock,
    summarizeNormalizedMessages: summarizeNormalizedMessagesMock,
  };
});

import { StepService } from './step-service';

describe('StepService.resolveAndValidate', () => {
  const previousStep = {
    id: 'step-1',
    taskId: 'task-1',
    name: 'Step 1',
    status: 'completed',
    output: 'Implemented login flow. Added tests. Fixed lint.',
    dependsOn: [],
    promptTemplate: 'original prompt',
    agentBackend: 'opencode',
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  };

  const continueStep = {
    id: 'step-2',
    taskId: 'task-1',
    name: 'Step 2',
    status: 'waiting',
    output: null,
    dependsOn: ['step-1'],
    promptTemplate: 'Continue from:\n{{summary(step.step-1)}}',
    agentBackend: 'opencode',
    createdAt: '2026-06-13T00:01:00.000Z',
    updatedAt: '2026-06-13T00:01:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    runProvisionalTransitionMock.mockImplementation(
      async (_taskId, transition, isTerminal) => {
        await stopTaskRuntimeMock(_taskId);
        try {
          const result = await transition();
          if (!isTerminal(result)) await resetTaskRuntimeMock(_taskId);
          return result;
        } catch (error) {
          await resetTaskRuntimeMock(_taskId);
          throw error;
        }
      },
    );
    prepareSummaryGenerationPromptMock.mockImplementation((messages) => {
      if (messages.length === 0) {
        throw new Error('Cannot summarize empty message history');
      }
      return { prompt: 'summary prompt' };
    });
    summarizeNormalizedMessagesMock.mockResolvedValue('Generated AI summary.');
    getSettingMock.mockResolvedValue({
      models: {
        'claude-code': 'default',
        opencode: 'default',
        codex: 'default',
      },
    });
    findStepByIdMock.mockResolvedValue(continueStep);
    findTaskByIdMock.mockResolvedValue({
      id: 'task-1',
      projectId: 'project-1',
      prompt: 'Build login',
      name: 'Login task',
    });
    findProjectByIdMock.mockResolvedValue({
      id: 'project-1',
      defaultAgentBackend: 'opencode',
    });
    updateTaskMock.mockResolvedValue({ id: 'task-1' });
    findStepsByTaskIdMock.mockResolvedValue([previousStep, continueStep]);
  });

  it('blocks archiving a step used by a dependent step', async () => {
    const beforePersist = vi.fn().mockResolvedValue(undefined);
    findStepByIdMock.mockResolvedValue(previousStep);
    findStepsByTaskIdMock.mockResolvedValue([
      previousStep,
      { ...continueStep, dependsOn: ['step-1'] },
    ]);

    await expect(
      StepService.archive('step-1', { beforePersist }),
    ).rejects.toThrow('depends on it');
    expect(beforePersist).not.toHaveBeenCalled();
    expect(archiveAndDeleteRawMessagesMock).not.toHaveBeenCalled();
  });

  it('stops, archives, and removes raw messages atomically', async () => {
    const beforePersist = vi.fn().mockResolvedValue(undefined);
    const archivedStep = { ...previousStep, archivedAt: '2026-07-18T00:00:00.000Z' };
    findStepByIdMock.mockResolvedValue(previousStep);
    findStepsByTaskIdMock.mockResolvedValue([previousStep]);
    archiveAndDeleteRawMessagesMock.mockResolvedValue({
      step: archivedStep,
      deletedRawMessageCount: 4,
    });

    const result = await StepService.archive('step-1', { beforePersist });

    expect(beforePersist).toHaveBeenCalledOnce();
    expect(archiveAndDeleteRawMessagesMock).toHaveBeenCalledWith(
      'step-1',
      expect.any(String),
    );
    expect(result.archivedAt).toBe(archivedStep.archivedAt);
  });

  it('falls back to captured output when continue summary generation fails', async () => {
    findMessagesByStepIdMock.mockResolvedValue([
      {
        id: 'msg-1',
        type: 'assistant-message',
        value: 'Implemented login flow.',
      },
    ]);
    summarizeNormalizedMessagesMock.mockRejectedValue(
      new Error('Failed to generate summary from normalized messages'),
    );

    const result = await StepService.resolveAndValidate('step-2');

    expect(result.resolvedPrompt).toBe(
      'Continue from:\nImplemented login flow. Added tests. Fixed lint.',
    );
    expect(result.warnings).toEqual([
      'Summary generation failed for step "Step 1" (step-1); used captured output fallback.',
    ]);
    expect(updateStepMock).toHaveBeenCalledWith('step-2', {
      resolvedPrompt:
        'Continue from:\nImplemented login flow. Added tests. Fixed lint.',
    });
  });

  it('falls back to captured output when messages are empty', async () => {
    findMessagesByStepIdMock.mockResolvedValue([]);

    const result = await StepService.resolveAndValidate('step-2');

    expect(result.resolvedPrompt).toBe(
      'Continue from:\nImplemented login flow. Added tests. Fixed lint.',
    );
    expect(result.warnings).toEqual([
      'Summary generation failed for step "Step 1" (step-1); used captured output fallback.',
    ]);
  });

  it('falls back to last assistant or result message when output is empty', async () => {
    findStepsByTaskIdMock.mockResolvedValue([
      { ...previousStep, output: null },
      continueStep,
    ]);
    findMessagesByStepIdMock.mockResolvedValue([
      {
        id: 'msg-1',
        type: 'assistant-message',
        value: 'Older assistant response.',
      },
      {
        id: 'msg-2',
        type: 'result',
        value: 'Final result summary.',
      },
    ]);
    summarizeNormalizedMessagesMock.mockRejectedValue(
      new Error('Failed to generate summary from normalized messages'),
    );

    const result = await StepService.resolveAndValidate('step-2');

    expect(result.resolvedPrompt).toBe('Continue from:\nFinal result summary.');
    expect(result.warnings).toEqual([
      'Summary generation failed for step "Step 1" (step-1); used last message fallback.',
    ]);
  });

  it('skips interrupted error result when falling back to last message', async () => {
    findStepsByTaskIdMock.mockResolvedValue([
      { ...previousStep, output: null },
      continueStep,
    ]);
    findMessagesByStepIdMock.mockResolvedValue([
      {
        id: 'msg-1',
        type: 'assistant-message',
        value: 'Implemented login flow before interruption.',
      },
      {
        id: 'msg-2',
        type: 'result',
        value: 'Task interrupted by user',
        isError: true,
      },
    ]);
    summarizeNormalizedMessagesMock.mockRejectedValue(
      new Error('Failed to generate summary from normalized messages'),
    );

    const result = await StepService.resolveAndValidate('step-2');

    expect(result.resolvedPrompt).toBe(
      'Continue from:\nImplemented login flow before interruption.',
    );
    expect(result.warnings).toEqual([
      'Summary generation failed for step "Step 1" (step-1); used last message fallback.',
    ]);
  });
});

describe('StepService.syncTaskStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runProvisionalTransitionMock.mockImplementation(
      async (taskId, transition, isTerminal) => {
        await stopTaskRuntimeMock(taskId);
        try {
          const result = await transition();
          if (!isTerminal(result)) await resetTaskRuntimeMock(taskId);
          return result;
        } catch (error) {
          await resetTaskRuntimeMock(taskId);
          throw error;
        }
      },
    );
  });

  it('keeps task runtime alive when the agent run completes', async () => {
    findStepsByTaskIdMock.mockResolvedValue([
      { id: 'step-1', taskId: 'task-1', status: 'completed' },
    ]);
    updateTaskMock.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      userCompleted: false,
    });
    resetTaskRuntimeMock.mockResolvedValue(undefined);

    await StepService.syncTaskStatus('task-1');

    expect(stopTaskRuntimeMock).not.toHaveBeenCalled();
    expect(runProvisionalTransitionMock).not.toHaveBeenCalled();
    expect(updateTaskMock).toHaveBeenCalledOnce();
    expect(resetTaskRuntimeMock).toHaveBeenCalledWith('task-1');
  });

  it('does not reset runtime for user-completed tasks', async () => {
    findStepsByTaskIdMock.mockResolvedValue([
      { id: 'step-1', taskId: 'task-1', status: 'completed' },
    ]);
    updateTaskMock.mockResolvedValue({
      id: 'task-1',
      status: 'completed',
      userCompleted: true,
    });

    await StepService.syncTaskStatus('task-1');

    expect(resetTaskRuntimeMock).not.toHaveBeenCalled();
    expect(stopTaskRuntimeMock).not.toHaveBeenCalled();
  });

  it('deliberately resets runtime tombstone when task becomes active again', async () => {
    findStepsByTaskIdMock.mockResolvedValue([
      { id: 'step-1', taskId: 'task-1', status: 'ready' },
    ]);
    updateTaskMock.mockResolvedValue({
      id: 'task-1',
      status: 'waiting',
      userCompleted: false,
    });
    resetTaskRuntimeMock.mockResolvedValue(undefined);

    await StepService.syncTaskStatus('task-1');

    expect(resetTaskRuntimeMock).toHaveBeenCalledWith('task-1');
    expect(updateTaskMock.mock.invocationCallOrder[0]).toBeLessThan(
      resetTaskRuntimeMock.mock.invocationCallOrder[0],
    );
  });

  it('propagates completion write failures without touching runtime', async () => {
    stopTaskRuntimeMock.mockClear();
    resetTaskRuntimeMock.mockClear();
    findStepsByTaskIdMock.mockResolvedValue([
      { id: 'step-1', taskId: 'task-1', status: 'completed' },
    ]);
    updateTaskMock.mockRejectedValue(new Error('write failed'));

    await expect(StepService.syncTaskStatus('task-1')).rejects.toThrow(
      'write failed',
    );

    expect(stopTaskRuntimeMock).not.toHaveBeenCalled();
    expect(resetTaskRuntimeMock).not.toHaveBeenCalled();
    expect(updateTaskMock).toHaveBeenCalledOnce();
  });
});
