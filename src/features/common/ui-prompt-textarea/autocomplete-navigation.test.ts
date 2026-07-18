// @vitest-environment happy-dom

import { act, createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import type { ProjectFeatureMap } from '@shared/types';

import { PromptTextarea } from './index';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

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

describe('PromptTextarea autocomplete navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
});
