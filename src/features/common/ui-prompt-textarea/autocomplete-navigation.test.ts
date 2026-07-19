// @vitest-environment happy-dom

import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import type { ProjectFeatureMap } from '@shared/types';

import { prepareProjectFeatureReferences } from '@/lib/prompt-feature-context';

import { PromptTextarea } from './index';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const inlineCompletionMock = vi.hoisted(() => ({
  initialCompletion: null as string | null,
}));

vi.mock('@/hooks/use-inline-completion', async () => {
  const { useState } = await import('react');
  return {
    useInlineCompletion: () => {
      const [completion, setCompletion] = useState(
        inlineCompletionMock.initialCompletion,
      );
      return {
        completion,
        completionPosition: completion ? 0 : null,
        isLoading: false,
        accept: () => {
          setCompletion(null);
          return completion;
        },
        dismiss: () => setCompletion(null),
      };
    },
  };
});

vi.mock('@/common/hooks/use-dropdown-position', () => ({
  useDropdownPosition: ({ isOpen }: { isOpen: boolean }) =>
    isOpen
      ? {
          top: 0,
          left: 0,
          width: 300,
          actualSide: 'bottom',
          actualAlign: 'left',
          maxHeight: 200,
          maxWidth: 300,
        }
      : null,
}));

vi.mock('@/hooks/use-project-file-paths', () => ({
  useProjectFilePaths: () => ({ filePaths: [], isLoading: false }),
  getFilePathSuggestions: () => [],
}));

const featureMap: ProjectFeatureMap = {
  generatedAt: '2026-07-18T00:00:00.000Z',
  features: Array.from({ length: 10 }, (_, index) => ({
    id: `feature-${index}`,
    name: `Feature ${index}`,
    summary: '',
    key_files: [],
    children: [],
  })),
};

function Harness() {
  const [value, setValue] = useState('');
  return createElement(PromptTextarea, {
    value,
    onChange: setValue,
    featureMap,
  });
}

const preparedFeatures = prepareProjectFeatureReferences(featureMap);

function PreparedFeaturesHarness() {
  const [value, setValue] = useState('');
  return createElement(PromptTextarea, {
    value,
    onChange: setValue,
    preparedFeatures,
  });
}

function SubmittingHarness() {
  const [value, setValue] = useState('Prompt to submit');
  return createElement(PromptTextarea, {
    value,
    onChange: setValue,
    onEnterKey: () => {
      setValue('');
      return true;
    },
  });
}

describe('PromptTextarea autocomplete navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    inlineCompletionMock.initialCompletion = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(
      () => undefined,
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('ignores hover caused by scrolling until pointer moves', async () => {
    await act(async () => root.render(createElement(Harness)));

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea not found');

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setValue?.call(textarea, '#');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    const getItem = (index: number) => {
      const item = document.querySelector<HTMLButtonElement>(
        `button[data-index="${index}"]`,
      );
      if (!item) throw new Error(`Autocomplete item ${index} not found`);
      return item;
    };

    await act(async () => {
      for (let index = 0; index < 6; index++) {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      }
    });

    expect(getItem(6).classList.contains('bg-glass-medium')).toBe(true);

    await act(async () => {
      getItem(3).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    expect(getItem(6).classList.contains('bg-glass-medium')).toBe(true);

    await act(async () => {
      getItem(3).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });

    expect(getItem(3).classList.contains('bg-glass-medium')).toBe(true);
  });

  it('measures textarea height once after an input change', async () => {
    await act(async () => root.render(createElement(Harness)));

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea not found');

    let scrollHeightReads = 0;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads++;
        return 40;
      },
    });

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setValue?.call(textarea, 'Updated prompt');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    expect(scrollHeightReads).toBe(1);
  });

  it('batches completion dismissal with input height measurement', async () => {
    inlineCompletionMock.initialCompletion = ' suggested text';
    await act(async () => root.render(createElement(Harness)));

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea not found');

    let scrollHeightReads = 0;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads++;
        return 40;
      },
    });

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'x' }),
      );
    });
    expect(scrollHeightReads).toBe(0);

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setValue?.call(textarea, 'x');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    expect(scrollHeightReads).toBe(1);
  });

  it('batches completion dismissal with handled Enter submission', async () => {
    inlineCompletionMock.initialCompletion = ' suggested text';
    await act(async () => root.render(createElement(SubmittingHarness)));

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea not found');

    let scrollHeightReads = 0;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads++;
        return 40;
      },
    });

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
      );
    });

    expect(textarea.value).toBe('');
    expect(scrollHeightReads).toBe(1);
  });

  it('opens feature autocomplete from prepared features alone', async () => {
    await act(async () => root.render(createElement(PreparedFeaturesHarness)));

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea not found');

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setValue?.call(textarea, '#');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });

    expect(document.querySelector('button[data-index="0"]')).not.toBeNull();
  });

  it('measures textarea height once after Option+Enter', async () => {
    await act(async () => root.render(createElement(Harness)));

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea not found');

    let scrollHeightReads = 0;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads++;
        return 40;
      },
    });

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          altKey: true,
          bubbles: true,
          key: 'Enter',
        }),
      );
    });

    expect(scrollHeightReads).toBe(1);
  });

  it('measures textarea height once after formatted paste', async () => {
    await act(async () => root.render(createElement(Harness)));

    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea not found');

    let scrollHeightReads = 0;
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => {
        scrollHeightReads++;
        return 40;
      },
    });
    const pasteEvent = new Event('paste', { bubbles: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => 'Pasted prompt', items: [] },
    });

    await act(async () => textarea.dispatchEvent(pasteEvent));

    expect(scrollHeightReads).toBe(1);
  });
});
