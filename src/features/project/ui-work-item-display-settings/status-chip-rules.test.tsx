// @vitest-environment happy-dom

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { CORE_FIELD_METADATA } from '@shared/work-item-field-types';
import { StatusChipRules } from './status-chip-rules';
import { RootOverlay } from '@/common/context/overlay';
import type { AzureDevOpsBoardColumn } from '@/lib/api';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe('StatusChipRules', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  function render(
    rules: Parameters<typeof StatusChipRules>[0]['rules'] = [],
    boardColumns: AzureDevOpsBoardColumn[] = [],
  ) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onChange = vi.fn();
    act(() =>
      root.render(
        <RootOverlay>
          <StatusChipRules
            rules={rules}
            metadataMap={CORE_FIELD_METADATA}
            boardColumns={boardColumns}
            onChange={onChange}
          />
        </RootOverlay>,
      ),
    );
    return onChange;
  }

  it('shows the empty state and adds a blocked rule', () => {
    const onChange = render();
    expect(container.textContent).toContain('No status chips configured.');
    act(() =>
      (container.querySelector('button[aria-label="Add rule"]') as HTMLButtonElement).click(),
    );
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        field: 'System.State',
        values: ['Blocked'],
        label: 'Blocked',
        tone: 'warning',
        enabled: true,
      }),
    ]);
  });

  it('edits, disables, reorders, and removes a rule', () => {
    const onChange = render([
      {
        id: 'blocked',
        field: 'System.State',
        values: ['Blocked'],
        label: 'Blocked',
        tone: 'warning',
        enabled: true,
      },
      {
        id: 'severity',
        field: 'Custom.Severity',
        values: ['High'],
        label: 'High severity',
        tone: 'danger',
        enabled: true,
      },
    ]);
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      toggle.click();
    });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'blocked', enabled: false }),
      expect.objectContaining({ id: 'severity' }),
    ]);
    act(() => {
      (container.querySelector('button[aria-label="Move High severity up"]') as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'severity' }),
      expect.objectContaining({ id: 'blocked' }),
    ]);
    act(() => {
      (container.querySelector('button[aria-label="Remove High severity"]') as HTMLButtonElement).click();
    });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'blocked' }),
    ]);
  });

  it('allows option-based values to be removed', () => {
    const onChange = render(
      [
        {
          id: 'state',
          field: 'System.State',
          values: ['Blocked', 'Active'],
          label: 'Blocked',
          tone: 'warning',
          enabled: true,
        },
      ],
      [
        {
          id: 'board-column-1',
          name: 'Blocked',
          stateMappings: { Blocked: 'Blocked' },
        },
      ],
    );

    act(() =>
      (container.querySelector('button[aria-label="Remove value 2 for Blocked"]') as HTMLButtonElement).click(),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ values: ['Blocked'] }),
    ]);
  });
});
