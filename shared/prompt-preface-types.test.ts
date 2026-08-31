import { describe, expect, it } from 'vitest';

import {
  applyPromptPrefaceToParts,
  isProjectPromptPrefaceSetting,
  mergePromptPreface,
  normalizeProjectPromptPrefaceSetting,
  normalizePromptPrefaceSetting,
  type PromptPrefaceEntry,
} from './prompt-preface-types';

function prefaceEntry(id: string, text: string): PromptPrefaceEntry {
  return {
    id,
    name: id,
    enabled: true,
    text,
    placement: 'before',
    frequency: 'each',
  };
}

describe('mergePromptPreface', () => {
  const global = [prefaceEntry('g1', 'Global one'), prefaceEntry('g2', 'Two')];
  const project = [prefaceEntry('p1', 'Project one')];

  it('uses global entries when the project inherits', () => {
    expect(
      mergePromptPreface({
        global,
        project: { mode: 'inherit', entries: project },
      }),
    ).toEqual(global);
  });

  it('appends project entries after global ones when extending', () => {
    expect(
      mergePromptPreface({
        global,
        project: { mode: 'extend', entries: project },
      }),
    ).toEqual([...global, ...project]);
  });

  it('keeps only global entries when extending with no project entries', () => {
    expect(
      mergePromptPreface({ global, project: { mode: 'extend', entries: [] } }),
    ).toEqual(global);
  });

  it('drops global entries when the project overrides', () => {
    expect(
      mergePromptPreface({
        global,
        project: { mode: 'override', entries: project },
      }),
    ).toEqual(project);
  });

  it('yields an empty preface when overriding with no entries', () => {
    expect(
      mergePromptPreface({ global, project: { mode: 'override', entries: [] } }),
    ).toEqual([]);
  });
});

describe('prompt preface settings', () => {
  it('normalizes legacy global preface into a generic enabled entry', () => {
    expect(
      normalizePromptPrefaceSetting({
        text: 'Global rules',
        placement: 'before',
        frequency: 'initial',
      }),
    ).toEqual([
      {
        id: 'legacy-1',
        name: 'Preface 1',
        enabled: true,
        text: 'Global rules',
        placement: 'before',
        frequency: 'initial',
      },
    ]);
  });

  it('accepts a native extend setting', () => {
    expect(
      isProjectPromptPrefaceSetting({ mode: 'extend', entries: [] }),
    ).toBe(true);
  });

  it('normalizes legacy project extend to native extend mode', () => {
    expect(
      normalizeProjectPromptPrefaceSetting({
        value: {
          mode: 'extend',
          text: 'Project rules',
          placement: 'after',
          frequency: 'each',
        },
      }),
    ).toEqual({
      mode: 'extend',
      entries: [
        {
          id: 'legacy-2',
          name: 'Preface 2',
          enabled: true,
          text: 'Project rules',
          placement: 'after',
          frequency: 'each',
        },
      ],
    });
  });

  it('normalizes empty legacy project extend to inherit global behavior', () => {
    expect(
      normalizeProjectPromptPrefaceSetting({
        value: {
          mode: 'extend',
          text: '   ',
          placement: 'after',
          frequency: 'each',
        },
      }),
    ).toEqual({ mode: 'inherit', entries: [] });
  });

  it('applies enabled prefaces in order by placement and frequency', () => {
    expect(
      applyPromptPrefaceToParts({
        parts: [{ type: 'text', text: 'Prompt' }],
        isInitialPrompt: false,
        entries: [
          {
            id: '1',
            name: 'Before initial',
            enabled: true,
            text: 'Skipped',
            placement: 'before',
            frequency: 'initial',
          },
          {
            id: '2',
            name: 'Before each',
            enabled: true,
            text: 'Before',
            placement: 'before',
            frequency: 'each',
          },
          {
            id: '3',
            name: 'After each',
            enabled: true,
            text: 'After',
            placement: 'after',
            frequency: 'each',
          },
        ],
      }),
    ).toEqual([{ type: 'text', text: 'Before\n\nPrompt\n\nAfter' }]);
  });

  it('includes generic and matching backend model prefaces only', () => {
    const entries = [
      {
        id: 'generic',
        name: 'Generic',
        enabled: true,
        text: 'Generic',
        placement: 'before' as const,
        frequency: 'each' as const,
      },
      {
        id: 'match',
        name: 'Match',
        enabled: true,
        text: 'Match',
        placement: 'before' as const,
        frequency: 'each' as const,
        targets: [{ backend: 'opencode' as const, models: ['openai/gpt-5'] }],
      },
      {
        id: 'other',
        name: 'Other',
        enabled: true,
        text: 'Other',
        placement: 'before' as const,
        frequency: 'each' as const,
        targets: [{ backend: 'opencode' as const, models: ['*'] }],
      },
    ];

    expect(
      applyPromptPrefaceToParts({
        parts: [{ type: 'text', text: 'Prompt' }],
        entries,
        isInitialPrompt: false,
        backend: 'opencode',
        model: 'anthropic/claude-sonnet',
      }),
    ).toEqual([{ type: 'text', text: 'Generic\n\nOther\n\nPrompt' }]);
  });
});
