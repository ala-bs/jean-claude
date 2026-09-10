import { describe, expect, it } from 'vitest';

import { getTaskPromptPreview } from './task-prompt-preview';

describe('getTaskPromptPreview', () => {
  it('skips a leading pasted-image marker instead of titling the task with it', () => {
    expect(
      getTaskPromptPreview('![shot.png](jc-image://a3f9k2 =420x)\nfix the header'),
    ).toBe('fix the header');
  });

  it('never returns anything containing the placeholder scheme', () => {
    expect(
      getTaskPromptPreview('![a.png](jc-image://aaa) fix it'),
    ).not.toContain('jc-image');
  });

  it('is unchanged for ordinary prompts', () => {
    expect(getTaskPromptPreview('fix the header\nand the modal')).toBe(
      'fix the header',
    );
  });

  it('returns an empty string for an empty prompt', () => {
    expect(getTaskPromptPreview('')).toBe('');
  });

  it('returns an empty string when the prompt is only a marker', () => {
    expect(getTaskPromptPreview('![a.png](jc-image://aaa)')).toBe('');
  });
});
