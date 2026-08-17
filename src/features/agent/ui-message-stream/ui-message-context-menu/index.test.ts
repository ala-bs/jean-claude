import { describe, expect, it, vi } from 'vitest';

import type { NormalizedToolUse } from '@shared/normalized-message-v2';

import { copyToolInputItem, copyToolResultItem } from './index';

function bashTool(overrides: Partial<NormalizedToolUse> = {}): NormalizedToolUse {
  return {
    type: 'tool-use',
    toolId: 'tool-1',
    name: 'bash',
    input: { command: 'git status' },
    ...overrides,
  } as NormalizedToolUse;
}

describe('tool context-menu copy items', () => {
  it('copies bash input', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    copyToolInputItem(bashTool())?.onClick();

    expect(writeText).toHaveBeenCalledWith('git status');
  });

  it('copies bash result content', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    copyToolResultItem(
      bashTool({ result: { content: 'clean\n', isError: false } }),
    )?.onClick();

    expect(writeText).toHaveBeenCalledWith('clean');
  });

  it('omits copy result when tool has no result', () => {
    expect(copyToolResultItem(bashTool())).toBeNull();
  });

  it('copies skill input', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    copyToolInputItem({
      type: 'tool-use',
      toolId: 'skill-1',
      name: 'skill',
      skillName: 'review',
      input: {},
    })?.onClick();

    expect(writeText).toHaveBeenCalledWith('review');
  });

  it('copies subagent input', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    copyToolInputItem({
      type: 'tool-use',
      toolId: 'agent-1',
      name: 'sub-agent',
      input: { agentType: 'worker', description: 'Inspect code', prompt: 'Review this' },
    })?.onClick();

    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify(
        { agentType: 'worker', description: 'Inspect code', prompt: 'Review this' },
        null,
        2,
      ),
    );
  });
});
