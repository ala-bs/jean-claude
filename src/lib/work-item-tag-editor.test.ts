/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { RootOverlay } from '@/common/context/overlay';

import { WorkItemTagEditor } from '@/features/work-item/ui-work-item-tag-editor';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function renderEditor({
  value = '',
  suggestions = [],
  onSave = vi.fn(async () => undefined),
}: {
  value?: string;
  suggestions?: string[];
  onSave?: (value: string) => Promise<unknown>;
} = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        RootOverlay,
        null,
        createElement(WorkItemTagEditor, { value, suggestions, onSave }),
      ),
    );
  });
  return { onSave };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

describe('WorkItemTagEditor', () => {
  it('adds an existing tag from autocomplete with Enter', async () => {
    const onSave = vi.fn(async () => undefined);
    renderEditor({ suggestions: ['Frontend', 'Backend'], onSave });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')!;

    await act(async () => {
      input.focus();
      setInputValue(input, 'front');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledWith('Frontend');
    expect(container?.textContent).toContain('Frontend');
  });

  it('removes one chip and saves remaining tags', async () => {
    const onSave = vi.fn(async () => undefined);
    renderEditor({ value: 'Frontend; Urgent', onSave });
    const removeButton = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Frontend tag"]',
    )!;

    await act(async () => {
      removeButton.click();
    });

    expect(onSave).toHaveBeenCalledWith('Urgent');
    expect(container?.textContent).not.toContain('Frontend');
    expect(container?.textContent).toContain('Urgent');
  });

  it('splits pasted tags and deduplicates them case-insensitively', async () => {
    const onSave = vi.fn(async () => undefined);
    renderEditor({ value: 'Frontend', onSave });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')!;

    await act(async () => {
      setInputValue(input, 'frontend; Urgent');
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onSave).toHaveBeenCalledWith('Frontend; Urgent');
  });

  it('rolls chips back when saving fails', async () => {
    const onSave = vi.fn(async () => Promise.reject(new Error('Save failed')));
    renderEditor({ suggestions: ['Frontend'], onSave });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')!;

    await act(async () => {
      input.focus();
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(container?.textContent).not.toContain('Frontend');
    expect(container?.textContent).toContain('Save failed');
  });

  it('preserves custom tag input when saving fails', async () => {
    const onSave = vi.fn(async () => Promise.reject(new Error('Save failed')));
    renderEditor({ onSave });
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Add tag"]')!;

    await act(async () => {
      setInputValue(input, 'Needs review');
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(input.value).toBe('Needs review');
  });
});
