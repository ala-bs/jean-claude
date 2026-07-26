import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  captureInitialTaskPromptSafeMock,
  capturePromptSubmissionSafeMock,
  debugAgentMock,
  findLatestResultMock,
  findStepOutputMock,
  findStepTaskIdMock,
} = vi.hoisted(() => ({
  captureInitialTaskPromptSafeMock: vi.fn(),
  capturePromptSubmissionSafeMock: vi.fn(),
  debugAgentMock: vi.fn(),
  findLatestResultMock: vi.fn(),
  findStepOutputMock: vi.fn(),
  findStepTaskIdMock: vi.fn(),
}));

vi.mock('../database/repositories', () => ({
  AgentMessageRepository: {
    findLatestResultByStepId: findLatestResultMock,
  },
}));

vi.mock('../database/repositories/task-steps', () => ({
  TaskStepRepository: {
    findOutputByIdAndTaskId: findStepOutputMock,
    findTaskIdById: findStepTaskIdMock,
  },
}));

vi.mock('../lib/debug', () => ({ dbg: { agent: debugAgentMock } }));

vi.mock('../services/agent-memory-capture-service', () => ({
  captureAgentMemoryPromptSubmissionSafe: capturePromptSubmissionSafeMock,
  captureInitialTaskPromptSafe: captureInitialTaskPromptSafeMock,
}));

import {
  captureCreatedStepPromptBoundary,
  captureCreatedTaskPromptBoundary,
} from './agent-memory-capture-boundaries';

