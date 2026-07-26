import { describe, expect, it } from 'vitest';

import {
  buildTaskCreationRetryInput,
  getOriginalTaskAgentMemoryPrompt,
} from './agent-memory-prompt-input';

describe('getOriginalTaskAgentMemoryPrompt', () => {
  it('keeps raw prompt-mode input before feature, file comment, and attachment expansion', () => {
    expect(
      getOriginalTaskAgentMemoryPrompt({
        inputMode: 'prompt',
        prompt: 'User request {feature:auth}',
        workItemTemplate: 'generated work item template',
      }),
    ).toBe('User request {feature:auth}');
  });

  it('keeps raw work-item template before work-item and comment expansion', () => {
    expect(
      getOriginalTaskAgentMemoryPrompt({
        inputMode: 'work-item',
        prompt: 'unused prompt',
        workItemTemplate: 'Implement {{workItems.0.title}}',
      }),
    ).toBe('Implement {{workItems.0.title}}');
  });

  it('omits capture when no explicit original text exists', () => {
    expect(
      getOriginalTaskAgentMemoryPrompt({
        inputMode: 'prompt',
        prompt: '   ',
        workItemTemplate: '',
      }),
    ).toBeUndefined();
  });
});

describe('buildTaskCreationRetryInput', () => {
  it('preserves dedicated memory text through background-job retries', () => {
    const creationInput = {
      projectId: 'project-1',
      prompt: 'Expanded work item and file context',
      agentMemoryPrompt: 'Implement {{workItems.0.title}}',
      useWorktree: true,
      updatedAt: '2026-07-18T00:00:00.000Z',
    };

    expect(
      buildTaskCreationRetryInput(
        creationInput,
        '2026-07-19T00:00:00.000Z',
      ),
    ).toEqual({
      ...creationInput,
      updatedAt: '2026-07-19T00:00:00.000Z',
    });
  });
});
