// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { CommandRow } from '@/features/project/ui-run-commands-config/command-row';
import type { ProjectCommand } from '@shared/run-command-types';
import { RootKeyboardBindings } from '@/common/context/keyboard-bindings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const command: ProjectCommand = {
  id: 'cmd-1',
  projectId: 'project-1',
  name: 'Dev server',
  command: 'pnpm dev',
  ports: [],
  portConflictStrategy: 'prompt',
  portOverrideProvider: 'env',
  portOverrideEnvVar: null,
  portOverrideArgs: null,
  envVars: [],
  confirmBeforeRun: false,
  confirmMessage: null,
  isFavorite: false,
  isHidden: false,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;
const onDelete = vi.fn();

function render({
  overrides,
  onUpdate = vi.fn(),
}: {
  overrides?: Partial<ProjectCommand>;
  onUpdate?: (data: Partial<ProjectCommand>) => void;
} = {}) {
  act(() => {
    root.render(
      <RootKeyboardBindings>
        <CommandRow
          sortableId="command:cmd-1"
          command={{ ...command, ...overrides }}
          suggestions={[]}
          onDraftChange={vi.fn()}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      </RootKeyboardBindings>,
    );
  });
}

function queryByText(text: string) {
  return [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim().startsWith(text),
  );
}

beforeEach(() => {
  onDelete.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CommandRow visibility toggle', () => {
  it('hides a visible command', () => {
    const onUpdate = vi.fn();
    render({ onUpdate });

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Hide command"]')
        ?.click(),
    );

    expect(onUpdate).toHaveBeenCalledWith({ isHidden: true });
  });

  it('shows a hidden command and dims its row', () => {
    const onUpdate = vi.fn();
    render({ overrides: { isHidden: true }, onUpdate });

    const row = container.querySelector('[data-hidden-command="true"]');
    expect(row?.className).toContain('opacity-55');

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Show command"]')
        ?.click(),
    );

    expect(onUpdate).toHaveBeenCalledWith({ isHidden: false });
  });
});

describe('CommandRow delete confirmation', () => {
  it('does not delete immediately when the trash button is clicked', () => {
    render();

    const trashButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete command"], [title="Delete command"]',
    );
    expect(trashButton).toBeTruthy();

    act(() => trashButton?.click());

    expect(onDelete).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'Are you sure you want to delete',
    );
  });

  it('deletes only after confirming in the dialog', () => {
    render();

    const trashButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete command"], [title="Delete command"]',
    );
    act(() => trashButton?.click());
    act(() => queryByText('Delete')?.click());

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not delete when the dialog is cancelled', () => {
    render();

    const trashButton = document.querySelector<HTMLButtonElement>(
      '[aria-label="Delete command"], [title="Delete command"]',
    );
    act(() => trashButton?.click());
    act(() => queryByText('Cancel')?.click());

    expect(onDelete).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      'Are you sure you want to delete',
    );
  });
});
