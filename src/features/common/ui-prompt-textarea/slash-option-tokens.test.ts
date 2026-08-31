import { describe, expect, it } from 'vitest';

import { getSlashOptionTokens, isSlashPasteSuppressed } from './index';
import type { PromptSnippet } from '@shared/types';
import type { Skill } from '@shared/skill-types';

const snippet = {
  id: 's1',
  name: 'Review',
  enabled: true,
  autocomplete: { enabled: true, slugs: ['review', ' '] },
} as unknown as PromptSnippet;

const skill = { name: 'git-commit' } as unknown as Skill;

describe('getSlashOptionTokens', () => {
  it('collects commands, snippet slugs and skills', () => {
    const tokens = getSlashOptionTokens({
      showCommands: true,
      promptSnippets: [snippet],
      skills: [skill],
    });
    expect(tokens.has('init')).toBe(true);
    expect(tokens.has('compact')).toBe(true);
    expect(tokens.has('review')).toBe(true);
    expect(tokens.has('git-commit')).toBe(true);
    expect(tokens.has('')).toBe(false);
    expect(tokens.has('nope')).toBe(false);
  });

  it('includes the snippet name, which the dropdown also searches', () => {
    const tokens = getSlashOptionTokens({
      showCommands: false,
      promptSnippets: [snippet],
      skills: [],
    });
    expect(tokens.has('review')).toBe(true);
  });

  it('skips snippets with no usable slug', () => {
    const tokens = getSlashOptionTokens({
      showCommands: false,
      promptSnippets: [
        {
          ...snippet,
          autocomplete: { enabled: true, slugs: ['  '] },
        } as unknown as PromptSnippet,
      ],
      skills: [],
    });
    expect(tokens.size).toBe(0);
  });

  it('omits commands when disabled and ignores disabled snippets', () => {
    const tokens = getSlashOptionTokens({
      showCommands: false,
      promptSnippets: [{ ...snippet, enabled: false }],
      skills: [],
    });
    expect(tokens.size).toBe(0);
  });
});

describe('isSlashPasteSuppressed', () => {
  const snapshot = { value: '/init', cursorPosition: 5 };

  it('suppresses only the exact pasted text and caret', () => {
    expect(
      isSlashPasteSuppressed({ snapshot, value: '/init', cursorPosition: 5 }),
    ).toBe(true);
  });

  it('releases when the text changes (including select-all replace)', () => {
    expect(
      isSlashPasteSuppressed({ snapshot, value: '/ini', cursorPosition: 4 }),
    ).toBe(false);
    expect(
      isSlashPasteSuppressed({ snapshot, value: '/initx', cursorPosition: 6 }),
    ).toBe(false);
  });

  it('releases when only the caret moves', () => {
    expect(
      isSlashPasteSuppressed({ snapshot, value: '/init', cursorPosition: 3 }),
    ).toBe(false);
  });

  it('never suppresses without a snapshot', () => {
    expect(
      isSlashPasteSuppressed({
        snapshot: null,
        value: '/init',
        cursorPosition: 5,
      }),
    ).toBe(false);
  });
});
