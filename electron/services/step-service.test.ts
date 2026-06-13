import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findMessagesByStepIdMock,
  findProjectByIdMock,
  getSettingMock,
  findStepByIdMock,
  findStepsByTaskIdMock,
  updateStepMock,
  buildSummaryGenerationPromptMock,
  findTaskByIdMock,
  summarizeNormalizedMessagesMock,
} = vi.hoisted(() => ({
  findMessagesByStepIdMock: vi.fn(),
  findProjectByIdMock: vi.fn(),
  getSettingMock: vi.fn(),
  findStepByIdMock: vi.fn(),
  findStepsByTaskIdMock: vi.fn(),
  updateStepMock: vi.fn(),
  buildSummaryGenerationPromptMock: vi.fn(),
  findTaskByIdMock: vi.fn(),
  summarizeNormalizedMessagesMock: vi.fn(),
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
  },
}));

vi.mock('../database/repositories/tasks', () => ({
  TaskRepository: {
    findById: findTaskByIdMock,
  },
}));

vi.mock('./session-summary-service', () => {
  return {
    buildSummaryGenerationPrompt: buildSummaryGenerationPromptMock,
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
    buildSummaryGenerationPromptMock.mockImplementation((messages) => {
      if (messages.length === 0) {
        throw new Error('Cannot summarize empty message history');
      }
      return 'summary prompt';
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
    findStepsByTaskIdMock.mockResolvedValue([previousStep, continueStep]);
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