describe('task creation Agent Memory boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captureInitialTaskPromptSafeMock.mockResolvedValue(undefined);
    capturePromptSubmissionSafeMock.mockResolvedValue(undefined);
    findLatestResultMock.mockResolvedValue(null);
    findStepOutputMock.mockResolvedValue(undefined);
    findStepTaskIdMock.mockResolvedValue('task-1');
  });

  it.each(['tasks:create', 'tasks:createWithWorktree'])(
    'captures explicit original text after %s has task and step ids',
    (path) => {
      captureCreatedTaskPromptBoundary({
        task: { id: `${path}-task`, projectId: 'project-1', type: 'agent' },
        stepId: `${path}-step`,
        originalUserText: 'Raw user prompt',
        submittedPrompt: 'Raw user prompt\n\nGenerated context',
        createdAt: '2026-07-18T00:00:00.000Z',
      });

      expect(captureInitialTaskPromptSafeMock).toHaveBeenCalledWith({
        projectId: 'project-1',
        taskId: `${path}-task`,
        stepId: `${path}-step`,
        userText: 'Raw user prompt',
        reviews: [],
        createdAt: '2026-07-18T00:00:00.000Z',
      });
    },
  );

  it('skips synthesized task prompts when explicit original text is absent', () => {
    captureCreatedTaskPromptBoundary({
      task: { id: 'task-1', projectId: 'project-1', type: 'agent' },
      stepId: 'step-1',
      originalUserText: undefined,
      submittedPrompt: 'Synthesized task prompt',
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    expect(captureInitialTaskPromptSafeMock).not.toHaveBeenCalled();
  });

  it('derives initial composer comments from submitted prompt XML', () => {
    captureCreatedTaskPromptBoundary({
      task: { id: 'task-1', projectId: 'project-1', type: 'agent' },
      stepId: 'step-1',
      originalUserText: 'Implement feature',
      submittedPrompt: `Implement feature

<user_review>
<comment index="1" comment_id="cfc-stable" type="file" file_path="src/app.ts" line_range="L8">
  <selected_lines>if (ready) return;</selected_lines>
  <instruction>Keep this branch</instruction>
</comment>
</user_review>`,
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    expect(captureInitialTaskPromptSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reviews: [{
          commentId: 'cfc-stable',
          body: 'Keep this branch',
          selectedText: 'if (ready) return;',
          filePath: 'src/app.ts',
          lineStart: 8,
          lineEnd: 8,
          presets: [],
        }],
      }),
    );
  });

  it('rejects initial prompt metadata absent from submitted prompt', () => {
    captureCreatedTaskPromptBoundary({
      task: { id: 'task-1', projectId: 'project-1', type: 'agent' },
      stepId: 'step-1',
      originalUserText: 'Private abandoned draft',
      submittedPrompt: 'Submitted task text',
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    expect(captureInitialTaskPromptSafeMock).not.toHaveBeenCalled();
  });

  it('captures a new-step submission after creation with latest prior result', async () => {
    findLatestResultMock.mockResolvedValue('prior result');

    captureCreatedStepPromptBoundary({
      task: { id: 'task-1', projectId: 'project-1', type: 'agent' },
      stepId: 'step-new',
      capture: {
        userText: 'New step request',
        contextStepId: 'step-old',
        reviews: [],
      },
      submittedPrompt: 'New step request',
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    await vi.waitFor(() => {
      expect(capturePromptSubmissionSafeMock).toHaveBeenCalledWith({
        source: 'new-step-prompt',
        sourceId: 'step:step-new:prompt',
        projectId: 'project-1',
        taskId: 'task-1',
        stepId: 'step-new',
        userText: 'New step request',
        previousAgentResult: 'prior result',
        reviews: [],
        createdAt: '2026-07-18T00:00:00.000Z',
      });
    });
  });

  it('falls back to prior step output for new-step context', async () => {
    findStepOutputMock.mockResolvedValue('prior step output');

    captureCreatedStepPromptBoundary({
      task: { id: 'task-1', projectId: 'project-1', type: 'agent' },
      stepId: 'step-new',
      capture: { userText: 'Continue', contextStepId: 'step-old' },
      submittedPrompt: 'Continue',
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    await vi.waitFor(() => {
      expect(capturePromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({ previousAgentResult: 'prior step output' }),
      );
    });
  });

  it('never reads context from a step owned by another task', async () => {
    findStepTaskIdMock.mockResolvedValue('task-other');

    captureCreatedStepPromptBoundary({
      task: { id: 'task-1', projectId: 'project-1', type: 'agent' },
      stepId: 'step-new',
      capture: { userText: 'Continue', contextStepId: 'step-other' },
      submittedPrompt: 'Continue',
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    await vi.waitFor(() => {
      expect(capturePromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({ previousAgentResult: null }),
      );
    });
    expect(findLatestResultMock).not.toHaveBeenCalled();
    expect(findStepOutputMock).not.toHaveBeenCalled();
  });

  it('rejects new-step review metadata absent from submitted XML', async () => {
    captureCreatedStepPromptBoundary({
      task: { id: 'task-1', projectId: 'project-1', type: 'agent' },
      stepId: 'step-new',
      capture: {
        userText: 'Continue',
        reviews: [
          {
            commentId: 'Bearer new-step-id-secret',
            body: 'new-step body secret',
            selectedText: 'new-step selected secret',
            filePath: 'src/forged.ts',
            lineStart: 1,
            lineEnd: 1,
            presets: [],
          },
        ],
      },
      submittedPrompt: 'Continue without review XML',
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    await vi.waitFor(() => {
      expect(capturePromptSubmissionSafeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userText: 'Continue without review XML',
          reviews: [],
        }),
      );
    });
    const logs = JSON.stringify(debugAgentMock.mock.calls);
    expect(logs).toContain('agent-memory-prompt-admission-mismatch');
    expect(logs).not.toContain('new-step-id-secret');
    expect(logs).not.toContain('new-step body secret');
    expect(logs).not.toContain('new-step selected secret');
  });

  it('excludes specialized automation tasks from both boundaries', () => {
    const task = {
      id: 'task-system',
      projectId: 'project-1',
      type: 'feature-map' as const,
    };
    captureCreatedTaskPromptBoundary({
      task,
      stepId: 'step-system',
      originalUserText: 'Generated automation',
      submittedPrompt: 'Generated automation',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    captureCreatedStepPromptBoundary({
      task,
      stepId: 'step-system',
      capture: { userText: 'Generated automation' },
      submittedPrompt: 'Generated automation',
      createdAt: '2026-07-18T00:00:00.000Z',
    });

    expect(captureInitialTaskPromptSafeMock).not.toHaveBeenCalled();
    expect(capturePromptSubmissionSafeMock).not.toHaveBeenCalled();
  });
});
