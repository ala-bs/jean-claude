// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { ReactNode } from 'react';

const updateFieldMutate = vi.fn();
const updateStateMutate = vi.fn();

vi.mock('@/hooks/use-work-items', () => ({
  useUpdateWorkItemField: () => ({
    mutate: updateFieldMutate,
    mutateAsync: updateFieldMutate,
    isPending: false,
  }),
  useUpdateWorkItemState: () => ({
    mutate: updateStateMutate,
    mutateAsync: updateStateMutate,
    isPending: false,
  }),
}));

vi.mock('@/common/ui/dropdown', () => ({
  Dropdown: ({
    trigger,
    children,
  }: {
    trigger: ReactNode | ((props: Record<string, unknown>) => ReactNode);
    children: ReactNode;
  }) => (
    <div>
      {typeof trigger === 'function' ? trigger({}) : trigger}
      <div data-testid="dropdown-items">{children}</div>
    </div>
  ),
  DropdownItem: ({
    children,
    onClick,
    checked,
  }: {
    children: ReactNode;
    onClick?: () => void;
    checked?: boolean;
  }) => (
    <button
      type="button"
      data-testid="dropdown-item"
      data-checked={checked ? 'true' : 'false'}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}));

import { WorkItemIterationEditor } from './work-item-iteration-editor';
import { WorkItemMetadataValue } from './work-item-metadata-value';
import { WorkItemStateEditor } from './work-item-state-editor';
import {
  WorkItemOwnerEditor,
  getOwnerOptions,
} from './work-item-owner-editor';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  updateFieldMutate.mockReset();
  updateStateMutate.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function items() {
  return Array.from(
    container
      .querySelector('[data-testid="dropdown-items"]')
      ?.querySelectorAll<HTMLButtonElement>('[data-testid="dropdown-item"]') ??
      [],
  );
}

describe('WorkItemOwnerEditor', () => {
  it('lists Unassigned first and saves the uniqueName value', () => {
    const options = getOwnerOptions(
      [
        { displayName: 'Ada Lovelace', value: 'ada@example.com' },
        { displayName: 'Bob Stone', value: 'bob@example.com' },
      ],
      'Bob Stone',
      'bob@example.com',
    );
    act(() => {
      root.render(
        <WorkItemOwnerEditor
          owner="Bob Stone"
          ownerValue="bob@example.com"
          options={options}
          disabled={false}
          error={null}
          onRetry={() => {}}
          providerId="p1"
          workItemId={42}
        />,
      );
    });

    const rendered = items();
    expect(rendered[0]?.textContent).toContain('Unassigned');
    const ada = rendered.find((item) =>
      item.textContent?.includes('Ada Lovelace'),
    );
    act(() => ada?.click());
    expect(updateFieldMutate).toHaveBeenCalledWith({
      providerId: 'p1',
      workItemId: 42,
      field: 'System.AssignedTo',
      // Disambiguated form: a bare email can match several Azure identities.
      value: 'Ada Lovelace <ada@example.com>',
    });
  });

  it('does not render an "Assigned to:" label', () => {
    act(() => {
      root.render(
        <WorkItemOwnerEditor
          owner="Bob Stone"
          ownerValue="bob@example.com"
          options={getOwnerOptions([], 'Bob Stone', 'bob@example.com')}
          disabled={false}
          error={null}
          onRetry={() => {}}
          providerId="p1"
          workItemId={42}
        />,
      );
    });
    expect(container.textContent).not.toContain('Assigned to:');
    expect(
      container.querySelector('[aria-label^="Edit owner"]'),
    ).not.toBeNull();
  });
});

describe('WorkItemStateEditor', () => {
  it('renders the state chip and saves through updateWorkItemState', () => {
    act(() => {
      root.render(
        <WorkItemStateEditor
          state="Active"
          states={['New', 'Active', 'Closed']}
          providerId="p1"
          workItemId={7}
        />,
      );
    });
    expect(container.textContent).toContain('Active');
    const closed = items().find((item) => item.textContent === 'Closed');
    act(() => closed?.click());
    expect(updateStateMutate).toHaveBeenCalledWith({
      providerId: 'p1',
      workItemId: 7,
      state: 'Closed',
    });
  });

  it('falls back to a read-only badge without a providerId', () => {
    act(() => {
      root.render(
        <WorkItemStateEditor state="New" states={['New', 'Active']} workItemId={7} />,
      );
    });
    expect(container.textContent).toContain('New');
    expect(container.querySelector('[data-testid="dropdown-items"]')).toBeNull();
  });
});

describe('WorkItemIterationEditor', () => {
  it('renders even when the work item has no iteration', () => {
    act(() => {
      root.render(
        <WorkItemIterationEditor
          options={[
            { name: 'Sprint 3', path: 'Proj\\Sprint 3', isCurrent: true },
          ]}
          disabled={false}
          providerId="p1"
          workItemId={9}
        />,
      );
    });
    const trigger = container.querySelector('[aria-label^="Edit iteration"]');
    expect(trigger).not.toBeNull();
    const option = items()[0];
    expect(option?.textContent).toContain('Sprint 3');
    expect(option?.textContent).toContain('Current');
    act(() => option?.click());
    expect(updateFieldMutate).toHaveBeenCalledWith({
      providerId: 'p1',
      workItemId: 9,
      field: 'System.IterationPath',
      value: 'Proj\\Sprint 3',
    });
  });
});

describe('WorkItemMetadataValue', () => {
  function renderValue(onSave: (value: string) => Promise<unknown>) {
    act(() => {
      root.render(
        <WorkItemMetadataValue
          value="3"
          label="Story points"
          validate={(next) =>
            Number.isFinite(Number(next)) ? null : 'Must be a number'
          }
          onSave={onSave}
        />,
      );
    });
    act(() => container.querySelector('button')?.click());
    return container.querySelector('input') as HTMLInputElement;
  }

  async function type(input: HTMLInputElement, next: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('rejects an invalid value without saving', async () => {
    const onSave = vi.fn(async () => undefined);
    const input = renderValue(onSave);
    await type(input, 'abc');
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Must be a number',
    );
  });

  it('cancels the edit on Escape without saving', async () => {
    const onSave = vi.fn(async () => undefined);
    const input = renderValue(onSave);
    await type(input, '8');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).toContain('3');
  });
});
